import isEqual from "lodash/isEqual";
import { mergeDigIn } from "node-diff3";
import type { Entity } from "../../src/baseTypes";
import { copyFile } from "../../src/copyLogic";
import type { FakeFs } from "../../src/fsAll";
import { MERGABLE_SIZE } from "./baseTypesPro";

export function isMergable(a: Entity | undefined, b?: Entity) {
  // be defensive: a missing entity (e.g. a side that was deleted) is never
  // mergable. Without this guard `a.key!` below throws a TypeError and aborts
  // the whole sync (see the smart_conflict do-nothing dispatch branch).
  if (a === undefined) {
    return false;
  }
  if (b !== undefined && a.key !== b.key) {
    return false;
  }

  return (
    !a.key!.endsWith("/") &&
    a.sizeRaw <= MERGABLE_SIZE &&
    (a.key!.endsWith(".md") || a.key!.endsWith(".markdown"))
  );
}

/**
 * slightly modify to adjust in markdown context
 * @param a
 * @param o
 * @param b
 */
function mergeDigInModified(a: string, o: string, b: string) {
  const { conflict, result } = mergeDigIn(a, o, b, {
    stringSeparator: /\n/,
  });
  for (let index = 0; index < result.length; ++index) {
    if (["<<<<<<<", "=======", ">>>>>>>"].includes(result[index])) {
      result[index] = "`" + result[index] + "`";
    }
  }
  return {
    conflict,
    result,
  };
}

/**
 * Originally three way merge.
 * @param a
 * @param b
 * @param orig
 * @returns
 */
export function threeWayMerge(a: string, b: string, orig: string) {
  return mergeDigInModified(a, orig, b).result.join("\n");
}

export async function mergeFile(
  key: string,
  left: FakeFs,
  right: FakeFs,
  contentOrig: ArrayBuffer | null | undefined
) {
  // console.debug(
  //   `mergeFile: key=${key}, left=${left.kind}, right=${right.kind}`
  // );
  if (key.endsWith("/")) {
    throw Error(`should not call ${key} in mergeFile`);
  }

  if (!key.endsWith(".md") && !key.endsWith(".markdown")) {
    throw Error(`currently only support markdown files in mergeFile`);
  }

  const [contentLeft, contentRight] = await Promise.all([
    left.readFile(key),
    right.readFile(key),
  ]);

  let newArrayBuffer: ArrayBuffer | undefined = undefined;
  const decoder = new TextDecoder("utf-8");

  if (isEqual(contentLeft, contentRight)) {
    // we are lucky enough
    newArrayBuffer = contentLeft;
    // TODO: save the write
  } else {
    if (contentOrig === null || contentOrig === undefined) {
      // We have no recorded base version for this file, so a real 3-way merge
      // is impossible. We must NOT fabricate a base (the old LCS-based
      // twoWayMerge could silently drop lines that exist on only one side).
      // The caller is responsible for falling back to duplicate-and-rename so
      // both versions are preserved; reaching here is a programming error.
      throw new Error(
        `cannot merge "${key}" without a base version; ` +
          `caller must duplicate-and-rename instead of merging`
      );
    }
    const newText = threeWayMerge(
      decoder.decode(contentLeft),
      decoder.decode(contentRight),
      decoder.decode(contentOrig)
    );
    newArrayBuffer = new TextEncoder().encode(newText).buffer;
  }

  const mtime = Date.now();

  // left (local) must wait for the right
  // because the mtime might be different after upload
  // upload firstly
  const rightEntity = await right.writeFile(key, newArrayBuffer, mtime, mtime);
  // write local secondly
  const leftEntity = await left.writeFile(
    key,
    newArrayBuffer,
    rightEntity.mtimeCli ?? mtime,
    rightEntity.ctimeCli ?? rightEntity.mtimeCli ?? mtime
  );

  return {
    entity: rightEntity,
    content: newArrayBuffer,
  };
}

export function getFileRenameForDup(key: string) {
  if (
    key === "" ||
    key === "." ||
    key === ".." ||
    key === "/" ||
    key.endsWith("/")
  ) {
    throw Error(`we cannot rename key=${key}`);
  }

  const segsPath = key.split("/");
  const name = segsPath[segsPath.length - 1];
  const segsName = name.split(".");

  if (segsName.length === 0) {
    throw Error(`we cannot rename key=${key}`);
  } else if (segsName.length === 1) {
    // name = "kkk" without any dot
    segsPath[segsPath.length - 1] = `${name}.dup`;
  } else if (segsName.length === 2) {
    if (segsName[0] === "") {
      // name = ".kkkk" with leading dot
      segsPath[segsPath.length - 1] = `${name}.dup`;
    } else if (segsName[1] === "") {
      // name = "kkkk." with tailing dot
      segsPath[segsPath.length - 1] = `${segsName[0]}.dup`;
    } else {
      // name = "aaa.bbb" normally
      segsPath[segsPath.length - 1] = `${segsName[0]}.dup.${segsName[1]}`;
    }
  } else {
    // name = "[...].bbb.ccc"
    const firstPart = segsName.slice(0, segsName.length - 1).join(".");
    const thirdPart = segsName[segsName.length - 1];
    segsPath[segsPath.length - 1] = `${firstPart}.dup.${thirdPart}`;
  }
  const res = segsPath.join("/");
  return res;
}

