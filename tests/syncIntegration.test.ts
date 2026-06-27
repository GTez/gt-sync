import { strict as assert } from "assert";
import type { Entity, RemotelySavePluginSettings } from "../src/baseTypes";
import { FakeFs } from "../src/fsAll";
import { getAllPrevSyncRecordsByVaultAndProfile } from "../src/localdb";
import {
  doActualSync,
  ensembleMixedEntities,
  getSyncPlanInplace,
} from "../src/sync";

/**
 * End-to-end engine tests: drive the real reconciliation (ensembleMixedEntities
 * -> getSyncPlanInplace) and execution (doActualSync) against two in-memory
 * filesystems plus an in-memory DB. Encryption is out of scope here (covered by
 * the encrypt tests); the "remote" MemFs stands in for the encrypted backend and
 * provides a passthrough encryptEntity.
 */

const VID = "vault1";
const PID = "profile1";
const enc = (s: string) => new TextEncoder().encode(s).buffer;
const dec = (b: ArrayBuffer) => new TextDecoder().decode(b);

interface Stored {
  content: ArrayBuffer;
  mtime: number;
  ctime: number;
}

class MemFs extends FakeFs {
  kind = "mem";
  files = new Map<string, Stored>();
  folders = new Set<string>();

  seedFile(key: string, text: string, mtime = 1000) {
    this.files.set(key, { content: enc(text), mtime, ctime: mtime });
    // register parent folders
    const segs = key.split("/");
    for (let i = 1; i < segs.length; i++) {
      this.folders.add(`${segs.slice(0, i).join("/")}/`);
    }
  }

  async walk(): Promise<Entity[]> {
    const out: Entity[] = [];
    for (const f of this.folders) {
      out.push({
        key: f,
        keyRaw: f,
        mtimeCli: 1,
        mtimeSvr: 1,
        sizeRaw: 0,
        sizeEnc: 0,
      });
    }
    for (const [key, v] of this.files) {
      out.push({
        key,
        keyRaw: key,
        mtimeCli: v.mtime,
        mtimeSvr: v.mtime,
        ctimeCli: v.ctime,
        size: v.content.byteLength,
        sizeRaw: v.content.byteLength,
        sizeEnc: v.content.byteLength,
      });
    }
    return out;
  }
  async walkPartial(): Promise<Entity[]> {
    return this.walk();
  }
  async stat(key: string): Promise<Entity> {
    if (key.endsWith("/")) {
      return { key, keyRaw: key, mtimeCli: 1, sizeRaw: 0, sizeEnc: 0 };
    }
    const v = this.files.get(key)!;
    return {
      key,
      keyRaw: key,
      mtimeCli: v.mtime,
      mtimeSvr: v.mtime,
      ctimeCli: v.ctime,
      size: v.content.byteLength,
      sizeRaw: v.content.byteLength,
      sizeEnc: v.content.byteLength,
    };
  }
  async mkdir(key: string, mtime?: number): Promise<Entity> {
    this.folders.add(key);
    return { key, keyRaw: key, mtimeCli: mtime ?? 1, sizeRaw: 0, sizeEnc: 0 };
  }
  async writeFile(
    key: string,
    content: ArrayBuffer,
    mtime: number,
    ctime: number
  ): Promise<Entity> {
    this.files.set(key, { content, mtime, ctime });
    return {
      key,
      keyRaw: key,
      mtimeCli: mtime,
      mtimeSvr: mtime,
      ctimeCli: ctime,
      size: content.byteLength,
      sizeRaw: content.byteLength,
      sizeEnc: content.byteLength,
    };
  }
  async readFile(key: string): Promise<ArrayBuffer> {
    return this.files.get(key)!.content;
  }
  async rename(k1: string, k2: string): Promise<void> {
    const v = this.files.get(k1);
    if (v !== undefined) {
      this.files.set(k2, v);
      this.files.delete(k1);
    }
  }
  async rm(key: string): Promise<void> {
    this.files.delete(key);
    this.folders.delete(key);
  }
  async checkConnect(): Promise<boolean> {
    return true;
  }
  async getUserDisplayName(): Promise<string> {
    return "mem";
  }
  async revokeAuth(): Promise<any> {}
  allowEmptyFile(): boolean {
    return true;
  }
  // passthrough so MemFs can stand in for FakeFsEncrypt
  async encryptEntity(e: Entity): Promise<Entity> {
    return { ...e, keyEnc: e.key, sizeEnc: e.sizeEnc ?? e.sizeRaw };
  }
}

