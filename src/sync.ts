import PQueue from "p-queue";
import type {
  ConflictActionType,
  DecisionTypeForMixedEntity,
  Entity,
  MixedEntity,
  RemotelySavePluginSettings,
  SUPPORTED_SERVICES_TYPE,
  SyncPlanType,
  SyncTriggerSourceType,
} from "./baseTypes";
import { copyFile, copyFileOrFolder } from "./copyLogic";
import type { FakeFs } from "./fsAll";
import type { FakeFsEncrypt } from "./fsEncrypt";
import {
  type InternalDBs,
  clearPrevSyncRecordByVaultAndProfile,
  getAllPrevSyncRecordsByVaultAndProfile,
  insertSyncPlanRecordByVault,
  upsertPrevSyncRecordByVaultAndProfile,
} from "./localdb";
import {
  atWhichLevel,
  getSha1,
  isHiddenPath,
  isSpecialFolderNameToSkip,
  unixTimeToStr,
} from "./misc";
import type { Profiler } from "./profiler";

/**
 * Clean-room Apache reimplementation of the V3 bidirectional sync engine,
 * built from docs/sync_algorithm/v3/design.md and the decision vocabulary in
 * src/baseTypes.ts. Scope (by design): bidirectional only; conflict actions
 * keep_newer / keep_larger / keep_both (no PRO smart-merge, no PRO license
 * gate, no incremental directions). See the plan/design doc for the rationale.
 */

// services that store mtime at one-second granularity; normalize so that a
// remote-side rounding doesn't look like a real modification.
const SECOND_GRANULARITY_SERVICES = new Set<string>(["s3", "dropbox"]);

const copyEntityAndFixTimeFormat = (
  src: Entity,
  serviceType: SUPPORTED_SERVICES_TYPE
): Entity => {
  const e: Entity = { ...src };
  if (SECOND_GRANULARITY_SERVICES.has(serviceType)) {
    if (e.mtimeCli !== undefined) {
      e.mtimeCli = Math.floor(e.mtimeCli / 1000) * 1000;
    }
    if (e.mtimeSvr !== undefined) {
      e.mtimeSvr = Math.floor(e.mtimeSvr / 1000) * 1000;
    }
    if (e.ctimeCli !== undefined) {
      e.ctimeCli = Math.floor(e.ctimeCli / 1000) * 1000;
    }
  }
  if (e.mtimeCli !== undefined) {
    e.mtimeCliFmt = unixTimeToStr(e.mtimeCli);
  }
  if (e.mtimeSvr !== undefined) {
    e.mtimeSvrFmt = unixTimeToStr(e.mtimeSvr);
  }
  if (e.ctimeCli !== undefined) {
    e.ctimeCliFmt = unixTimeToStr(e.ctimeCli);
  }
  if (e.prevSyncTime !== undefined) {
    e.prevSyncTimeFmt = unixTimeToStr(e.prevSyncTime);
  }
  return e;
};

/**
 * "note.md" -> "note (conflict 2026-06-26).md"; "foo" -> "foo (conflict 2026-06-26)".
 * The date is passed in so callers stay testable.
 */
export const getConflictCopyName = (key: string, dateStr: string): string => {
  if (key.endsWith("/")) {
    throw new Error(`cannot make a conflict copy name for a folder: ${key}`);
  }
  const slashIdx = key.lastIndexOf("/");
  const dotIdx = key.lastIndexOf(".");
  if (dotIdx > slashIdx + 1 && dotIdx !== -1) {
    return `${key.slice(0, dotIdx)} (conflict ${dateStr})${key.slice(dotIdx)}`;
  }
  return `${key} (conflict ${dateStr})`;
};

/**
 * Whether a key should be skipped, mirroring the existing free-version rules
 * (config dir + bookmarks, underscore items, special folders, ignore/allow
 * regex lists). Reuses the Apache misc helpers.
 */
