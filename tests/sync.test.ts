import { strict as assert } from "assert";
import type { Entity, MixedEntity } from "../src/baseTypes";
import { FakeFs } from "../src/fsAll";
import {
  assignFileDecisionInplace,
  checkIsSkipItemOrNotByName,
  classifyLocal,
  classifyRemote,
  getConflictCopyName,
} from "../src/sync";

describe("Sync(free engine): checkIsSkipItemOrNotByName", () => {
  const skip = (
    key: string,
    opts: Partial<{
      syncConfigDir: boolean;
      syncBookmarks: boolean;
      syncUnderscoreItems: boolean;
      ignorePaths: string[];
      onlyAllowPaths: string[];
    }> = {}
  ) =>
    checkIsSkipItemOrNotByName(
      key,
      ".obsidian",
      opts.syncConfigDir ?? false,
      opts.syncBookmarks ?? false,
      opts.syncUnderscoreItems ?? false,
      opts.ignorePaths ?? [],
      opts.onlyAllowPaths ?? []
    );

  it("skips empty/root", () => {
    assert.ok(skip(""));
    assert.ok(skip("/"));
  });

  it("does not skip a normal note", () => {
    assert.ok(!skip("notes/a.md"));
  });

  it("skips the config dir unless enabled", () => {
    assert.ok(skip(".obsidian/app.json"));
    assert.ok(!skip(".obsidian/app.json", { syncConfigDir: true }));
  });

  it("handles bookmarks independently", () => {
    assert.ok(skip(".obsidian/bookmarks.json"));
    assert.ok(!skip(".obsidian/bookmarks.json", { syncBookmarks: true }));
  });

  it("skips underscore items unless enabled", () => {
    assert.ok(skip("_attachments/x.png"));
    assert.ok(!skip("_attachments/x.png", { syncUnderscoreItems: true }));
  });

  it("honors deny and allow lists", () => {
    assert.ok(skip("secret/a.md", { ignorePaths: ["secret"] }));
    assert.ok(!skip("keep/a.md", { ignorePaths: ["secret"] }));
    assert.ok(skip("other/a.md", { onlyAllowPaths: ["^keep"] }));
    assert.ok(!skip("keep/a.md", { onlyAllowPaths: ["^keep"] }));
  });
});

describe("Sync(free engine): getConflictCopyName", () => {
  it("inserts before the extension", () => {
    assert.equal(
      getConflictCopyName("note.md", "2026-06-26"),
      "note (conflict 2026-06-26).md"
    );
    assert.equal(
      getConflictCopyName("a/b/note.md", "2026-06-26"),
      "a/b/note (conflict 2026-06-26).md"
    );
  });

  it("appends when there is no extension", () => {
    assert.equal(
      getConflictCopyName("foo", "2026-06-26"),
      "foo (conflict 2026-06-26)"
    );
  });

  it("treats a leading-dot filename as having no extension to split", () => {
    assert.equal(
      getConflictCopyName("a/.hidden", "2026-06-26"),
      "a/.hidden (conflict 2026-06-26)"
    );
  });

  it("throws for folders", () => {
    assert.throws(() => getConflictCopyName("a/", "2026-06-26"));
  });
});

describe("Sync(free engine): classifyRemote", () => {
  const prev: Entity = {
    keyRaw: "a.md",
    mtimeSvr: 1000,
    sizeEnc: 50,
    sizeRaw: 42,
  };

  it("created when no prevSync", () => {
    assert.equal(
      classifyRemote(
        { keyRaw: "a.md", mtimeSvr: 1, sizeEnc: 1, sizeRaw: 1 },
        undefined
      ),
      "created"
    );
  });
  it("deleted when absent", () => {
    assert.equal(classifyRemote(undefined, prev), "deleted");
  });
  it("unchanged when mtime+size match", () => {
    assert.equal(
      classifyRemote(
        { keyRaw: "a.md", mtimeSvr: 1000, sizeEnc: 50, sizeRaw: 42 },
        prev
      ),
      "unchanged"
    );
  });
  it("modified when mtime differs", () => {
    assert.equal(
      classifyRemote(
        { keyRaw: "a.md", mtimeSvr: 2000, sizeEnc: 50, sizeRaw: 42 },
        prev
      ),
      "modified"
    );
  });
});