class MemTable {
  m = new Map<string, any>();
  async getItems() {
    const o: Record<string, any> = {};
    for (const [k, v] of this.m) o[k] = v;
    return o;
  }
  async setItem(k: string, v: any) {
    this.m.set(k, v);
    return v;
  }
  async getItem(k: string) {
    return this.m.has(k) ? this.m.get(k) : null;
  }
  async removeItem(k: string) {
    this.m.delete(k);
  }
}

const mockDB = () => ({ prevSyncRecordsTbl: new MemTable() }) as any;

const getProtectErr = (pct: number, cnt: number, total: number) =>
  `protect: ${cnt}/${total} would change, limit ${pct}%`;

const makeSettings = (
  o: Partial<RemotelySavePluginSettings> = {}
): RemotelySavePluginSettings =>
  ({
    serviceType: "dropbox",
    syncDirection: "bidirectional",
    conflictAction: "keep_both",
    // default guard off for the small test vaults; the dedicated protect test
    // overrides this to exercise the threshold.
    protectModifyPercentage: 100,
    concurrency: 5,
    syncConfigDir: false,
    syncBookmarks: false,
    syncUnderscoreItems: false,
    ignorePaths: [],
    onlyAllowPaths: [],
    password: "",
    ...o,
  }) as any;

async function syncOnce(
  localFs: MemFs,
  remoteFs: MemFs,
  db: any,
  settings: RemotelySavePluginSettings
) {
  const localList = await localFs.walk();
  const remoteList = await remoteFs.walk();
  const prev = await getAllPrevSyncRecordsByVaultAndProfile(db, VID, PID);
  const mapping = await ensembleMixedEntities(
    localList,
    prev,
    remoteList,
    settings,
    ".obsidian",
    remoteFs as any,
    "dropbox"
  );
  await getSyncPlanInplace(mapping, localFs as any, settings);
  await doActualSync(
    mapping,
    localFs as any,
    remoteFs as any,
    db,
    VID,
    PID,
    settings,
    getProtectErr,
    "dropbox",
    "manual",
    undefined
  );
  return mapping;
}

const decisionsOf = (mapping: any) =>
  Object.fromEntries(
    Object.values(mapping).map((m: any) => [m.key, m.decision])
  );