export const checkIsSkipItemOrNotByName = (
  key: string,
  configDir: string,
  syncConfigDir: boolean,
  syncBookmarks: boolean,
  syncUnderscoreItems: boolean,
  ignorePaths: string[],
  onlyAllowPaths: string[]
): boolean => {
  if (key === undefined || key === "" || key === "/") {
    return true;
  }

  // config dir (e.g. .obsidian)
  if (
    key === configDir ||
    key === `${configDir}/` ||
    key.startsWith(`${configDir}/`)
  ) {
    const isBookmarks = key === `${configDir}/bookmarks.json`;
    if (isBookmarks) {
      if (!syncBookmarks) {
        return true;
      }
    } else if (!syncConfigDir) {
      return true;
    }
  }

  // underscore-prefixed items (any path segment starting with "_")
  if (!syncUnderscoreItems && isHiddenPath(key, false, true)) {
    return true;
  }

  // .git, node_modules, .DS_Store, MS temp ~$..., etc.
  if (isSpecialFolderNameToSkip(key, [])) {
    return true;
  }

  // deny list
  for (const p of ignorePaths) {
    if (p !== "" && new RegExp(p).test(key)) {
      return true;
    }
  }

  // allow list: if non-empty, the key must match at least one entry
  const allow = onlyAllowPaths.filter((x) => x !== "" && x !== "\n");
  if (allow.length > 0) {
    let matched = false;
    for (const p of allow) {
      if (new RegExp(p).test(key)) {
        matched = true;
        break;
      }
    }
    if (!matched) {
      return true;
    }
  }

  return false;
};

type SideState = "unchanged" | "modified" | "created" | "deleted";

/**
 * Classify the remote side relative to the previous-sync snapshot. Remote only
 * exposes mtimeSvr / sizeEnc (we can't hash the remote without downloading).
 */
export const classifyRemote = (
  remote: Entity | undefined,
  prevSync: Entity | undefined
): SideState => {
  if (remote === undefined) {
    return "deleted"; // absent now (paired with the other side's presence)
  }
  if (prevSync === undefined) {
    return "created";
  }
  const sameMtime = remote.mtimeSvr === prevSync.mtimeSvr;
  const sameSize = remote.sizeEnc === prevSync.sizeEnc;
  return sameMtime && sameSize ? "unchanged" : "modified";
};

/**
 * Classify the local side. When mtime/size differ from the snapshot we CONFIRM
 * with a plaintext content hash: if it matches prevSync.hash the change was
 * spurious (e.g. Dropbox bumped the mtime) and the file is really unchanged.
 * The hash read happens only for already-suspect files.
 */
export const classifyLocal = async (
  local: Entity | undefined,
  prevSync: Entity | undefined,
  key: string,
  fsLocal: FakeFs
): Promise<SideState> => {
  if (local === undefined) {
    return "deleted";
  }
  if (prevSync === undefined) {
    return "created";
  }
  const sameMtime = local.mtimeCli === prevSync.mtimeCli;
  const sameSize = local.sizeEnc === prevSync.sizeEnc;
  if (sameMtime && sameSize) {
    return "unchanged";
  }
  // suspected change: confirm via content hash when we have a baseline hash
  if (prevSync.hash !== undefined) {
    try {
      const content = await fsLocal.readFile(key);
      const hash = await getSha1(content, "hex");
      if (hash === prevSync.hash) {
        return "unchanged";
      }
    } catch (e) {
      // if we can't read/hash, fall through and treat as modified (safe)
    }
  }
  return "modified";
};

const normalizeConflictAction = (
  a: ConflictActionType | undefined
): ConflictActionType => {
  // smart_conflict (PRO markdown merge) is not available in this engine; the
  // safest fallback is keep_both (never lose either side).
  if (a === "smart_conflict" || a === undefined) {
    return "keep_both";
  }
  return a;
};

/**
 * Resolve a true two-sided conflict into a concrete decision per the chosen
 * policy. `kind` selects the conflict_created_* vs conflict_modified_* family.
 */
