import { randomUUID } from "node:crypto";
import * as nodePath from "node:path";
import * as vscode from "vscode";

import {
  cloneDefault,
  parseShelfConfig,
  serializeShelfConfig,
} from "../config/schema";
import { resolveShelfPaths, type ShelfPaths } from "../config/paths";
import { debounce, type Debounced } from "../util/debounce";
import { logError, logWarn } from "../util/logger";
import type { BrokenLinkCache } from "./brokenLinks";
import type { ColorLabel } from "./color";
import {
  findCategory,
  findChild,
  findContainer,
  findParent,
  insertCategory,
  insertChild,
  isSelfOrDescendant,
  makeCategory,
  makeFileRef,
  makeFolderRef,
  removeChildById,
  walkAll,
} from "./categories";
import {
  canonicalizePath,
  findExistingReferenceByPath,
  isDescendantPath,
  pathsEqual,
} from "./paths";
import { resolveFocus, type FocusedItem } from "./focus";
import {
  AlreadyOnShelfError,
  MAX_CATEGORY_LABEL_LENGTH,
  type Category,
  type CategoryChild,
  type Favorite,
  type FileRef,
  type FolderRef,
  type ShelfConfig,
} from "./types";

const WRITE_DEBOUNCE_MS = 200;
/**
 * Watcher events fired within this window after an internal write are
 * treated as the OS echo of that write and ignored. Set comfortably
 * above the slowest fsync we expect; cross-window mutations land far
 * outside this window in practice.
 */
const EXTERNAL_CHANGE_ECHO_WINDOW_MS = 1000;

/**
 * Outcome of `ShelfStore.load`. Surfaced so the extension entrypoint can
 * decide whether to nudge the user (e.g. corrupt config -> warning toast).
 */
export type LoadOutcome =
  | { kind: "loaded"; warnings: string[] }
  | { kind: "created-default" }
  | { kind: "recovered-from-invalid"; error: string }
  | { kind: "storage-unavailable"; error: string };

/**
 * Single source of truth for shelf state.
 *
 * Holds the current `ShelfConfig` in memory, persists changes (debounced)
 * to disk, and fires `onDidChange` whenever observable state mutates. The
 * tree provider listens to this event and refreshes accordingly.
 *
 * Mutations go through this class only — never edit the config object
 * directly from outside, since bypassing the store skips both the change
 * event and the persistence write.
 */
