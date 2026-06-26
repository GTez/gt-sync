# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Remotely Save is an Obsidian plugin (TypeScript) that syncs a vault between the local device and a cloud service (S3, Dropbox, OneDrive, WebDAV, Webdis, and several PRO-only backends). It runs inside Obsidian's browser-like environment on both desktop and mobile, which drives most of the architectural constraints (see `docs/browser_env*.md`: no real Node.js, CORS limits, no background execution after the app closes, OAuth2 must use PKCE).

The codebase is split into two trees:
- `src/` — the free plugin and all shared logic.
- `pro/` — PRO (paid) features: extra storage backends, the actual sync engine (`pro/src/sync.ts`), and smart-conflict/merge logic. `src/` imports from `pro/` (e.g. `src/main.ts` imports `syncer` from `pro/src/sync.ts`, and `src/fsGetter.ts` imports the PRO `FakeFs` backends).

## Commands

- `npm run build` — production build via webpack (the primary/release build; outputs `main.js`).
- `npm run dev` — webpack watch build for development.
- `npm run build2` / `npm run dev2` — alternative esbuild build / watch (`esbuild.config.mjs`). Note `build2` runs a standalone `tsc -noEmit` typecheck first; the primary webpack `build` does **not** run a separate `tsc` (type errors only surface through ts-loader), so run `npm run build2` (or `tsc -noEmit`) to get a full typecheck.
- `npm run format` — Biome check + autofix across the repo (`biome.json`; formatter and linter config live here). This is the lint/format gate.
- `npm test` — Mocha over `tests/**/*.ts` and `pro/tests/**/*.ts`, run through `tsx` (no separate compile step).
- Run a single test file: `npx mocha --import=tsx tests/misc.test.ts`
- Filter by name: `npx mocha --import=tsx 'tests/**/*.ts' --grep "some title"`
- `npm run clean` — remove the built `main.js`.

Build-time secrets (OAuth client IDs/keys for Dropbox, OneDrive, Google Drive, Box, pCloud, Yandex, Koofr) are injected from environment variables via `dotenv`. Copy `.env.example.txt` to `.env`; missing values default to empty strings, so builds succeed without them but those backends won't authenticate.

## Architecture

### Storage backend abstraction
Every storage service implements the abstract class `FakeFs` (`src/fsAll.ts`): `walk`, `stat`, `mkdir`, `writeFile`, `readFile`, `rename`, `rm`, `checkConnect`, etc. Concrete implementations are `fsS3.ts`, `fsDropbox.ts`, `fsOnedrive.ts`, `fsWebdav.ts`, `fsWebdis.ts` (free) and `pro/src/fs*.ts` (PRO: Google Drive, Box, pCloud, Yandex, Koofr, Azure Blob, OneDrive Full).

`src/fsGetter.ts` is the single factory (`getClient`) mapping `settings.serviceType` to a backend instance — it exists specifically to avoid circular dependencies. Add new backends to the switch here.

### Encryption is a decorator over the backend
`FakeFsEncrypt` (`src/fsEncrypt.ts`) also extends `FakeFs` and wraps an `innerFs` (the real remote backend). When a password is set, it transparently encrypts file content and encrypts/decrypts file *keys* (paths) before delegating to the inner fs. Two cipher formats: OpenSSL (`encryptOpenSSL.ts`) and rclone crypt (`encryptRClone.ts`, with a Web Worker `encryptRClone.worker.ts` for performance — webpack uses `worker-loader`, esbuild uses `esbuild-plugin-inline-worker`). The sync engine asserts `fsEncrypt.innerFs === fsRemote`.

### Sync engine
The core sync logic lives in `pro/src/sync.ts`, exported as `syncer(...)`. Two main phases:
1. `getSyncPlanInplace` — builds a `MixedEntity` mapping by reconciling **three** sources: local files, remote files, and the *previous successful sync history* (stored locally per vault+profile). Each entity is assigned a numbered `decisionBranch` per the decision tables in `docs/sync_algorithm/v3/design.md`. This V3 algorithm does true deletion detection (no remote metadata file) and supports bidirectional / incremental-push-only / incremental-pull-only directions.
2. `doActualSync` — executes the plan (folder creations, transfers, deletions) with a `p-queue` for concurrency.

Conflict handling: the free version only keeps newer/larger; PRO `conflictLogic.ts` adds markdown merge (via `node-diff3` — note the `@sanity/diff-match-patch` import is commented out / unused despite still being a `package.json` dependency) and duplicate-and-rename. `syncRun(triggerSource)` in `src/main.ts` is the entry point; trigger sources include `manual`, `dry`, `auto`, `auto_once_init`, `auto_sync_on_save`.

### Local state
`src/localdb.ts` uses `localforage` (IndexedDB) under db `remotelysavedb`. It persists previous-sync records (the third reconciliation source), sync-plan history (exportable for debugging — see `docs/how_to_debug/`), vault random IDs, profiler results, and a simple KV store. PRO adds a file-content-history table for merge.

### main.ts
`src/main.ts` is the Obsidian `Plugin` subclass and the only place that holds mutable app state — it wires together settings, the fs backends, encryption, the local db, the profiler, ribbon/statusbar/notice callbacks, auto-sync timers, and OAuth protocol handlers, then calls `syncer`. `src/settings.ts` is the (large) settings UI.

## Conventions

- **Keep functions pure except in `main.ts`.** Pass stateful info as parameters (`docs/code_design.md`). `misc.ts` must not depend on any other in-repo module. Storage backends must not depend on `sync.ts`.
- **Folders are represented as strings ending in `/`** throughout the sync code.
- Code style is enforced by Biome (2-space indent, double quotes, semicolons, 80-col, trailing commas es5). `noExplicitAny` and `noNonNullAssertion` are intentionally off.
- User-facing strings are localized in `src/langs/` and `pro/src/langs/` (`en`, `zh_cn`, `zh_tw`); see `src/i18n.ts`.

## Adding a new storage service

`pro/src/add_new_service.md` is the authoritative checklist. In short: create `fsXxx.ts` + `settingsXxx.ts`, add the config type to `baseTypesPro.ts` and to `DEFAULT_SETTINGS`/`RemotelySavePluginSettings` in `main.ts`, register OAuth protocol handler + expiry notice in `main.ts`, add langs and CSS, wire into `settings.ts` (config/chooser/import-export), `importExport.ts`, `fsGetter.ts`, the PRO check in `sync.ts`, `configPersist.test.ts`, and the README/docs.