const resolveConflict = (
  m: MixedEntity,
  kind: "created" | "modified",
  conflictAction: ConflictActionType
): DecisionTypeForMixedEntity => {
  if (conflictAction === "keep_both") {
    return kind === "created"
      ? "conflict_created_then_keep_both"
      : "conflict_modified_then_keep_both";
  }
  if (conflictAction === "keep_larger") {
    const localLarger = (m.local?.sizeEnc ?? -1) >= (m.remote?.sizeEnc ?? -1);
    if (localLarger) {
      return kind === "created"
        ? "conflict_created_then_keep_local"
        : "conflict_modified_then_keep_local";
    }
    return kind === "created"
      ? "conflict_created_then_keep_remote"
      : "conflict_modified_then_keep_remote";
  }
  // keep_newer (default fallback)
  const localNewer = (m.local?.mtimeCli ?? -1) >= (m.remote?.mtimeSvr ?? -1);
  if (localNewer) {
    return kind === "created"
      ? "conflict_created_then_keep_local"
      : "conflict_modified_then_keep_local";
  }
  return kind === "created"
    ? "conflict_created_then_keep_remote"
    : "conflict_modified_then_keep_remote";
};

export const assignFileDecisionInplace = (
  m: MixedEntity,
  localState: SideState,
  remoteState: SideState,
  conflictAction: ConflictActionType
) => {
  m.conflictAction = conflictAction;
  const conflictKind: "created" | "modified" =
    m.prevSync === undefined ? "created" : "modified";
  const setD = (
    decision: DecisionTypeForMixedEntity,
    branch: number,
    change: boolean
  ) => {
    m.decision = decision;
    m.decisionBranch = branch;
    m.change = change;
  };

  // The bidirectional decision table from docs/sync_algorithm/v3/design.md.
  // Rows = local state, columns = remote state.
  switch (`${localState}/${remoteState}`) {
    case "unchanged/unchanged":
      return setD("equal", 21, false);
    case "unchanged/modified":
      return setD("remote_is_modified_then_pull", 9, true);
    case "unchanged/deleted":
      return setD("remote_is_deleted_thus_also_delete_local", 7, true);

    case "modified/unchanged":
      return setD("local_is_modified_then_push", 10, true);
    case "modified/deleted":
      return setD("local_is_modified_then_push", 8, true);
    case "modified/modified":
      return setD(resolveConflict(m, "modified", conflictAction), 16, true);

    case "deleted/unchanged":
      return setD("local_is_deleted_thus_also_delete_remote", 4, true);
    case "deleted/modified":
      return setD("remote_is_modified_then_pull", 5, true);
    case "deleted/deleted":
      return setD("only_history", 1, false);
    case "deleted/created":
      return setD("remote_is_created_then_pull", 3, true);

    case "created/deleted":
      return setD("local_is_created_then_push", 6, true);
    case "created/created":
      return setD(resolveConflict(m, "created", conflictAction), 11, true);

    // The remaining cells are the "(??)" contradictory states in the doc
    // (e.g. one side "created" with no prevSync while the other is
    // "unchanged"/"modified"). They are genuine conflicts; resolve them by the
    // chosen policy rather than guessing a winner. This includes:
    //   unchanged/created, modified/created, created/unchanged, created/modified
    default:
      return setD(resolveConflict(m, conflictKind, conflictAction), 16, true);
  }
};

const assignFolderDecisionInplace = (m: MixedEntity) => {
  const localPresent = m.local !== undefined;
  const remotePresent = m.remote !== undefined;
  const hadBefore = m.prevSync !== undefined;
  const setD = (
    decision: DecisionTypeForMixedEntity,
    branch: number,
    change: boolean
  ) => {
    m.decision = decision;
    m.decisionBranch = branch;
    m.change = change;
  };

  if (localPresent && remotePresent) {
    return setD("folder_existed_both_then_do_nothing", 100, false);
  }
  if (localPresent && !remotePresent) {
    return hadBefore
      ? setD("folder_to_be_deleted_on_local", 103, true) // remote removed it
      : setD("folder_existed_local_then_also_create_remote", 101, true);
  }
  if (!localPresent && remotePresent) {
    return hadBefore
      ? setD("folder_to_be_deleted_on_remote", 104, true) // local removed it
      : setD("folder_existed_remote_then_also_create_local", 102, true);
  }
  // absent both, but in history -> deleted on both
  return setD("folder_to_be_deleted_on_both", 105, true);
};