function arraysAreEqual(arr1: ArrayBuffer, arr2: ArrayBuffer) {
  if (arr1.byteLength !== arr2.byteLength) {
    return false;
  }
  const u1 = new Uint8Array(arr1);
  const u2 = new Uint8Array(arr2);

  for (let i = 0; i < u1.byteLength; ++i) {
    if (u1[i] !== u2[i]) {
      return false;
    }
  }

  return true;
}

/**
 * 1. download remote
 * 2. compare
 * 3. if the same, update local but not upload
 * 4. if not the same, rename local and save remote
 */
async function tryDuplicateFileForSameSizes(
  key: string,
  key2: string,
  fsLocal: FakeFs,
  fsRemote: FakeFs,
  uploadCallback: (entity: Entity | undefined) => Promise<any>,
  downloadCallback: (entity: Entity | undefined) => Promise<any>
) {
  console.debug(`tryDuplicateFileForSameSizes: ${key}`);

  // 1. download
  const remoteContent = await fsRemote.readFile(key);

  // 2. compare
  const localContent = await fsLocal.readFile(key);
  const eq = arraysAreEqual(localContent, remoteContent);

  if (eq) {
    // 3. if the same, update local but not upload
    // read meta of remote, as if we have downloaded the file
    console.debug(`tryDuplicateFileForSameSizes: ${key} content equal`);
    const entityRemote = await fsRemote.stat(key);

    // write
    const downloadResultEntity = await fsLocal.writeFile(
      key,
      remoteContent,
      entityRemote.mtimeCli ?? Date.now(),
      entityRemote.mtimeCli ?? Date.now()
    );
    await downloadCallback(downloadResultEntity);

    // no uploadCallback here
  } else {
    // 4. if not the same, rename local and save remote
    console.debug(`tryDuplicateFileForSameSizes: ${key} content not equal`);

    await fsLocal.rename(key, key2);

    const entityRemote = await fsRemote.stat(key);
    const downloadResultEntity = await fsLocal.writeFile(
      key,
      remoteContent,
      entityRemote.mtimeCli ?? Date.now(),
      entityRemote.mtimeCli ?? Date.now()
    );
    await downloadCallback(downloadResultEntity);

    const entityLocal = await fsLocal.stat(key2); // key2 here!
    const uploadResultEntity = await fsRemote.writeFile(
      key2, // key2 here!
      localContent,
      entityLocal.mtimeCli ?? Date.now(),
      entityLocal.mtimeCli ?? Date.now()
    );
    await uploadCallback(uploadResultEntity);
  }
}

/**
 * local: x.md -> x.dup.md -> upload to remote
 * remote: x.md -> download to local -> using original name x.md
 */
async function tryDuplicateFileForDiffSizes(
  key: string,
  key2: string,
  fsLocal: FakeFs,
  fsRemote: FakeFs,
  uploadCallback: (entity: Entity | undefined) => Promise<any>,
  downloadCallback: (entity: Entity | undefined) => Promise<any>
) {
  console.debug(`tryDuplicateFileForDiffSizes: ${key}`);

  await fsLocal.rename(key, key2);

  /**
   * x.dup.md -> upload to remote
   */
  async function f1() {
    const k = await copyFile(key2, fsLocal, fsRemote);
    await uploadCallback(k.entity);
    return k.entity;
  }

  /**
   * x.md -> download to local
   */
  async function f2() {
    const k = await copyFile(key, fsRemote, fsLocal);
    await downloadCallback(k.entity);
    return k.entity;
  }

  const [resUpload, resDownload] = await Promise.all([f1(), f2()]);

  return {
    upload: resUpload,
    download: resDownload,
  };
}

export async function tryDuplicateFile(
  key: string,
  fsLocal: FakeFs,
  fsRemote: FakeFs,
  uploadCallback: (entity: Entity | undefined) => Promise<any>,
  downloadCallback: (entity: Entity | undefined) => Promise<any>
) {
  let key2 = getFileRenameForDup(key);
  let usable = false;
  do {
    try {
      const s = await fsLocal.stat(key2);
      if (s === null || s === undefined) {
        throw Error(`not exist $${key2}`);
      }
      console.debug(`key2=${key2} exists, cannot use for new file`);
      key2 = getFileRenameForDup(key2);
      console.debug(`key2=${key2} is prepared for next try`);
    } catch (e) {
      // not exists, exactly what we want
      console.debug(`key2=${key2} doesn't exist, usable for new file`);
      usable = true;
    }
  } while (!usable);

  const localSize = await fsLocal.stat(key);
  const remoteSize = await fsRemote.stat(key);

  if (
    localSize !== undefined &&
    remoteSize !== undefined &&
    localSize.sizeRaw === remoteSize.sizeRaw
  ) {
    return await tryDuplicateFileForSameSizes(
      key,
      key2,
      fsLocal,
      fsRemote,
      uploadCallback,
      downloadCallback
    );
  } else {
    return await tryDuplicateFileForDiffSizes(
      key,
      key2,
      fsLocal,
      fsRemote,
      uploadCallback,
      downloadCallback
    );
  }
}