export class ShelfStore implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  /** Fires whenever the in-memory config mutates. */
  readonly onDidChange: vscode.Event<void> = this._onDidChange.event;

  private state: ShelfConfig = cloneDefault();
  private readonly paths: ShelfPaths;
  private readonly scheduleWrite: Debounced<readonly []>;
  private storageAvailable = true;
  private pendingWrite: Promise<void> | undefined;
  private brokenLinks: BrokenLinkCache | undefined;
  private fileWatcher: vscode.FileSystemWatcher | undefined;
  private fileWatcherSubscriptions: vscode.Disposable[] = [];
  /**
   * Last time *this* process wrote shelf.json. Watcher events fired
   * within a short window of an internal write are assumed to be the
   * echo of our own write and skipped — anything later is treated as
   * an external mutation from another VS Code window and reloaded.
   */
  private lastInternalWriteAt = 0;

  /**
   * @param globalStorageUri The extension's `context.globalStorageUri`.
   *        File I/O is rooted here.
   */
  constructor(globalStorageUri: vscode.Uri) {
    this.paths = resolveShelfPaths(globalStorageUri);
    this.scheduleWrite = debounce(() => {
      this.pendingWrite = this.flushToDisk().finally(() => {
        this.pendingWrite = undefined;
      });
    }, WRITE_DEBOUNCE_MS);
  }

  /**
   * Inject the broken-link cache. Wired in `extension.activate` after
   * the cache is constructed. Path mutations (add, rename, remove,
   * locate-again) call into the cache to keep its known-good /
   * known-broken entries in sync without re-statting on every render.
   */
  setBrokenLinkCache(cache: BrokenLinkCache): void {
    this.brokenLinks = cache;
  }

  /** Read-only snapshot of current state. Treat the result as immutable. */
  get config(): Readonly<ShelfConfig> {
    return this.state;
  }

  /** Read-only snapshot of the Library forest (top-level categories). */
  get library(): readonly Category[] {
    return this.state.library;
  }

  /** Read-only snapshot of the favorites list, in user-orderable sequence. */
  get favorites(): readonly Favorite[] {
    return this.state.favorites;
  }

  /** On-disk location of the config file (for the reveal command). */
  get configFileUri(): vscode.Uri {
    return this.paths.configFile;
  }

  /**
   * Load state from disk. Creates a default config file if missing,
   * backs up and replaces the file if it is corrupt, and falls back to
   * in-memory defaults if the storage directory itself is unavailable.
   *
   * Always leaves the store in a usable state; the returned `LoadOutcome`
   * just describes what happened so callers can show a toast.
   */
  async load(): Promise<LoadOutcome> {
    try {
      await vscode.workspace.fs.createDirectory(this.paths.storageDir);
    } catch (err) {
      this.storageAvailable = false;
      this.state = cloneDefault();
      logError("creating storage directory", err);
      return {
        kind: "storage-unavailable",
        error: err instanceof Error ? err.message : String(err),
      };
    }

    let raw: string;
    try {
      const bytes = await vscode.workspace.fs.readFile(this.paths.configFile);
      raw = new TextDecoder("utf-8").decode(bytes);
    } catch {
      // Missing file is the expected first-run case — write defaults.
      this.state = cloneDefault();
      await this.flushToDisk();
      return { kind: "created-default" };
    }

    const result = parseShelfConfig(raw);
    if (result.ok) {
      this.state = result.value;
      if (result.warnings.length > 0) {
        await this.flushToDisk();
      }
      return { kind: "loaded", warnings: result.warnings };
    }

    try {
      await vscode.workspace.fs.writeFile(
        this.paths.backupFile,
        new TextEncoder().encode(raw),
      );
    } catch (err) {
      logError("writing shelf.json.bak", err);
    }
    this.state = result.value;
    await this.flushToDisk();
    return { kind: "recovered-from-invalid", error: result.error };
  }

  /**
   * Install a watcher on shelf.json so a second VS Code window
   * mutating the file picks up the change in this window without a
   * reload. Call after `load()` so the watcher starts armed against
   * the post-load state. Writes from this process are filtered out
   * by `lastInternalWriteAt`.
   */
  startWatching(): void {
    if (!this.storageAvailable || this.fileWatcher) {
      return;
    }
    const pattern = new vscode.RelativePattern(
      this.paths.storageDir,
      "shelf.json",
    );
    this.fileWatcher = vscode.workspace.createFileSystemWatcher(
      pattern,
      /* ignoreCreate */ false,
      /* ignoreChange */ false,
      /* ignoreDelete */ true,
    );
    const onEvent = () => {
      void this.handleExternalChange();
    };
    this.fileWatcherSubscriptions.push(
      this.fileWatcher.onDidChange(onEvent),
      this.fileWatcher.onDidCreate(onEvent),
    );
  }

  /**
   * Reload state from disk after another window wrote shelf.json.
   * Skipped when the event is the echo of our own recent write or
   * when a write is in flight (the in-flight write is our truth).
   */
  private async handleExternalChange(): Promise<void> {
    const sinceInternal = Date.now() - this.lastInternalWriteAt;
    if (sinceInternal < EXTERNAL_CHANGE_ECHO_WINDOW_MS) {
      return;
    }
    if (this.pendingWrite) {
      return;
    }
    try {
      const bytes = await vscode.workspace.fs.readFile(this.paths.configFile);
      const raw = new TextDecoder("utf-8").decode(bytes);
      if (raw === serializeShelfConfig(this.state)) {
        // Identical content — nothing for us to refresh.
        return;
      }
      const result = parseShelfConfig(raw);
      if (!result.ok) {
        logWarn(
          `external shelf.json change was unparseable: ${result.error}. Keeping current state.`,
        );
        return;
      }
      this.state = result.value;
      this._onDidChange.fire();
    } catch (err) {
      logError("reloading shelf.json after external change", err);
    }
  }

  /* ─────────────── Lookups ─────────────── */

  /** Look up a category by id. */
  findCategory(id: string): Category | undefined {
    return findCategory(this.state.library, id);
  }

  /** Look up a file ref by id. Returns undefined for non-file ids. */
  findFile(id: string): FileRef | undefined {
    const child = findChild(this.state.library, id);
    return child && child.kind === "file" ? child : undefined;
  }

  /** Look up a folder ref by id. Returns undefined for non-folder ids. */
  findFolder(id: string): FolderRef | undefined {
    const child = findChild(this.state.library, id);
    return child && child.kind === "folder" ? child : undefined;
  }

  /** Look up any child by id, regardless of kind. */
  findAnyChild(id: string): CategoryChild | undefined {
    return findChild(this.state.library, id);
  }

  /**
   * Look up a file or folder ref by id. Returns undefined for
   * categories or unknown ids. Used by Search and any other surface
   * that needs to resolve a Library-ref id to its concrete data.
   */
  findRefById(id: string): FileRef | FolderRef | undefined {
    const child = findChild(this.state.library, id);
    if (!child || child.kind === "category") {
      return undefined;
    }
    return child;
  }

  /**
   * Look up a category's parent. `parent` is `null` when the category
   * lives at the Library root. Returns `undefined` if the id doesn't
   * exist or names a non-category.
   */
  getCategoryParent(
    id: string,
  ): { parent: Category | null; index: number } | undefined {
    return findParent(this.state.library, id);
  }

  /**
   * Look up the parent category of a file or folder. Always returns a
   * non-null parent for valid file/folder ids since refs cannot live at
   * the section root.
   */
  getRefParent(id: string): { parent: Category; index: number } | undefined {
    const result = findContainer(this.state.library, id);
    if (!result || !result.parent) {
      return undefined;
    }
    if (result.child.kind === "category") {
      return undefined;
    }
    return { parent: result.parent, index: result.index };
  }

  /**
   * Closest ancestor shelved folder's color label for an arbitrary
   * on-disk path, if any. Used by the tree provider to tint inline-
   * browsed folder icons so a colored folder's whole subtree reads as
   * one visual bucket. Returns `undefined` when the path itself is
   * a shelved ref (callers handle the own-color case separately) or
   * when no colored ancestor exists.
   */
  inheritedColorForPath(path: string): ColorLabel | undefined {
    let best: ColorLabel | undefined;
    let bestLen = -1;
    for (const node of walkAll(this.state.library)) {
      if (node.kind !== "folder" || node.colorLabel === undefined) {
        continue;
      }
      if (pathsEqual(node.path, path)) {
        continue;
      }
      if (
        isDescendantPath(path, node.path) &&
        node.path.length > bestLen
      ) {
        best = node.colorLabel;
        bestLen = node.path.length;
      }
    }
    return best;
  }

  /* ─────────────── Category mutators ─────────────── */

  /**
   * Create a new category and append it under `parentId` (or at root).
   * Returns the created category so the caller can reveal/select it.
   */
  createCategory(parentId: string | null, label: string): Category {
    const trimmed = label.trim();
    if (trimmed.length === 0) {
      throw new Error("Category name can't be empty.");
    }
    if (trimmed.length > MAX_CATEGORY_LABEL_LENGTH) {
      throw new Error(
        `Category names are capped at ${MAX_CATEGORY_LABEL_LENGTH} characters.`,
      );
    }
    if (parentId !== null && !this.findCategory(parentId)) {
      throw new Error("Parent category no longer exists.");
    }
    const category = makeCategory(trimmed);
    insertCategory(this.state.library, parentId, category);
    this.notifyChanged();
    return category;
  }

  /**
   * Rename a category. No-op if the new label (after trim) is identical
   * to the current label. Throws on empty or too-long input.
   */
  renameCategory(id: string, newLabel: string): void {
    const trimmed = newLabel.trim();
    if (trimmed.length === 0) {
      throw new Error("Category name can't be empty.");
    }
    if (trimmed.length > MAX_CATEGORY_LABEL_LENGTH) {
      throw new Error(
        `Category names are capped at ${MAX_CATEGORY_LABEL_LENGTH} characters.`,
      );
    }
    const target = this.findCategory(id);
    if (!target) {
      throw new Error("That category is no longer on the shelf.");
    }
    if (target.label === trimmed) {
      return;
    }
    target.label = trimmed;
    target.updatedAt = new Date().toISOString();
    this.notifyChanged();
  }

  /** Remove a category and its entire subtree. No-op if the id is unknown. */
  removeCategory(id: string): void {
    const focusedLabelBefore = this.snapshotFocusedLabel();
    const removed = removeChildById(this.state.library, id);
    if (!removed) {
      return;
    }
    // Cascade favorites: any favorite whose path is at or under any
    // descendant file/folder of the removed subtree gets dropped.
    if (removed.kind === "category") {
      const descendantPaths = collectRefPaths(removed);
      for (const path of descendantPaths) {
        this.dropFavoritesAtOrUnder(path, /* prefixOnly */ false);
      }
    } else if (removed.kind === "file") {
      this.dropFavoritesAtOrUnder(removed.path, /* prefixOnly */ true);
    } else if (removed.kind === "folder") {
      this.dropFavoritesAtOrUnder(removed.path, /* prefixOnly */ false);
    }
    this.maybeNotifyFocusExit(focusedLabelBefore);
    this.notifyChanged();
  }

  /**
   * Move a category to a new parent and position. Silently no-ops on
   * unknown id, cycle, or same-slot moves.
   */
  moveCategory(
    id: string,
    newParentId: string | null,
    newIndex: number,
  ): void {
    const source = this.findCategory(id);
    if (!source) {
      return;
    }
    if (newParentId !== null) {
      if (newParentId === id) {
        return;
      }
      if (isSelfOrDescendant(source, newParentId)) {
        return;
      }
      if (!this.findCategory(newParentId)) {
        return;
      }
    }

    const currentParentInfo = this.getCategoryParent(id);
    if (!currentParentInfo) {
      return;
    }
    const currentParentId = currentParentInfo.parent
      ? currentParentInfo.parent.id
      : null;

    const destSiblings: CategoryChild[] =
      newParentId === null
        ? this.state.library
        : (this.findCategory(newParentId) as Category).children;

    const removed = removeChildById(this.state.library, id);
    if (!removed) {
      return;
    }

    let targetIndex = Math.max(0, Math.min(newIndex, destSiblings.length));
    if (
      currentParentId === newParentId &&
      currentParentInfo.index < targetIndex
    ) {
      targetIndex = Math.max(0, targetIndex - 1);
    }

    destSiblings.splice(targetIndex, 0, removed);
    if (removed.kind === "category") {
      removed.updatedAt = new Date().toISOString();
    }
    this.notifyChanged();
  }

  /* ─────────────── File/folder mutators ─────────────── */

  /**
   * Add a file reference to a category. Throws on invalid input or when
   * the same path is already on the shelf (`AlreadyOnShelfError`). The
   * stored path is the canonicalized absolute form.
   */
  addFile(parentCategoryId: string, absolutePath: string): FileRef {
    if (!nodePath.isAbsolute(absolutePath)) {
      throw new Error("Sweet Shelf needs an absolute path.");
    }
    const parent = this.findCategory(parentCategoryId);
    if (!parent) {
      throw new Error("That category is no longer on the shelf.");
    }
    const canonical = canonicalizePath(absolutePath);
    const existing = findExistingReferenceByPath(this.state.library, canonical);
    if (existing) {
      throw new AlreadyOnShelfError(existing.ref, existing.parentLabel);
    }
    const ref = makeFileRef(canonical);
    insertChild(parent, ref);
    this.brokenLinks?.markAsExisting(canonical);
    this.notifyChanged();
    return ref;
  }

  /**
   * Add a folder reference to a category. Same semantics as `addFile`.
   */
  addFolder(parentCategoryId: string, absolutePath: string): FolderRef {
    if (!nodePath.isAbsolute(absolutePath)) {
      throw new Error("Sweet Shelf needs an absolute path.");
    }
    const parent = this.findCategory(parentCategoryId);
    if (!parent) {
      throw new Error("That category is no longer on the shelf.");
    }
    const canonical = canonicalizePath(absolutePath);
    const existing = findExistingReferenceByPath(this.state.library, canonical);
    if (existing) {
      throw new AlreadyOnShelfError(existing.ref, existing.parentLabel);
    }
    const ref = makeFolderRef(canonical);
    insertChild(parent, ref);
    this.brokenLinks?.markAsExisting(canonical);
    this.notifyChanged();
    return ref;
  }

  /** Remove a file reference. No-op if the id is unknown or not a file. */
  removeFile(id: string): void {
    const ref = this.findFile(id);
    if (!ref) {
      return;
    }
    const focusedLabelBefore = this.snapshotFocusedLabel();
    const path = ref.path;
    removeChildById(this.state.library, id);
    this.dropFavoritesAtOrUnder(path, /* prefixOnly */ true);
    this.brokenLinks?.invalidate(path);
    this.maybeNotifyFocusExit(focusedLabelBefore);
    this.notifyChanged();
  }

  /** Remove a folder reference. No-op if the id is unknown or not a folder. */
  removeFolder(id: string): void {
    const ref = this.findFolder(id);
    if (!ref) {
      return;
    }
    const focusedLabelBefore = this.snapshotFocusedLabel();
    const path = ref.path;
    removeChildById(this.state.library, id);
    // Folder removal cascades: any favorite at-or-under the removed
    // folder's path is dropped, since the folder no longer anchors
    // anything in Library.
    this.dropFavoritesAtOrUnder(path, /* prefixOnly */ false);
    this.brokenLinks?.invalidate(path);
    this.maybeNotifyFocusExit(focusedLabelBefore);
    this.notifyChanged();
  }

  /**
   * Move a file reference to a different category. `newIndex` clamps to
   * the destination's children length so callers can pass
   * `Number.MAX_SAFE_INTEGER` for "append".
   */
  moveFile(id: string, newParentCategoryId: string, newIndex: number): void {
    this.moveRef("file", id, newParentCategoryId, newIndex);
  }

  /** Move a folder reference. Same semantics as `moveFile`. */
  moveFolder(id: string, newParentCategoryId: string, newIndex: number): void {
    this.moveRef("folder", id, newParentCategoryId, newIndex);
  }

  private moveRef(
    expectedKind: "file" | "folder",
    id: string,
    newParentCategoryId: string,
    newIndex: number,
  ): void {
    const child = findChild(this.state.library, id);
    if (!child || child.kind !== expectedKind) {
      return;
    }
    const dest = this.findCategory(newParentCategoryId);
    if (!dest) {
      return;
    }
    const currentInfo = findContainer(this.state.library, id);
    if (!currentInfo || !currentInfo.parent) {
      return;
    }
    const sameParent = currentInfo.parent.id === newParentCategoryId;

    const removed = removeChildById(this.state.library, id);
    if (!removed) {
      return;
    }
    let targetIndex = Math.max(0, Math.min(newIndex, dest.children.length));
    if (sameParent && currentInfo.index < targetIndex) {
      targetIndex = Math.max(0, targetIndex - 1);
    }
    dest.children.splice(targetIndex, 0, removed);
    if (removed.kind === "file" || removed.kind === "folder") {
      removed.updatedAt = new Date().toISOString();
    }
    this.notifyChanged();
  }

  /**
   * Set a display alias on a file ref. Validates non-empty / length
   * (matches the schema rules). No-op when the trimmed alias matches
   * the current alias.
   */
  setFileAlias(id: string, alias: string): void {
    this.setRefAlias("file", id, alias);
  }

  /** Clear a file ref's alias, reverting to basename + auto-disambiguation. */
  clearFileAlias(id: string): void {
    this.clearRefAlias("file", id);
  }

  /** Set a display alias on a folder ref. */
  setFolderAlias(id: string, alias: string): void {
    this.setRefAlias("folder", id, alias);
  }

  /** Clear a folder ref's alias. */
  clearFolderAlias(id: string): void {
    this.clearRefAlias("folder", id);
  }

  private setRefAlias(
    expectedKind: "file" | "folder",
    id: string,
    alias: string,
  ): void {
    const trimmed = alias.trim();
    if (trimmed.length === 0) {
      throw new Error("Display name can't be empty.");
    }
    if (trimmed.length > MAX_CATEGORY_LABEL_LENGTH) {
      throw new Error(
        `Display names are capped at ${MAX_CATEGORY_LABEL_LENGTH} characters.`,
      );
    }
    const child = findChild(this.state.library, id);
    if (!child || child.kind !== expectedKind) {
      throw new Error(`That ${expectedKind} is no longer on the shelf.`);
    }
    if (child.alias === trimmed) {
      return;
    }
    child.alias = trimmed;
    child.updatedAt = new Date().toISOString();
    this.notifyChanged();
  }

  private clearRefAlias(
    expectedKind: "file" | "folder",
    id: string,
  ): void {
    const child = findChild(this.state.library, id);
    if (!child || child.kind !== expectedKind) {
      return;
    }
    if (child.alias === undefined) {
      return;
    }
    delete child.alias;
    child.updatedAt = new Date().toISOString();
    this.notifyChanged();
  }

  /**
   * Stamp `lastOpenedAt` on the file or folder with `id`. No-op for
   * unknown ids or category ids.
   */
  recordOpened(id: string): void {
    const child = findChild(this.state.library, id);
    if (!child || child.kind === "category") {
      return;
    }
    child.lastOpenedAt = new Date().toISOString();
    this.notifyChanged();
  }

  /** Clear `lastOpenedAt` on a single ref (Recent's "Remove from Recent"). */
  clearLastOpened(id: string): void {
    const child = findChild(this.state.library, id);
    if (!child || child.kind === "category") {
      return;
    }
    if (child.lastOpenedAt === undefined) {
      return;
    }
    delete child.lastOpenedAt;
    this.notifyChanged();
  }

  /** Walk Library and clear every `lastOpenedAt`. Backs the "Clear Recent" command. */
  clearAllRecent(): void {
    let changed = false;
    for (const node of walkAll(this.state.library)) {
      if (node.kind === "category") {
        continue;
      }
      if (node.lastOpenedAt !== undefined) {
        delete node.lastOpenedAt;
        changed = true;
      }
    }
    if (changed) {
      this.notifyChanged();
    }
  }

  /* ─────────────── Favorites ─────────────── */

  /**
   * Add a path to Favorites. No-op if the path is already favorited
   * (case-insensitive on macOS / Windows). Returns the new (or
   * existing) `Favorite`.
   */
  addFavorite(absolutePath: string, kind: "file" | "folder"): Favorite {
    if (!nodePath.isAbsolute(absolutePath)) {
      throw new Error("Sweet Shelf needs an absolute path.");
    }
    const canonical = canonicalizePath(absolutePath);
    const existing = this.findFavoriteByPath(canonical);
    if (existing) {
      return existing;
    }
    const fav: Favorite = {
      id: randomUUID(),
      kind,
      path: canonical,
      favoritedAt: new Date().toISOString(),
    };
    this.state.favorites.push(fav);
    this.brokenLinks?.markAsExisting(canonical);
    this.notifyChanged();
    return fav;
  }

  /**
   * Remove the favorite at the given path. No-op if no entry matches.
   * Returns `true` when something was removed.
   */
  removeFavoriteByPath(absolutePath: string): boolean {
    const canonical = canonicalizePath(absolutePath);
    const idx = this.state.favorites.findIndex((f) =>
      pathsEqual(f.path, canonical),
    );
    if (idx === -1) {
      return false;
    }
    this.state.favorites.splice(idx, 1);
    this.notifyChanged();
    return true;
  }

  /** True if `path` is currently favorited. */
  isFavoritedPath(path: string): boolean {
    return this.findFavoriteByPath(path) !== undefined;
  }

  /** Find the favorite at `path`, if any. */
  findFavoriteByPath(path: string): Favorite | undefined {
    for (const fav of this.state.favorites) {
      if (pathsEqual(fav.path, path)) {
        return fav;
      }
    }
    return undefined;
  }

  /** Find a favorite by its id. */
  findFavoriteById(id: string): Favorite | undefined {
    return this.state.favorites.find((f) => f.id === id);
  }

  /** Move a favorite one slot up or down. */
  moveFavorite(id: string, direction: "up" | "down"): void {
    const idx = this.state.favorites.findIndex((f) => f.id === id);
    if (idx === -1) {
      return;
    }
    this.moveFavoriteTo(id, idx + (direction === "up" ? -1 : 1));
  }

  /**
   * Move a favorite to a specific index. Clamps to bounds and
   * accounts for the same-array index shift (matches `moveCategory`).
   */
  moveFavoriteTo(id: string, newIndex: number): void {
    const list = this.state.favorites;
    const currentIdx = list.findIndex((f) => f.id === id);
    if (currentIdx === -1) {
      return;
    }
    const clamped = Math.max(0, Math.min(newIndex, list.length));
    let target = clamped;
    if (clamped > currentIdx) {
      target = clamped - 1;
    }
    if (target === currentIdx) {
      return;
    }
    const [moved] = list.splice(currentIdx, 1);
    list.splice(target, 0, moved);
    this.notifyChanged();
  }

  /**
   * Set the favorite's display alias. No-op when the trimmed value
   * matches the current alias.
   */
  setFavoriteAlias(id: string, alias: string): void {
    const trimmed = alias.trim();
    if (trimmed.length === 0) {
      throw new Error("Display name can't be empty.");
    }
    if (trimmed.length > MAX_CATEGORY_LABEL_LENGTH) {
      throw new Error(
        `Display names are capped at ${MAX_CATEGORY_LABEL_LENGTH} characters.`,
      );
    }
    const fav = this.findFavoriteById(id);
    if (!fav) {
      throw new Error("That favorite is no longer on the shelf.");
    }
    if (fav.alias === trimmed) {
      return;
    }
    fav.alias = trimmed;
    this.notifyChanged();
  }

  /** Clear the favorite's alias. */
  clearFavoriteAlias(id: string): void {
    const fav = this.findFavoriteById(id);
    if (!fav || fav.alias === undefined) {
      return;
    }
    delete fav.alias;
    this.notifyChanged();
  }

  /**
   * Re-point a favorite at a different path. Mirrors `locateAgain`
   * for Library refs; used by the broken-link recovery flow when a
   * favorite's path goes missing on disk.
   */
  relocateFavorite(id: string, newAbsolutePath: string): void {
    const fav = this.findFavoriteById(id);
    if (!fav) {
      throw new Error("That favorite is no longer on the shelf.");
    }
    if (!nodePath.isAbsolute(newAbsolutePath)) {
      throw new Error("Sweet Shelf needs an absolute path.");
    }
    const newPath = canonicalizePath(newAbsolutePath);
    if (pathsEqual(fav.path, newPath)) {
      return;
    }
    const oldPath = fav.path;
    fav.path = newPath;
    this.brokenLinks?.invalidate(oldPath);
    this.brokenLinks?.markAsExisting(newPath);
    this.notifyChanged();
  }

  /** Set / clear color tint on a favorite. */
  setFavoriteColorLabel(id: string, color: ColorLabel): void {
    const fav = this.findFavoriteById(id);
    if (!fav || fav.colorLabel === color) {
      return;
    }
    fav.colorLabel = color;
    this.notifyChanged();
  }
  clearFavoriteColorLabel(id: string): void {
    const fav = this.findFavoriteById(id);
    if (!fav || fav.colorLabel === undefined) {
      return;
    }
    delete fav.colorLabel;
    this.notifyChanged();
  }

  /**
   * Cascade helper: remove favorites whose path matches (or, when
   * `prefixOnly` is false, is at-or-under) `absolutePath`. Used by
   * `removeFile` / `removeFolder` / `removeCategory` to keep favorites
   * coherent when the underlying Library scaffolding goes away.
   *
   * `prefixOnly === true` → exact-path match only (for file refs).
   * `prefixOnly === false` → exact match OR descendants (for folder refs).
   */
  private dropFavoritesAtOrUnder(
    absolutePath: string,
    prefixOnly: boolean,
  ): void {
    if (this.state.favorites.length === 0) {
      return;
    }
    const before = this.state.favorites.length;
    this.state.favorites = this.state.favorites.filter((fav) => {
      if (pathsEqual(fav.path, absolutePath)) {
        return false;
      }
      if (!prefixOnly && isDescendantPath(fav.path, absolutePath)) {
        return false;
      }
      return true;
    });
    if (this.state.favorites.length !== before) {
      // notifyChanged is fired by the calling mutator.
    }
  }

  /**
   * Cascade helper: rewrite favorite paths after a Library
   * rename-on-disk. `oldPrefix` and `newPrefix` are canonicalized
   * absolute paths.
   */
  private rewriteFavoritePathPrefix(
    oldPrefix: string,
    newPrefix: string,
  ): void {
    if (this.state.favorites.length === 0) {
      return;
    }
    for (const fav of this.state.favorites) {
      const rewritten = rewritePathPrefix(fav.path, oldPrefix, newPrefix);
      if (rewritten !== fav.path) {
        this.brokenLinks?.invalidate(fav.path);
        fav.path = rewritten;
        this.brokenLinks?.markAsExisting(rewritten);
      }
    }
  }

  /* ─────────────── Color labels ─────────────── */

  /** Set or clear the color tint on a file ref. Same pattern across kinds. */
  setFileColorLabel(id: string, color: ColorLabel): void {
    this.setRefColor("file", id, color);
  }
  clearFileColorLabel(id: string): void {
    this.clearRefColor("file", id);
  }
  setFolderColorLabel(id: string, color: ColorLabel): void {
    this.setRefColor("folder", id, color);
  }
  clearFolderColorLabel(id: string): void {
    this.clearRefColor("folder", id);
  }
  setCategoryColorLabel(id: string, color: ColorLabel): void {
    const cat = this.findCategory(id);
    if (!cat) {
      return;
    }
    if (cat.colorLabel === color) {
      return;
    }
    cat.colorLabel = color;
    cat.updatedAt = new Date().toISOString();
    this.notifyChanged();
  }
  clearCategoryColorLabel(id: string): void {
    const cat = this.findCategory(id);
    if (!cat || cat.colorLabel === undefined) {
      return;
    }
    delete cat.colorLabel;
    cat.updatedAt = new Date().toISOString();
    this.notifyChanged();
  }

  private setRefColor(
    expectedKind: "file" | "folder",
    id: string,
    color: ColorLabel,
  ): void {
    const child = findChild(this.state.library, id);
    if (!child || child.kind !== expectedKind) {
      return;
    }
    if (child.colorLabel === color) {
      return;
    }
    child.colorLabel = color;
    child.updatedAt = new Date().toISOString();
    this.notifyChanged();
  }

  private clearRefColor(
    expectedKind: "file" | "folder",
    id: string,
  ): void {
    const child = findChild(this.state.library, id);
    if (!child || child.kind !== expectedKind) {
      return;
    }
    if (child.colorLabel === undefined) {
      return;
    }
    delete child.colorLabel;
    child.updatedAt = new Date().toISOString();
    this.notifyChanged();
  }

  /* ─────────────── Rename on disk + Locate Again ─────────────── */

  /**
   * Rename a file on disk. Atomic: the rename runs first; if it
   * fails, the store stays untouched. On success we update `path`
   * and `label` (basename of the new path); aliases are intentionally
   * untouched per Task 7's product principle.
   *
   * Throws on validation failure, on `vscode.workspace.fs.rename`
   * failure, or when the target name already exists in the same
   * directory. Command handler catches and toasts.
   */
  async renameFileOnDisk(id: string, newName: string): Promise<void> {
    const ref = this.findFile(id);
    if (!ref) {
      throw new Error("That file is no longer on the shelf.");
    }
    const oldPath = ref.path;
    const validation = validateNewName(newName, nodePath.basename(oldPath));
    if (validation) {
      throw new Error(validation);
    }
    const newPath = canonicalizePath(
      nodePath.join(nodePath.dirname(oldPath), newName),
    );
    await this.runRename(oldPath, newPath);
    // Atomic store update — synchronous string operations, won't throw.
    ref.path = newPath;
    ref.label = nodePath.basename(newPath);
    ref.updatedAt = new Date().toISOString();
    // Cascade favorites: a favorite at the old path follows the rename.
    this.rewriteFavoritePathPrefix(oldPath, newPath);
    this.brokenLinks?.invalidate(oldPath);
    this.brokenLinks?.markAsExisting(newPath);
    this.notifyChanged();
  }

  /**
   * Rename a folder on disk and rewrite the path prefix on every
   * shelved descendant ref. Same atomic discipline as `renameFileOnDisk`;
   * additionally, the descendant rewrite is in-memory string surgery
   * and won't throw under any reasonable circumstance.
   *
   * Inline-browse content (folderEntry nodes) doesn't need updating —
   * it's regenerated from disk on every expansion.
   */
  async renameFolderOnDisk(id: string, newName: string): Promise<void> {
    const ref = this.findFolder(id);
    if (!ref) {
      throw new Error("That folder is no longer on the shelf.");
    }
    const oldPath = ref.path;
    const validation = validateNewName(newName, nodePath.basename(oldPath));
    if (validation) {
      throw new Error(validation);
    }
    const newPath = canonicalizePath(
      nodePath.join(nodePath.dirname(oldPath), newName),
    );
    await this.runRename(oldPath, newPath);
    // Update the folder ref itself.
    ref.path = newPath;
    ref.label = nodePath.basename(newPath);
    ref.updatedAt = new Date().toISOString();
    // Walk the library, rewrite every descendant whose path starts
    // with the old folder. `rewritePathPrefix` returns the same
    // string if nothing matches, so this is a no-op for unrelated
    // refs.
    for (const node of walkAll(this.state.library)) {
      if (node.kind === "category") {
        continue;
      }
      if (node.id === ref.id) {
        continue;
      }
      const rewritten = rewritePathPrefix(node.path, oldPath, newPath);
      if (rewritten !== node.path) {
        this.brokenLinks?.invalidate(node.path);
        node.path = rewritten;
        node.label = nodePath.basename(rewritten);
        this.brokenLinks?.markAsExisting(rewritten);
      }
    }
    // Cascade favorites at-or-under the renamed folder.
    this.rewriteFavoritePathPrefix(oldPath, newPath);
    this.brokenLinks?.invalidate(oldPath);
    this.brokenLinks?.markAsExisting(newPath);
    this.notifyChanged();
  }

  /**
   * Re-point a ref at a different on-disk path the user picked via
   * file dialog. No filesystem mutation — disk is unchanged; the
   * shelf is just looking somewhere new now. Useful when the user
   * has moved a file outside the shelf and wants to recover the
   * reference.
   *
   * Validates kind: a file ref can't be relocated to a folder and
   * vice versa. Caller stats the path beforehand to prove existence;
   * the store just trusts and updates.
   */
  locateAgain(id: string, newAbsolutePath: string): void {
    const child = findChild(this.state.library, id);
    if (!child || (child.kind !== "file" && child.kind !== "folder")) {
      throw new Error("That item is no longer on the shelf.");
    }
    if (!nodePath.isAbsolute(newAbsolutePath)) {
      throw new Error("Sweet Shelf needs an absolute path.");
    }
    const newPath = canonicalizePath(newAbsolutePath);
    if (pathsEqual(child.path, newPath)) {
      return;
    }
    const oldPath = child.path;
    child.path = newPath;
    child.label = nodePath.basename(newPath);
    child.updatedAt = new Date().toISOString();
    // Cascade favorites: locating a Library ref to a new on-disk
    // path follows the favorite, since the user's intent was to
    // favorite the file/folder, not its old absolute path.
    this.rewriteFavoritePathPrefix(oldPath, newPath);
    this.brokenLinks?.invalidate(oldPath);
    this.brokenLinks?.markAsExisting(newPath);
    this.notifyChanged();
  }

  private async runRename(oldPath: string, newPath: string): Promise<void> {
    if (pathsEqual(oldPath, newPath)) {
      throw new Error("Same as current name.");
    }
    try {
      await vscode.workspace.fs.rename(
        vscode.Uri.file(oldPath),
        vscode.Uri.file(newPath),
        { overwrite: false },
      );
    } catch (err) {
      if (err instanceof vscode.FileSystemError) {
        if (err.code === "FileExists") {
          throw new Error("Something with that name already exists here.");
        }
        if (err.code === "FileNotFound" || err.code === "EntryNotFound") {
          throw new Error("The item couldn't be found on disk.");
        }
        if (err.code === "NoPermissions") {
          throw new Error("Sweet Shelf doesn't have permission to rename this.");
        }
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Couldn't rename: ${message}`);
    }
  }

  /* ─────────────── Focus mode ─────────────── */

  /** True when a category or folder is currently focused. */
  isFocused(): boolean {
    return this.state.focusedItemId !== null;
  }

  /**
   * Resolve the focused id to its current category/folder ref, or
   * `null` when nothing is focused or the id is orphaned. Files are
   * not focusable; if the id resolves to a file, we return `null`.
   */
  getFocusedItem(): FocusedItem | null {
    return resolveFocus(this.state.library, this.state.focusedItemId);
  }

  /**
   * Enter Focus Mode on a category or folder ref. Throws when the id
   * doesn't resolve so the command handler can surface a friendly
   * toast. Re-entering with the current id is a no-op.
   */
  enterFocus(id: string): void {
    if (this.state.focusedItemId === id) {
      return;
    }
    const item = resolveFocus(this.state.library, id);
    if (!item) {
      throw new Error(
        "Couldn't focus on this item — it may have been removed.",
      );
    }
    this.state.focusedItemId = id;
    this.notifyChanged();
  }

  /** Exit Focus Mode. No-op when not focused. */
  exitFocus(): void {
    if (this.state.focusedItemId === null) {
      return;
    }
    this.state.focusedItemId = null;
    this.notifyChanged();
  }

  /**
   * If the focused id no longer resolves, clear it. Returns the label
   * (alias preferred) of the previously-focused item when an exit
   * happened, else `null`. Callers use the returned label to compose
   * a friendly toast — capture it *before* mutating state since the
   * resolved item is gone after removal.
   */
  private autoExitFocusIfOrphaned(
    previouslyFocusedLabel: string | null,
  ): string | null {
    if (this.state.focusedItemId === null) {
      return null;
    }
    if (resolveFocus(this.state.library, this.state.focusedItemId) !== null) {
      return null;
    }
    this.state.focusedItemId = null;
    return previouslyFocusedLabel;
  }

  /** Snapshot the focused label *before* a mutation that might orphan it. */
  private snapshotFocusedLabel(): string | null {
    const item = resolveFocus(this.state.library, this.state.focusedItemId);
    if (!item) {
      return null;
    }
    if (item.kind === "category") {
      return item.category.label;
    }
    return item.folder.alias ?? item.folder.label;
  }

  /**
   * Run after a mutation that might have removed the focused item.
   * Auto-exits focus and surfaces a friendly toast in one shot. The
   * caller still calls `notifyChanged` once, so the focus-exit and
   * the underlying mutation bundle into a single tree refresh.
   */
  private maybeNotifyFocusExit(previouslyFocusedLabel: string | null): void {
    const exitedLabel = this.autoExitFocusIfOrphaned(previouslyFocusedLabel);
    if (exitedLabel === null) {
      return;
    }
    void vscode.window.showInformationMessage(
      `Sweet Shelf: Exited Focus — "${exitedLabel}" was removed from your shelf.`,
    );
  }

  /* ─────────────── Misc ─────────────── */

  protected notifyChanged(): void {
    this._onDidChange.fire();
    if (this.storageAvailable) {
      this.scheduleWrite();
    }
  }

  /**
   * Wholesale replace the in-memory config (used by import). Fires
   * `onDidChange` so all views refresh, then awaits a forced flush
   * to disk — bypassing the debounce — so the success toast can't
   * race ahead of persistence.
   *
   * Caller is responsible for invalidating the broken-link cache
   * (paths may have changed); the cache lives outside the store and
   * the store doesn't reach across that boundary.
   */
  async replaceConfig(newConfig: ShelfConfig): Promise<void> {
    this.state = newConfig;
    this.notifyChanged();
    await this.flushPendingWrites();
  }

  /**
   * Snapshot the current in-memory state to a `.pre-import-<ts>.bak`
   * file in the global storage directory. Returns the URI of the
   * backup so the import command can offer a "Reveal Backup" action.
   *
   * Uses the in-memory state (rather than reading shelf.json off
   * disk) so any pending writes are captured in the backup too.
   */
  async backupCurrentTo(): Promise<vscode.Uri> {
    const stamp = new Date().toISOString().replace(/:/g, "-");
    const backupUri = vscode.Uri.joinPath(
      this.paths.storageDir,
      `shelf.json.pre-import-${stamp}.bak`,
    );
    const bytes = new TextEncoder().encode(serializeShelfConfig(this.state));
    await vscode.workspace.fs.writeFile(backupUri, bytes);
    return backupUri;
  }

  /**
   * Force any pending debounced write to flush, then await the in-flight
   * write (if any). Call from `deactivate` so we don't lose the last
   * 200ms of changes on shutdown.
   */
  async flushPendingWrites(): Promise<void> {
    this.scheduleWrite.flush();
    if (this.pendingWrite) {
      try {
        await this.pendingWrite;
      } catch (err) {
        logError("flushing pending writes", err);
      }
    }
  }

  private async flushToDisk(): Promise<void> {
    if (!this.storageAvailable) {
      return;
    }
    const bytes = new TextEncoder().encode(serializeShelfConfig(this.state));
    try {
      this.lastInternalWriteAt = Date.now();
      await vscode.workspace.fs.writeFile(this.paths.configFile, bytes);
      this.lastInternalWriteAt = Date.now();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError("writing shelf.json", err);
      logWarn(`shelf save failed: ${message}`);
      void vscode.window.showWarningMessage(
        `Sweet Shelf: couldn't save your shelf (${message}). Changes are kept in memory.`,
      );
    }
  }

  dispose(): void {
    this.scheduleWrite.cancel();
    for (const sub of this.fileWatcherSubscriptions) {
      sub.dispose();
    }
    this.fileWatcherSubscriptions = [];
    this.fileWatcher?.dispose();
    this._onDidChange.dispose();
  }
}