/**
 * Build the MixedEntity map by reconciling the three sources (remote, previous
 * sync, local). Local/prevSync entities are run through encryptEntity so their
 * sizeEnc is comparable with the remote's encrypted size.
 */
export const ensembleMixedEntities = async (
  localEntityList: Entity[],
  prevSyncEntityList: Entity[],
  remoteEntityList: Entity[],
  settings: RemotelySavePluginSettings,
  configDir: string,
  fsEncrypt: FakeFsEncrypt,
  serviceType: SUPPORTED_SERVICES_TYPE
): Promise<SyncPlanType> => {
  const syncConfigDir = settings.syncConfigDir ?? false;
  const syncBookmarks = settings.syncBookmarks ?? false;
  const syncUnderscoreItems = settings.syncUnderscoreItems ?? false;
  const ignorePaths = settings.ignorePaths ?? [];
  const onlyAllowPaths = settings.onlyAllowPaths ?? [];

  const skipCache: Record<string, boolean> = {};
  const isSkip = (key: string) => {
    if (!(key in skipCache)) {
      skipCache[key] = checkIsSkipItemOrNotByName(
        key,
        configDir,
        syncConfigDir,
        syncBookmarks,
        syncUnderscoreItems,
        ignorePaths,
        onlyAllowPaths
      );
    }
    return skipCache[key];
  };

  const finalMappings: SyncPlanType = {};

  for (const remote of remoteEntityList) {
    const r = copyEntityAndFixTimeFormat(remote, serviceType);
    const key = r.key!;
    if (isSkip(key)) {
      continue;
    }
    finalMappings[key] = { key, remote: r };
  }

  for (const prevSync of prevSyncEntityList) {
    const key = prevSync.key!;
    if (isSkip(key)) {
      continue;
    }
    const p = copyEntityAndFixTimeFormat(prevSync, serviceType);
    if (finalMappings[key] !== undefined) {
      finalMappings[key].prevSync = p;
    } else {
      finalMappings[key] = { key, prevSync: p };
    }
  }

  for (const local of localEntityList) {
    const key = local.key!;
    if (isSkip(key)) {
      continue;
    }
    const l = await fsEncrypt.encryptEntity(
      copyEntityAndFixTimeFormat(local, serviceType)
    );
    if (finalMappings[key] !== undefined) {
      finalMappings[key].local = l;
    } else {
      finalMappings[key] = { key, local: l };
    }
  }

  return finalMappings;
};

/**
 * Assign decisions to every MixedEntity per the bidirectional table. Throws on
 * any non-bidirectional direction (intentionally unsupported in this engine).
 */
export const getSyncPlanInplace = async (
  mixedEntityMappings: SyncPlanType,
  fsLocal: FakeFs,
  settings: RemotelySavePluginSettings
) => {
  const direction = settings.syncDirection ?? "bidirectional";
  if (direction !== "bidirectional") {
    throw new Error(
      `the free sync engine only supports "bidirectional"; ` +
        `"${direction}" is not implemented`
    );
  }
  const conflictAction = normalizeConflictAction(settings.conflictAction);

  for (const key of Object.keys(mixedEntityMappings)) {
    const m = mixedEntityMappings[key];
    if (key.endsWith("/")) {
      assignFolderDecisionInplace(m);
      continue;
    }
    const localState = await classifyLocal(m.local, m.prevSync, key, fsLocal);
    const remoteState = classifyRemote(m.remote, m.prevSync);
    assignFileDecisionInplace(m, localState, remoteState, conflictAction);
  }
};

