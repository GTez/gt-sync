import { deepStrictEqual, rejects, strictEqual, throws } from "assert";
import type { Entity } from "../../src/baseTypes";
import { FakeFs } from "../../src/fsAll";
import {
  getFileRenameForDup,
  isMergable,
  mergeFile,
  threeWayMerge,
} from "../src/conflictLogic";

describe("New name is generated", () => {
  it("should throw for empty file", async () => {
    for (const key of ["", "/", ".", ".."]) {
      throws(() => getFileRenameForDup(key));
    }
  });

  it("should throw for folder", async () => {
    for (const key of ["sss/", "ssss/yyy/"]) {
      throws(() => getFileRenameForDup(key));
    }
  });

  it("should correctly get no ext files renamed", async () => {
    deepStrictEqual(getFileRenameForDup("abc"), "abc.dup");

    deepStrictEqual(getFileRenameForDup("xxxx/yyyy/abc"), "xxxx/yyyy/abc.dup");
  });

  it("should correctly get dot files renamed", async () => {
    deepStrictEqual(getFileRenameForDup(".abc"), ".abc.dup");

    deepStrictEqual(
      getFileRenameForDup("xxxx/yyyy/.efg"),
      "xxxx/yyyy/.efg.dup"
    );

    deepStrictEqual(getFileRenameForDup("xxxx/yyyy/hij."), "xxxx/yyyy/hij.dup");
  });

  it("should correctly get normal files renamed", async () => {
    deepStrictEqual(getFileRenameForDup("abc.efg"), "abc.dup.efg");

    deepStrictEqual(
      getFileRenameForDup("xxxx/yyyy/abc.efg"),
      "xxxx/yyyy/abc.dup.efg"
    );

    deepStrictEqual(
      getFileRenameForDup("xxxx/yyyy/abc.tar.gz"),
      "xxxx/yyyy/abc.tar.dup.gz"
    );

    deepStrictEqual(
      getFileRenameForDup("xxxx/yyyy/.abc.efg"),
      "xxxx/yyyy/.abc.dup.efg"
    );
  });

  it("should correctly get duplicated files renamed again", async () => {
    deepStrictEqual(getFileRenameForDup("abc.dup"), "abc.dup.dup");

    deepStrictEqual(
      getFileRenameForDup("xxxx/yyyy/.abc.dup"),
      "xxxx/yyyy/.abc.dup.dup"
    );

    deepStrictEqual(
      getFileRenameForDup("xxxx/yyyy/abc.dup.md"),
      "xxxx/yyyy/abc.dup.dup.md"
    );

    deepStrictEqual(
      getFileRenameForDup("xxxx/yyyy/.abc.dup.md"),
      "xxxx/yyyy/.abc.dup.dup.md"
    );
  });
});

describe("isMergable is defensive against missing entities", () => {
  it("should return false for an undefined entity (no crash)", () => {
    // regression: a deleted side passes undefined here. Previously this threw
    // a TypeError (a.key!) and aborted the whole sync.
    strictEqual(isMergable(undefined as unknown as Entity), false);
  });

  it("should still classify real markdown entities", () => {
    strictEqual(isMergable({ keyRaw: "x.md", key: "x.md", sizeRaw: 1 }), true);
    strictEqual(
      isMergable({ keyRaw: "x.png", key: "x.png", sizeRaw: 1 }),
      false
    );
  });
});

