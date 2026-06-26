# Testing the free `src/` sync engine

This guide validates the clean-room Apache sync engine in `src/sync.ts` (the one
that replaced the `pro/` engine) against a **real Dropbox + encrypted** vault. It
focuses on the two behaviours this engine exists to fix — **never silently
overwrite a concurrent edit** (`keep_both`) and **don't mis-detect a change**
(content-hash detection) — plus the basics (push/pull/delete) and the safety
guard.

> ⚠️ This is a brand-new engine touching real notes. **Back up your vault first**
> (copy the folder somewhere safe). Do the read-only dry-run checks before any
> live sync.

## Scope / limitations

- **Bidirectional only.** If `syncDirection` is set to any incremental mode the
  sync aborts with a clear error — that is expected.
- Conflict actions: `keep_newer`, `keep_larger`, **`keep_both`** (recommended).
  The PRO `smart_conflict` markdown merge is not available; if it is still
  selected the engine falls back to `keep_both` (no data loss).
- Folder create/delete ordering is unit-tested but not yet battle-tested live —
  watch it during the deletion test below.

## 0. Build and install

```bash
npm ci
npm run build      # produces a single main.js
```

Copy `main.js`, `manifest.json`, `styles.css` into your vault's
`.obsidian/plugins/remotely-save/`, then reload Obsidian (or toggle the plugin
off/on in Community Plugins). Confirm the version/date matches your build.

In the plugin settings:
- **Disable auto sync** (Settings → schedule for auto run → off) so nothing runs
  unexpectedly while you test.
- Set **Conflict Action = "keep both"**.
- Confirm **Sync Direction = "bidirectional"** and your password/encryption are
  set as usual.

Use a **throwaway test vault** (or a copy) pointed at a **test subfolder** in
Dropbox if you can, rather than your primary vault.

## 1. Dry run — inspect the plan before any write (read-only)

A dry run computes the full plan and writes **nothing**.

1. Command palette → **"Remotely Save: start sync (dry run only)"**
   (`command_drynrun`).
2. Command palette → **"Remotely Save: export sync plans (latest 1)"**.
3. Open the generated `_debug_remotely_save/sync_plans_hist_exported_on_*.md`.

Each entry has a `decision` and `decisionBranch`. Sanity-check that they match
reality. The decision vocabulary this engine emits:

| decision | meaning |
| --- | --- |
| `equal` | in sync, no-op |
| `local_is_created_then_push` / `local_is_modified_then_push` | upload local |
| `remote_is_created_then_pull` / `remote_is_modified_then_pull` | download remote |
| `local_is_deleted_thus_also_delete_remote` | local gone → delete remote |
| `remote_is_deleted_thus_also_delete_local` | remote gone → delete local |
| `conflict_*_then_keep_both` | both changed → keep both copies |
| `conflict_*_then_keep_local` / `keep_remote` | conflict resolved by newer/larger |
| `only_history` | gone on both sides → just clear history |
| `folder_*` | folder create/delete |

**Optional A/B:** to compare against the old engine, temporarily change the
import in `src/main.ts` back to `import { syncer } from "../pro/src/sync";`,
rebuild, dry-run + export, then diff the two exported plans on the same vault
state. Revert the import afterward.

If the dry-run plan looks right, proceed to live tests **on the backup/test
vault**.

## 2. Single-device round-trip (no false conflicts)

This checks content-hash detection (Dropbox can bump mtimes).

1. From a clean in-sync state, run a manual sync. Expect mostly `equal`.
2. Edit one note on **one** device. Sync. Expect exactly that note as
   `local_is_modified_then_push`, everything else `equal`.
3. Run sync **again without editing**. Expect **all `equal`** — in particular the
   note you just pushed must NOT come back as a conflict or re-upload. (A naive
   mtime-only engine would mis-flag it; the hash check prevents that.)

## 3. Concurrent edit → `keep_both` (the headline test)

Simulate the cross-device data-loss scenario.

1. Start from an in-sync note `conflict-test.md` on two devices (A and B), or
   simulate B by editing the file directly in the remote/another vault copy.
2. On device A: edit `conflict-test.md` (add a line "FROM A"), **sync**.
3. On device B (which has **not** pulled A's change): edit the same note (add a
   line "FROM B"), **sync**.
4. On B's sync, expect decision `conflict_modified_then_keep_both` for that file.
5. **Verify no loss:** after syncing both devices once more, **both** devices
   should end up with:
   - `conflict-test.md` containing one side's version, and
   - `conflict-test (conflict YYYY-MM-DD).md` containing the other side's version.
   Open both files — "FROM A" and "FROM B" must each survive somewhere. Nothing
   is overwritten.

## 4. Deletions propagate

1. Delete a synced note on device A. Sync A (expect
   `local_is_deleted_thus_also_delete_remote`).
2. Sync device B (expect `remote_is_deleted_thus_also_delete_local`); the note
   disappears on B.
3. Delete a whole folder of notes on one side and sync both; confirm the files
   are removed on the other side and **no unrelated files are touched**. Watch
   that folder removal happens child-first and doesn't error.

## 5. Protect-modify guard

1. Set **Protect Modify Percentage** to e.g. 50.
2. Contrive a state where a large fraction of files would be deleted/overwritten
   in one sync (e.g. delete most notes on one side).
3. Sync. Expect the run to **abort with the protect-percentage error** instead of
   mass-deleting. (Raise the percentage to 100 only when you genuinely intend a
   bulk change.)

## What "pass" looks like

- Dry-run decisions match what you expect for each contrived state.
- A pushed/pulled file does **not** re-sync or conflict on the next no-op sync.
- A genuine concurrent edit yields a `(conflict <date>)` copy with **both**
  versions intact — never a silent overwrite.
- Deletions propagate; unrelated files are untouched.
- A mass change trips the protect-percentage guard.

## Rollback

The old engine is still on disk. To revert, change the import in `src/main.ts`
back to `../pro/src/sync`, rebuild, and reinstall `main.js`. (Your previous-sync
history in the local DB is shared, so either engine resumes from the same state.)