// decisions that overwrite or delete existing content (for the protect guard)
const DESTRUCTIVE_DECISIONS = new Set<DecisionTypeForMixedEntity>([
  "local_is_modified_then_push",
  "remote_is_modified_then_pull",
  "local_is_deleted_thus_also_delete_remote",
  "remote_is_deleted_thus_also_delete_local",
  "conflict_created_then_keep_local",
  "conflict_created_then_keep_remote",
  "conflict_created_then_keep_both",
  "conflict_modified_then_keep_local",
  "conflict_modified_then_keep_remote",
  "conflict_modified_then_keep_both",
  "folder_to_be_deleted_on_both",
  "folder_to_be_deleted_on_remote",
  "folder_to_be_deleted_on_local",
]);

const recordPrevSync = async (
  db: InternalDBs,
  vaultRandomID: string,
  profileID: string,
  key: string,
  fields: {
    mtimeCli?: number;
    mtimeSvr?: number;
    sizeEnc?: number;
    size?: number;
    content?: ArrayBuffer;
  },
  serviceType: SUPPORTED_SERVICES_TYPE
) => {
  const hash =
    fields.content !== undefined
      ? await getSha1(fields.content, "hex")
      : undefined;
  const e: Entity = copyEntityAndFixTimeFormat(
    {
      key,
      keyRaw: key,
      mtimeCli: fields.mtimeCli,
      mtimeSvr: fields.mtimeSvr,
      sizeEnc: fields.sizeEnc,
      size: fields.size,
      sizeRaw: fields.size ?? 0,
      hash,
    },
    serviceType
  );
  await upsertPrevSyncRecordByVaultAndProfile(db, vaultRandomID, profileID, e);
};

/**
 * Execute one MixedEntity's decision against the real filesystems.
 */