describe("Sync engine integration (in-memory fs + db)", () => {
  beforeEach(() => {
    global.window = {
      crypto: require("crypto").webcrypto,
      // Obsidian provides window.moment; stub just enough for unixTimeToStr
      moment: (x: any) => ({ format: () => String(x) }),
    } as any;
  });

  it("first sync pushes local files to an empty remote", async () => {
    const local = new MemFs();
    const remote = new MemFs();
    const db = mockDB();
    local.seedFile("a.md", "AAA");
    local.seedFile("b.md", "BBB");

    const m = syncOnce(local, remote, db, makeSettings());
    const d = decisionsOf(await m);
    assert.equal(d["a.md"], "local_is_created_then_push");
    assert.equal(dec(await remote.readFile("a.md")), "AAA");
    assert.equal(dec(await remote.readFile("b.md")), "BBB");
    const prev = await getAllPrevSyncRecordsByVaultAndProfile(db, VID, PID);
    assert.equal(prev.length, 2);
  });

  it("a second sync with no changes is a no-op (all equal)", async () => {
    const local = new MemFs();
    const remote = new MemFs();
    const db = mockDB();
    local.seedFile("a.md", "AAA");
    await syncOnce(local, remote, db, makeSettings());

    const d = decisionsOf(await syncOnce(local, remote, db, makeSettings()));
    assert.equal(d["a.md"], "equal");
  });

  it("a Dropbox-style mtime bump with identical content does NOT re-sync", async () => {
    const local = new MemFs();
    const remote = new MemFs();
    const db = mockDB();
    local.seedFile("a.md", "AAA", 1000);
    await syncOnce(local, remote, db, makeSettings());

    // same content, only mtime changed (Dropbox jitter)
    local.files.get("a.md")!.mtime = 9000;
    const d = decisionsOf(await syncOnce(local, remote, db, makeSettings()));
    assert.equal(d["a.md"], "equal");
  });

  it("a real local edit pushes; a real remote edit pulls", async () => {
    const local = new MemFs();
    const remote = new MemFs();
    const db = mockDB();
    local.seedFile("a.md", "AAA", 1000);
    local.seedFile("b.md", "BBB", 1000);
    await syncOnce(local, remote, db, makeSettings());

    // local edits a.md, remote edits b.md
    local.seedFile("a.md", "AAA-edited", 2000);
    remote.files.set("b.md", {
      content: enc("BBB-edited"),
      mtime: 3000,
      ctime: 3000,
    });

    const d = decisionsOf(await syncOnce(local, remote, db, makeSettings()));
    assert.equal(d["a.md"], "local_is_modified_then_push");
    assert.equal(d["b.md"], "remote_is_modified_then_pull");
    assert.equal(dec(await remote.readFile("a.md")), "AAA-edited");
    assert.equal(dec(await local.readFile("b.md")), "BBB-edited");
  });

  it("propagates a local delete to the remote", async () => {
    const local = new MemFs();
    const remote = new MemFs();
    const db = mockDB();
    local.seedFile("a.md", "AAA");
    local.seedFile("b.md", "BBB");
    await syncOnce(local, remote, db, makeSettings());

    local.files.delete("a.md"); // deleted on local
    const d = decisionsOf(await syncOnce(local, remote, db, makeSettings()));
    assert.equal(d["a.md"], "local_is_deleted_thus_also_delete_remote");
    assert.equal(remote.files.has("a.md"), false);
  });

  it("propagates a remote delete to the local", async () => {
    const local = new MemFs();
    const remote = new MemFs();
    const db = mockDB();
    local.seedFile("a.md", "AAA");
    local.seedFile("b.md", "BBB");
    await syncOnce(local, remote, db, makeSettings());

    remote.files.delete("b.md");
    const d = decisionsOf(await syncOnce(local, remote, db, makeSettings()));
    assert.equal(d["b.md"], "remote_is_deleted_thus_also_delete_local");
    assert.equal(local.files.has("b.md"), false);
  });

  it("keep_both: concurrent edits keep BOTH versions, nothing lost", async () => {
    const local = new MemFs();
    const remote = new MemFs();
    const db = mockDB();
    local.seedFile("c.md", "orig", 1000);
    await syncOnce(local, remote, db, makeSettings());

    // both sides edit c.md differently before syncing
    local.seedFile("c.md", "FROM-LOCAL", 2000);
    remote.files.set("c.md", {
      content: enc("FROM-REMOTE"),
      mtime: 3000,
      ctime: 3000,
    });

    await syncOnce(
      local,
      remote,
      db,
      makeSettings({ conflictAction: "keep_both" })
    );

    const localKeys = [...local.files.keys()];
    const conflictKey = localKeys.find((k) =>
      /^c \(conflict .*\)\.md$/.test(k)
    );
    assert.ok(conflictKey !== undefined, "a conflict copy should exist");

    // both versions survive on BOTH sides
    const localContents = new Set([
      dec(await local.readFile("c.md")),
      dec(await local.readFile(conflictKey!)),
    ]);
    const remoteContents = new Set([
      dec(await remote.readFile("c.md")),
      dec(await remote.readFile(conflictKey!)),
    ]);
    assert.deepEqual(localContents, new Set(["FROM-LOCAL", "FROM-REMOTE"]));
    assert.deepEqual(remoteContents, new Set(["FROM-LOCAL", "FROM-REMOTE"]));
  });

  it("keep_newer: the newer side wins, single file", async () => {
    const local = new MemFs();
    const remote = new MemFs();
    const db = mockDB();
    local.seedFile("c.md", "orig", 1000);
    await syncOnce(local, remote, db, makeSettings());

    local.seedFile("c.md", "LOCAL-NEW", 5000); // newer
    remote.files.set("c.md", {
      content: enc("REMOTE-OLD"),
      mtime: 2000,
      ctime: 2000,
    });

    await syncOnce(
      local,
      remote,
      db,
      makeSettings({ conflictAction: "keep_newer" })
    );
    assert.equal(dec(await remote.readFile("c.md")), "LOCAL-NEW");
    assert.equal(
      [...local.files.keys()].some((k) => k.includes("conflict")),
      false
    );
  });

  it("protectModifyPercentage aborts a mass destructive sync", async () => {
    const local = new MemFs();
    const remote = new MemFs();
    const db = mockDB();
    for (const k of ["a.md", "b.md", "c.md", "d.md"]) local.seedFile(k, k);
    await syncOnce(local, remote, db, makeSettings());

    // delete 3 of 4 locally -> 75% destructive, over the 50% guard
    local.files.delete("a.md");
    local.files.delete("b.md");
    local.files.delete("c.md");

    await assert.rejects(
      syncOnce(
        local,
        remote,
        db,
        makeSettings({ protectModifyPercentage: 50 })
      ),
      /protect:/
    );
    // remote untouched because the run aborted before deleting
    assert.equal(remote.files.has("a.md"), true);
  });

  it("syncs files inside nested folders", async () => {
    const local = new MemFs();
    const remote = new MemFs();
    const db = mockDB();
    local.seedFile("notes/sub/x.md", "X");
    await syncOnce(local, remote, db, makeSettings());
    assert.equal(dec(await remote.readFile("notes/sub/x.md")), "X");
  });
});