/** Collect every file/folder ref path under a category subtree. */
function collectRefPaths(node: CategoryChild): string[] {
  const out: string[] = [];
  visit(node);
  return out;

  function visit(n: CategoryChild): void {
    if (n.kind === "file" || n.kind === "folder") {
      out.push(n.path);
      return;
    }
    for (const child of n.children) {
      visit(child);
    }
  }
}

/**
 * Reserved file names on Windows. Matched case-insensitively against
 * the basename (without extension) per Windows rules.
 */
const WIN32_RESERVED_NAMES = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

/**
 * Validate a candidate new name for rename-on-disk. Returns a
 * user-facing error message string when the name is rejected, or
 * `null` when the name is acceptable. Same set of rules used by the
 * input box's `validateInput` and by the store's defensive throw.
 */
function validateNewName(newName: string, currentName: string): string | null {
  if (newName.length === 0) {
    return "Please enter a name.";
  }
  if (newName.trim() !== newName) {
    return "Name can't have leading or trailing spaces.";
  }
  if (newName.includes("/") || newName.includes("\\")) {
    return "Name can't contain / or \\.";
  }
  if (newName.includes("\0")) {
    return "Name can't contain null bytes.";
  }
  if (newName.length > 255) {
    return "Name is longer than 255 characters.";
  }
  if (newName === currentName) {
    return "Same as current name.";
  }
  if (process.platform === "win32") {
    const stem = newName.split(".")[0].toUpperCase();
    if (WIN32_RESERVED_NAMES.has(stem)) {
      return "That name is reserved on Windows.";
    }
    if (newName.endsWith(".")) {
      return "Names can't end with a period on Windows.";
    }
  }
  return null;
}

/**
 * Replace `oldPrefix` with `newPrefix` at the start of `absolutePath`
 * when the path lives inside the prefix. Pure string surgery — the
 * caller is responsible for canonicalizing all three inputs first.
 *
 * Boundary check uses the platform separator so we don't accidentally
 * match `/foo/bar-2/baz` when prefix is `/foo/bar`.
 */
function rewritePathPrefix(
  absolutePath: string,
  oldPrefix: string,
  newPrefix: string,
): string {
  if (pathsEqual(absolutePath, oldPrefix)) {
    return newPrefix;
  }
  const sep = nodePath.sep;
  const oldWithSep = oldPrefix.endsWith(sep) ? oldPrefix : oldPrefix + sep;
  // Case-fold on Windows / macOS to match `pathsEqual`'s rules.
  const matches =
    process.platform === "win32" || process.platform === "darwin"
      ? absolutePath.toLowerCase().startsWith(oldWithSep.toLowerCase())
      : absolutePath.startsWith(oldWithSep);
  if (!matches) {
    return absolutePath;
  }
  return newPrefix + absolutePath.slice(oldPrefix.length);
}