const dispatchOperation = async (
  m: MixedEntity,
  fsLocal: FakeFs,
  fsEncrypt: FakeFsEncrypt,
  db: InternalDBs,
  vaultRandomID: string,
  profileID: string,
  serviceType: SUPPORTED_SERVICES_TYPE,
  dateStr: string
) => {
  const key = m.key;
  const decision = m.decision;

  switch (decision) {
    case "equal":
    case "folder_existed_both_then_do_nothing":
      return; // already in sync

    case "only_history":
      await clearPrevSyncRecordByVaultAndProfile(
        db,
        vaultRandomID,
        profileID,
        key
      );
      return;

    case "local_is_created_then_push":
    case "local_is_modified_then_push":
    case "conflict_created_then_keep_local":
    case "conflict_modified_then_keep_local": {
      const { entity, content } = await copyFileOrFolder(
        key,
        fsLocal,
        fsEncrypt
      );
      await recordPrevSync(
        db,
        vaultRandomID,
        profileID,
        key,
        {
          mtimeCli: m.local?.mtimeCli,
          mtimeSvr: entity.mtimeSvr ?? entity.mtimeCli,
          sizeEnc: entity.sizeEnc,
          size: m.local?.size,
          content,
        },
        serviceType
      );
      return;
    }

    case "remote_is_created_then_pull":
    case "remote_is_modified_then_pull":
    case "conflict_created_then_keep_remote":
    case "conflict_modified_then_keep_remote": {
      const { entity, content } = await copyFileOrFolder(
        key,
        fsEncrypt,
        fsLocal
      );
      await recordPrevSync(
        db,
        vaultRandomID,
        profileID,
        key,
        {
          mtimeCli: entity.mtimeCli,
          mtimeSvr: m.remote?.mtimeSvr,
          sizeEnc: m.remote?.sizeEnc,
          size: m.remote?.size,
          content,
        },
        serviceType
      );
      return;
    }

    case "local_is_deleted_thus_also_delete_remote":
      await fsEncrypt.rm(key);
      await clearPrevSyncRecordByVaultAndProfile(
        db,
        vaultRandomID,
        profileID,
        key
      );
      return;

    case "remote_is_deleted_thus_also_delete_local":
      await fsLocal.rm(key);
      await clearPrevSyncRecordByVaultAndProfile(
        db,
        vaultRandomID,
        profileID,
        key
      );
      return;

    case "conflict_created_then_keep_both":
    case "conflict_modified_then_keep_both": {
      // Keep both versions: local keeps the original name; the remote version
      // is downloaded alongside as a conflict copy, and both files are pushed
      // so every device converges to the same two files (no overwrite).
      const conflictKey = getConflictCopyName(key, dateStr);
      const remoteContent = await fsEncrypt.readFile(key);
      const mtime = m.remote?.mtimeSvr ?? m.local?.mtimeCli ?? 0;
      const localConflictEntity = await fsLocal.writeFile(
        conflictKey,
        remoteContent,
        mtime,
        mtime
      );
      // push local original (overwrites remote with the local version)
      const pushOrig = await copyFile(key, fsLocal, fsEncrypt);
      // push the conflict copy (the former remote version) to the remote
      const pushConflict = await copyFile(conflictKey, fsLocal, fsEncrypt);

      await recordPrevSync(
        db,
        vaultRandomID,
        profileID,
        key,
        {
          mtimeCli: m.local?.mtimeCli,
          mtimeSvr: pushOrig.entity.mtimeSvr ?? pushOrig.entity.mtimeCli,
          sizeEnc: pushOrig.entity.sizeEnc,
          size: m.local?.size,
          content: pushOrig.content,
        },
        serviceType
      );
      await recordPrevSync(
        db,
        vaultRandomID,
        profileID,
        conflictKey,
        {
          mtimeCli: localConflictEntity.mtimeCli,
          mtimeSvr:
            pushConflict.entity.mtimeSvr ?? pushConflict.entity.mtimeCli,
          sizeEnc: pushConflict.entity.sizeEnc,
          size: localConflictEntity.size,
          content: pushConflict.content,
        },
        serviceType
      );
      return;
    }

    case "folder_to_be_created":
    case "folder_existed_local_then_also_create_remote": {
      const { entity } = await copyFileOrFolder(key, fsLocal, fsEncrypt);
      await recordPrevSync(
        db,
        vaultRandomID,
        profileID,
        key,
        { mtimeCli: m.local?.mtimeCli, mtimeSvr: entity.mtimeSvr },
        serviceType
      );
      return;
    }

    case "folder_existed_remote_then_also_create_local": {
      const { entity } = await copyFileOrFolder(key, fsEncrypt, fsLocal);
      await recordPrevSync(
        db,
        vaultRandomID,
        profileID,
        key,
        { mtimeCli: entity.mtimeCli, mtimeSvr: m.remote?.mtimeSvr },
        serviceType
      );
      return;
    }

    case "folder_to_be_deleted_on_local":
      await fsLocal.rm(key);
      await clearPrevSyncRecordByVaultAndProfile(
        db,
        vaultRandomID,
        profileID,
        key
      );
      return;

    case "folder_to_be_deleted_on_remote":
      await fsEncrypt.rm(key);
      await clearPrevSyncRecordByVaultAndProfile(
        db,
        vaultRandomID,
        profileID,
        key
      );
      return;

    case "folder_to_be_deleted_on_both":
      await Promise.all([
        fsLocal.rm(key).catch(() => {}),
        fsEncrypt.rm(key).catch(() => {}),
      ]);
      await clearPrevSyncRecordByVaultAndProfile(
        db,
        vaultRandomID,
        profileID,
        key
      );
      return;

    default:
      // do_nothing / too_large / skip / unknown -> no-op
      return;
  }
};

/**
 * Execute the plan in three ordered phases: folder creations (parent->child),
 * file operations (concurrent, abortable), folder deletions (child->parent).
 */