// minimal in-memory FakeFs exposing only readFile (what classifyLocal needs)
class MemFs extends FakeFs {
  kind = "mem";
  store = new Map<string, ArrayBuffer>();
  put(key: string, text: string) {
    this.store.set(key, new TextEncoder().encode(text).buffer);
  }
  async readFile(key: string): Promise<ArrayBuffer> {
    const v = this.store.get(key);
    if (v === undefined) throw new Error(`no such file ${key}`);
    return v;
  }
  async walk(): Promise<Entity[]> {
    throw new Error("ni");
  }
  async walkPartial(): Promise<Entity[]> {
    throw new Error("ni");
  }
  async stat(): Promise<Entity> {
    throw new Error("ni");
  }
  async mkdir(): Promise<Entity> {
    throw new Error("ni");
  }
  async writeFile(): Promise<Entity> {
    throw new Error("ni");
  }
  async rename(): Promise<void> {}
  async rm(): Promise<void> {}
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

describe("Sync(free engine): classifyLocal (hash-confirmed)", () => {
  beforeEach(() => {
    global.window = { crypto: require("crypto").webcrypto } as any;
  });

  it("created when no prevSync", async () => {
    const fs = new MemFs();
    assert.equal(
      await classifyLocal(
        { keyRaw: "a.md", mtimeCli: 1, sizeEnc: 1, sizeRaw: 1 },
        undefined,
        "a.md",
        fs
      ),
      "created"
    );
  });

  it("deleted when absent locally", async () => {
    const fs = new MemFs();
    assert.equal(
      await classifyLocal(
        undefined,
        { keyRaw: "a.md", sizeRaw: 1 },
        "a.md",
        fs
      ),
      "deleted"
    );
  });

  it("unchanged when mtime+size match (no hash read needed)", async () => {
    const fs = new MemFs();
    const e: Entity = {
      keyRaw: "a.md",
      mtimeCli: 1000,
      sizeEnc: 50,
      sizeRaw: 42,
    };
    assert.equal(await classifyLocal(e, e, "a.md", fs), "unchanged");
  });

  it("treats a bumped mtime with identical content as UNCHANGED (Dropbox jitter)", async () => {
    const fs = new MemFs();
    fs.put("a.md", "hello world");
    const content = await fs.readFile("a.md");
    const { getSha1 } = await import("../src/misc");
    const hash = await getSha1(content, "hex");
    const prev: Entity = {
      keyRaw: "a.md",
      mtimeCli: 1000,
      sizeEnc: 50,
      sizeRaw: 11,
      hash,
    };
    const local: Entity = {
      keyRaw: "a.md",
      mtimeCli: 9999, // mtime bumped
      sizeEnc: 50,
      sizeRaw: 11,
    };
    assert.equal(await classifyLocal(local, prev, "a.md", fs), "unchanged");
  });

  it("detects a real edit (hash differs)", async () => {
    const fs = new MemFs();
    fs.put("a.md", "hello world EDITED");
    const prev: Entity = {
      keyRaw: "a.md",
      mtimeCli: 1000,
      sizeEnc: 50,
      sizeRaw: 11,
      hash: "deadbeef-not-matching",
    };
    const local: Entity = {
      keyRaw: "a.md",
      mtimeCli: 9999,
      sizeEnc: 60,
      sizeRaw: 18,
    };
    assert.equal(await classifyLocal(local, prev, "a.md", fs), "modified");
  });
});

describe("Sync(free engine): bidirectional decision table", () => {
  const mk = (over: Partial<MixedEntity> = {}): MixedEntity => ({
    key: "a.md",
    local: { keyRaw: "a.md", mtimeCli: 100, sizeEnc: 10, sizeRaw: 10 },
    remote: { keyRaw: "a.md", mtimeSvr: 100, sizeEnc: 10, sizeRaw: 10 },
    prevSync: { keyRaw: "a.md", sizeRaw: 10 },
    ...over,
  });

  const decide = (
    ls: any,
    rs: any,
    conflictAction: any = "keep_both",
    over: Partial<MixedEntity> = {}
  ) => {
    const m = mk(over);
    assignFileDecisionInplace(m, ls, rs, conflictAction);
    return m.decision;
  };

  it("unchanged/unchanged -> equal", () => {
    assert.equal(decide("unchanged", "unchanged"), "equal");
  });
  it("unchanged/modified -> pull", () => {
    assert.equal(
      decide("unchanged", "modified"),
      "remote_is_modified_then_pull"
    );
  });
  it("modified/unchanged -> push", () => {
    assert.equal(
      decide("modified", "unchanged"),
      "local_is_modified_then_push"
    );
  });
  it("unchanged/deleted -> delete local", () => {
    assert.equal(
      decide("unchanged", "deleted"),
      "remote_is_deleted_thus_also_delete_local"
    );
  });
  it("deleted/unchanged -> delete remote", () => {
    assert.equal(
      decide("deleted", "unchanged"),
      "local_is_deleted_thus_also_delete_remote"
    );
  });
  it("deleted/deleted -> only_history", () => {
    assert.equal(decide("deleted", "deleted"), "only_history");
  });
  it("created/deleted -> push", () => {
    assert.equal(decide("created", "deleted"), "local_is_created_then_push");
  });
  it("deleted/created -> pull", () => {
    assert.equal(decide("deleted", "created"), "remote_is_created_then_pull");
  });

  it("modified/modified + keep_both -> conflict keep_both (no loss)", () => {
    assert.equal(
      decide("modified", "modified", "keep_both"),
      "conflict_modified_then_keep_both"
    );
  });
  it("created/created + keep_both -> conflict_created_then_keep_both", () => {
    assert.equal(
      decide("created", "created", "keep_both", { prevSync: undefined }),
      "conflict_created_then_keep_both"
    );
  });

  it("keep_newer picks the newer side", () => {
    assert.equal(
      decide("modified", "modified", "keep_newer", {
        local: { keyRaw: "a.md", mtimeCli: 200, sizeEnc: 10, sizeRaw: 10 },
        remote: { keyRaw: "a.md", mtimeSvr: 100, sizeEnc: 10, sizeRaw: 10 },
      }),
      "conflict_modified_then_keep_local"
    );
    assert.equal(
      decide("modified", "modified", "keep_newer", {
        local: { keyRaw: "a.md", mtimeCli: 100, sizeEnc: 10, sizeRaw: 10 },
        remote: { keyRaw: "a.md", mtimeSvr: 200, sizeEnc: 10, sizeRaw: 10 },
      }),
      "conflict_modified_then_keep_remote"
    );
  });

  it("keep_larger picks the larger side", () => {
    assert.equal(
      decide("modified", "modified", "keep_larger", {
        local: { keyRaw: "a.md", mtimeCli: 100, sizeEnc: 99, sizeRaw: 99 },
        remote: { keyRaw: "a.md", mtimeSvr: 100, sizeEnc: 10, sizeRaw: 10 },
      }),
      "conflict_modified_then_keep_local"
    );
  });
});
