# Sweet Shelf — Architecture

Notes for contributors and the curious. The user-facing pitch lives in [README.md](./README.md); this file is the engineering view.

## Project layout

```
src/
  extension.ts              entrypoint — activate / deactivate
  shelf/
    types.ts                ShelfNode, ShelfConfig, Category, refs, ColorLabel re-export
    store.ts                in-memory state + persistence + every mutator
    treeProvider.ts         TreeDataProvider + async getChildren + getParent
    categories.ts           pure tree ops over CategoryChild
    folderEntries.ts        pure: read directory, sort, filter, cap (Task 4)
    favorites.ts            pure: favorites view + drift cleanup (Task 6)
    recent.ts               pure: recent view (sort by lastOpenedAt)
    focus.ts                pure: resolve focusedItemId
    color.ts                pure: ColorLabel enum + theme color mapping
    brokenLinks.ts          BrokenLinkCache (lazy stat + onDidUpdate)
    search.ts               pure: SearchableItem, parseQuery, applyFilters
    migrate.ts              pure: import-time version dispatch seam
    exportImport.ts         pure: buildExport (mode-scrub) + summarize
    labels.ts               pure: display name + extension stripping
    disambiguation.ts       pure: contextual breadcrumb algorithm
    paths.ts                pure: canonicalization + uniqueness check
  config/
    schema.ts               kind-dispatch validator
    paths.ts                shelf.json path resolution
  commands/
    index.ts                wires every command
    categories.ts           category command handlers
    files.ts                file command handlers
    folders.ts              folder command handlers
    folderEntries.ts        Add to Sweet Shelf from inline browse
    aliases.ts              rename / clear display name
    favorites.ts            add / remove / move favorite
    recent.ts               remove from / clear Recent
    focus.ts                Focus on this / Show All
    color.ts                set / clear color (kind-agnostic, 8 commands)
    renameOnDisk.ts         rename file/folder on disk (atomic)
    brokenLinks.ts          locate again / reveal parent / copy missing / validate
    search.ts               Quick Pick + filter syntax
    exportImport.ts         export shelf / import (replace + backup)
    shared.ts               reveal in OS, copy path
  ui/
    dragAndDrop.ts          drag-and-drop controller
    decorations.ts          FileDecorationProvider (broken / color / favorite)
    prompts.ts              input box helpers with validation
    quickPicks.ts           category picker for "where should this go?"
  util/
    debounce.ts             trailing-edge debounce
    grammar.ts              kind-aware count phrases
    logger.ts               Sweet Shelf output channel
```

## Architectural principles

### Single source of truth in `ShelfStore`

Every mutation flows through `ShelfStore`. The store owns state, fires `onDidChange`, and persists via debounced JSON writes. The tree provider, decoration provider, and command handlers all read from it; nothing else owns shelf state.

### Derived views, never duplicated storage

Favorites and Recent are computed from Library on every render. A favorited file lives once — in Library, with `favoritedAt` set; the Favorites section just *surfaces* it. Removing from Library auto-removes from Favorites and Recent (cascade in the store's remove paths). No sync logic, no possibility of drift.

### Discriminated union for `ShelfNode`

The tree provider walks one type:

```ts
type ShelfNode =
  | { kind: "section"; ... }
  | { kind: "category"; ... }
  | { kind: "file"; ... }
  | { kind: "folder"; ... }
  | { kind: "favoritesEntry"; ... }
  | { kind: "recentEntry"; ... }
  | { kind: "folderEntry"; ... }       // view-only, never persisted
  | { kind: "folderEntryError"; ... }
  | { kind: "folderEntryOverflow"; ... }
  | { kind: "focusHeader"; ... }
  | { kind: "empty"; ... };
```

Every `getTreeItem` and `getChildren` branch is a `switch (node.kind)` with exhaustive checks via `assertNever`. Adding a variant fails the type-checker until every site handles it. View-only variants (folderEntry family, focusHeader) never enter the persisted store; the schema validator's "unknown child kind" error backstops accidental persistence.

### Pure modules in `shelf/`

Anything in `src/shelf/` other than `store.ts` and `treeProvider.ts` is pure (no `import * as vscode`). Examples: `categories.ts`, `disambiguation.ts`, `search.ts`, `migrate.ts`. The store wraps these with state and events; commands wire them to UI. This separation makes the data layer testable in isolation and keeps editor concerns out of business logic.

### Decoration provider as the visual signal layer

Files and folders compose three signals — broken, color, favorite — into a single `FileDecoration` per URI. Priority: broken wins (muted ⚠), otherwise ★ (when favorited) tinted with the color label (or `charts.yellow` as the default favorite color). Categories don't have URIs, so they tint via `ThemeIcon` color directly in the tree provider.

### Atomic mutations

- `renameFileOnDisk` / `renameFolderOnDisk`: `vscode.workspace.fs.rename` first; on failure, store stays untouched. Folder rename also rewrites path prefixes on every shelved descendant in one synchronous pass.
- `replaceConfig` (import path): replaces in-memory state, fires the change event, awaits a forced flush past the debounce.
- `removeCategory` / `removeFile` / `removeFolder`: cascade-clean `favoritesOrder` and trigger focus auto-exit if the focused item was carried out.

### Typed errors for distinguished conditions

- `AlreadyOnShelfError` carries the existing ref + parent label so the OS-drop loop can count duplicates separately from real failures.
- The migration seam returns `{ ok: true } | { ok: false; reason }` so the import command can show a specific user-facing message.

### `_xxxDefault` internal dispatchers

Click commands on TreeItems route through underscore-prefixed dispatchers (`_openFileDefault`, `_openFolderDefault`, `_brokenClick`) that read the active settings and delegate. Hidden from the Command Palette via `when: false`. The settings stay one-line lookups; the menu commands stay single-purpose.

### Config schema with version field

`shelf.json` carries a `version: 1` field. Future incompatible schema changes bump it; [`src/shelf/migrate.ts`](./src/shelf/migrate.ts) is the only path through which import data reaches the validator and is the natural home for migration steps.

## Build and dev workflow

```bash
npm install
npm run compile     # type-check + lint + esbuild
npm run watch       # watch mode (esbuild + tsc parallel)
```

Press `F5` in VS Code to launch the Extension Development Host with the built extension.

State persists at `context.globalStorageUri/shelf.json`. Use **Sweet Shelf: Reveal Config File** to inspect the live config in your OS file manager.

## Settings reference

| Key | Default | Purpose |
| --- | --- | --- |
| `sweetShelf.confirmRemoveCategory` | `true` | Modal before removing a non-empty category |
| `sweetShelf.defaultFileClickAction` | `"open"` | `open` or `openToSide` |
| `sweetShelf.defaultFolderClickAction` | `"browse"` | `browse` (inline) / `openInCurrentWindow` / `openInNewWindow` |
| `sweetShelf.showHiddenFiles` | `false` | Show dotfiles in inline browse |
| `sweetShelf.showFileExtensions` | `true` | Show `.md`/`.ts`/etc. in shelf labels |
| `sweetShelf.maxRecentItems` | `20` | Cap on Recent section (1–100) |

## Publishing

See [PUBLISHING.md](./PUBLISHING.md) for the marketplace publish flow and pre-publish checklist.