export const doActualSync = async (
  mixedEntityMappings: SyncPlanType,
  fsLocal: FakeFs,
  fsEncrypt: FakeFsEncrypt,
  db: InternalDBs,
  vaultRandomID: string,
  profileID: string,
  settings: RemotelySavePluginSettings,
  getProtectModifyPercentageErrorStrFunc: any,
  serviceType: SUPPORTED_SERVICES_TYPE,
  triggerSource: SyncTriggerSourceType,
  callbackSyncProcess: any
) => {
  const all = Object.values(mixedEntityMappings);

  // protect-modify guard
  const allFilesCount = all.length;
  const realModifyDeleteCount = all.filter(
    (m) => m.decision !== undefined && DESTRUCTIVE_DECISIONS.has(m.decision)
  ).length;
  const pct = settings.protectModifyPercentage ?? 50;
  if (pct >= 0 && realModifyDeleteCount >= 0 && allFilesCount > 0) {
    const blocked =
      !(pct === 100 && realModifyDeleteCount === allFilesCount) &&
      realModifyDeleteCount * 100 >= allFilesCount * pct;
    if (blocked) {
      throw new Error(
        getProtectModifyPercentageErrorStrFunc(
          pct,
          realModifyDeleteCount,
          allFilesCount
        )
      );
    }
  }

  const dateStr = new Date().toISOString().slice(0, 10);
  const concurrency = settings.concurrency ?? 5;
  let realCounter = 0;
  const realTotalCount = all.filter((m) => m.change !== false).length;

  const folderCreate = all
    .filter(
      (m) =>
        m.decision === "folder_to_be_created" ||
        m.decision === "folder_existed_local_then_also_create_remote" ||
        m.decision === "folder_existed_remote_then_also_create_local"
    )
    .sort((a, b) => atWhichLevel(a.key) - atWhichLevel(b.key));

  const folderDelete = all
    .filter(
      (m) =>
        m.decision === "folder_to_be_deleted_on_both" ||
        m.decision === "folder_to_be_deleted_on_remote" ||
        m.decision === "folder_to_be_deleted_on_local"
    )
    .sort((a, b) => atWhichLevel(b.key) - atWhichLevel(a.key));

  const fileOps = all.filter((m) => !m.key.endsWith("/") && m.change !== false);

  const runOne = async (m: MixedEntity) => {
    await callbackSyncProcess?.(
      triggerSource,
      realCounter,
      realTotalCount,
      m.key,
      m.decision
    );
    if (m.change !== false) {
      realCounter += 1;
    }
    await dispatchOperation(
      m,
      fsLocal,
      fsEncrypt,
      db,
      vaultRandomID,
      profileID,
      serviceType,
      dateStr
    );
  };

  // phase 1: create folders parent-first (sequential to respect ordering)
  for (const m of folderCreate) {
    await runOne(m);
  }

  // phase 2: file operations, concurrent + abortable on too many errors
  const queue = new PQueue({ concurrency, autoStart: true });
  const errors: Error[] = [];
  const abortController = new AbortController();
  for (const m of fileOps) {
    queue
      .add(async () => {
        if (abortController.signal.aborted) {
          return;
        }
        await runOne(m);
      })
      .catch((e: any) => {
        errors.push(new Error(`${m.key}: ${e?.message ?? e}`));
        if (errors.length >= 3) {
          abortController.abort();
          queue.pause();
          queue.clear();
        }
      });
  }
  await queue.onIdle();
  if (errors.length > 0) {
    throw new AggregateError(errors);
  }

  // phase 3: delete folders child-first (sequential)
  for (const m of folderDelete) {
    await runOne(m);
  }
};

export type SyncStatusType =
  | "idle"
  | "preparing"
  | "getting_remote_files_list"
  | "getting_local_meta"
  | "getting_local_prev_sync"
  | "checking_password"
  | "generating_plan"
  | "syncing"
  | "finish";