describe("mergeFile refuses to merge without a base version", () => {
  // a tiny in-memory FakeFs covering only what mergeFile touches
  class MemFs extends FakeFs {
    kind = "mem";
    store = new Map<string, ArrayBuffer>();
    constructor(seed: Record<string, string>) {
      super();
      for (const [k, v] of Object.entries(seed)) {
        this.store.set(k, new TextEncoder().encode(v).buffer);
      }
    }
    async readFile(key: string): Promise<ArrayBuffer> {
      return this.store.get(key)!;
    }
    async writeFile(
      key: string,
      content: ArrayBuffer,
      mtime: number,
      ctime: number
    ): Promise<Entity> {
      this.store.set(key, content);
      return { keyRaw: key, mtimeCli: mtime, ctimeCli: ctime, sizeRaw: 0 };
    }
    // unused in these tests
    async walk(): Promise<Entity[]> {
      throw new Error("not implemented");
    }
    async walkPartial(): Promise<Entity[]> {
      throw new Error("not implemented");
    }
    async stat(): Promise<Entity> {
      throw new Error("not implemented");
    }
    async mkdir(): Promise<Entity> {
      throw new Error("not implemented");
    }
    async rename(): Promise<void> {
      throw new Error("not implemented");
    }
    async rm(): Promise<void> {
      throw new Error("not implemented");
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
  }

  it("throws when contents differ and there is no base (no silent loss)", async () => {
    const left = new MemFs({ "note.md": "aaa" });
    const right = new MemFs({ "note.md": "bbb" });
    await rejects(
      () => mergeFile("note.md", left, right, null),
      /without a base version/
    );
  });

  it("still succeeds with a real base (3-way merge)", async () => {
    const left = new MemFs({ "note.md": "base\nleft" });
    const right = new MemFs({ "note.md": "base\nright" });
    const base = new TextEncoder().encode("base").buffer;
    const { content } = await mergeFile("note.md", left, right, base);
    const merged = new TextDecoder().decode(content);
    // both sides' unique lines must survive (here as conflict markers)
    deepStrictEqual(merged.includes("left"), true);
    deepStrictEqual(merged.includes("right"), true);
  });
});

describe("Three way merge", () => {
  it("should correctly merge from zero files", async () => {
    const orig = "";
    const a = "aaa";
    const b = "bbb";
    const res = threeWayMerge(a, b, orig);
    const expected = `\`<<<<<<<\`
aaa
\`=======\`
bbb
\`>>>>>>>\``;
    deepStrictEqual(expected, res);
  });

  it("should correctly merge after adding lines on both sides", async () => {
    const orig = `
* [ ] A1
* [ ] A2
* [ ] A3
`;
    const a = `
* [ ] A1
* [ ] new line after A1
* [ ] A2
* [ ] A3
`;
    const b = `
* [ ] A1
* [ ] A2
* [ ] New line after A2
* [ ] A3
`;
    const res = threeWayMerge(a, b, orig);
    // console.log(res);
    const expected = `
* [ ] A1
* [ ] new line after A1
* [ ] A2
* [ ] New line after A2
* [ ] A3
`;
    deepStrictEqual(expected, res);
  });

  it("should correctly merge after adding lines on both sides (again)", async () => {
    const orig = `
* [ ] 中文
* [ ] にほんご／にっぽんご
* [ ] A3
`;
    const a = `
* [ ] 中文
* [ ] new line after 中文
* [ ] にほんご／にっぽんご
* [ ] A3
`;
    const b = `
* [ ] 中文
* [ ] にほんご／にっぽんご
* [ ] New line after にほんご／にっぽんご
* [ ] A3
`;
    const res = threeWayMerge(a, b, orig);
    // console.log(res);
    const expected = `
* [ ] 中文
* [ ] new line after 中文
* [ ] にほんご／にっぽんご
* [ ] New line after にほんご／にっぽんご
* [ ] A3
`;
    deepStrictEqual(expected, res);
  });

  it("should correctly merge after deleting lines on both sides", async () => {
    const orig = `
* [ ] 中文
* [ ] にほんご／にっぽんご
* [ ] A3
* [ ] A4
`;
    const a = `
* [ ] にほんご／にっぽんご
* [ ] A3
* [ ] A4
`;
    const b = `
* [ ] 中文
* [ ] A3
* [ ] A4
`;
    const res = threeWayMerge(a, b, orig);
    // console.log(res);
    const expected = `
\`<<<<<<<\`
* [ ] にほんご／にっぽんご
\`=======\`
* [ ] 中文
\`>>>>>>>\`
* [ ] A3
* [ ] A4
`;
    deepStrictEqual(expected, res);
  });

  it("should correctly merge after adding on one side and deleting on other side", async () => {
    const orig = `
* [ ] 中文
* [ ] A3
* [ ] A4
`;
    const a = `
* [ ] 中文
* [ ] にほんご／にっぽんご
* [ ] A3
* [ ] A4
`;
    const b = `
* [ ] A3
* [ ] A4
`;
    const res = threeWayMerge(a, b, orig);
    // console.log(res);
    const expected = `
\`<<<<<<<\`
* [ ] 中文
* [ ] にほんご／にっぽんご
\`=======\`
\`>>>>>>>\`
* [ ] A3
* [ ] A4
`;
    deepStrictEqual(expected, res);
  });

  it("should correctly merge after adding on one side and deleting on other side (again)", async () => {
    const orig = `
* [ ] 中文
* [ ] A3
* [ ] A4
`;
    const a = `
* [ ] A3
* [ ] A4
`;
    const b = `
* [ ] 中文
* [ ] にほんご／にっぽんご
* [ ] A3
* [ ] A4
`;
    const res = threeWayMerge(a, b, orig);
    // console.log(res);
    const expected = `
\`<<<<<<<\`
\`=======\`
* [ ] 中文
* [ ] にほんご／にっぽんご
\`>>>>>>>\`
* [ ] A3
* [ ] A4
`;
    deepStrictEqual(expected, res);
  });
});