/**
 * Orchestrate one sync run. Signature matches the call site in src/main.ts.
 * Returns whether the whole run succeeded so the caller can withhold a
 * success signal on failure.
 */
export async function syncer(
  fsLocal: FakeFs,
  fsRemote: FakeFs,
  fsEncrypt: FakeFsEncrypt,
  profiler: Profiler | undefined,
  db: InternalDBs,
  triggerSource: SyncTriggerSourceType,
  profileID: string,
  vaultRandomID: string,
  configDir: string,
  settings: RemotelySavePluginSettings,
  pluginVersion: string,
  configSaver: () => Promise<any>,
  getProtectModifyPercentageErrorStrFunc: any,
  markIsSyncingFunc: (isSyncing: boolean) => void,
  notifyFunc?: (s: SyncTriggerSourceType, step: number) => Promise<any>,
  errNotifyFunc?: (s: SyncTriggerSourceType, error: Error) => Promise<any>,
  ribboonFunc?: (s: SyncTriggerSourceType, step: number) => Promise<any>,
  statusBarFunc?: (
    s: SyncTriggerSourceType,
    step: number,
    everythingOk: boolean
  ) => any,
  callbackSyncProcess?: any
): Promise<boolean> {
  console.info(`starting sync (free engine, bidirectional).`);
  markIsSyncingFunc(true);

  let everythingOk = true;
  const serviceType = settings.serviceType;

  const emitStep = async (step: number) => {
    await notifyFunc?.(triggerSource, step);
    await ribboonFunc?.(triggerSource, step);
    await statusBarFunc?.(triggerSource, step, everythingOk);
  };

  try {
    profiler?.insert("sync: start");
    await emitStep(1);

    // step 2: remote listing (also builds the encryption cache map)
    await emitStep(2);
    const remoteEntityList = await fsEncrypt.walk();
    profiler?.insert("sync: got remote list");

    // step 3: local listing
    await emitStep(3);
    const localEntityList = await fsLocal.walk();
    profiler?.insert("sync: got local list");

    // step 4: previous-sync history
    await emitStep(4);
    const prevSyncEntityList = await getAllPrevSyncRecordsByVaultAndProfile(
      db,
      vaultRandomID,
      profileID
    );
    profiler?.insert("sync: got prev-sync list");

    // step 5: password / encryption sanity
    await emitStep(5);
    if (!fsEncrypt.isPasswordEmpty()) {
      const pw = await fsEncrypt.isPasswordOk();
      if (!pw.ok) {
        throw new Error(`encryption check failed: ${pw.reason}`);
      }
    }

    // step 6: build the plan
    await emitStep(6);
    const mixedEntityMappings = await ensembleMixedEntities(
      localEntityList,
      prevSyncEntityList,
      remoteEntityList,
      settings,
      configDir,
      fsEncrypt,
      serviceType
    );
    await getSyncPlanInplace(mixedEntityMappings, fsLocal, settings);
    await insertSyncPlanRecordByVault(
      db,
      mixedEntityMappings,
      vaultRandomID,
      serviceType
    );
    profiler?.insert("sync: plan ready");

    // step 7: execute (skipped for dry runs)
    await emitStep(7);
    if (triggerSource !== "dry") {
      await doActualSync(
        mixedEntityMappings,
        fsLocal,
        fsEncrypt,
        db,
        vaultRandomID,
        profileID,
        settings,
        getProtectModifyPercentageErrorStrFunc,
        serviceType,
        triggerSource,
        callbackSyncProcess
      );
      profiler?.insert("sync: actual sync done");
    }
  } catch (error: any) {
    everythingOk = false;
    await errNotifyFunc?.(triggerSource, error as Error);
    profiler?.insert("sync: error branch");
  }

  await profiler?.save(db, vaultRandomID, serviceType);

  // step 8: finish (statusBarFunc records last-success/last-failed time)
  await emitStep(8);

  console.info(`ending sync. everythingOk=${everythingOk}`);
  markIsSyncingFunc(false);
  return everythingOk;
}
