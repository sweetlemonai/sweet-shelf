import * as nodePath from "node:path";
import * as vscode from "vscode";

import {
  buildCategoryNode,
  buildCategoryTreeItem,
  buildFileNode,
  buildFileTreeItem,
  buildFocusHeaderTreeItem,
  buildFolderEntryErrorTreeItem,
  buildFolderEntryTreeItem,
  buildFolderEntryOverflowTreeItem,
  buildFolderNode,
  buildFolderTreeItem,
} from "./treeItemBuilders";
import { canonicalizePath, pathsEqual } from "../shelf/paths";
import { logWarn } from "../util/logger";
import { readFolderEntries } from "../shelf/folderEntries";
import { walkAll } from "../shelf/categories";
import type { BrokenLinkCache } from "../shelf/brokenLinks";
import type { Category, ShelfNode } from "../shelf/types";
import type { ShelfStore } from "../shelf/store";

/** Settings keys whose value affects rendered labels — refresh on change. */
const LABEL_AFFECTING_SETTINGS: readonly string[] = [
  "sweetShelf.showFileExtensions",
];

/**
 * TreeDataProvider for the Library view.
 *
 * Library renders the user's organizational tree: categories, files,
 * folders, and (when expanded) inline-browsed folder contents. In
 * Focus Mode the root swaps to a focus header followed by the focused
 * subtree's content; Favorites and Recent views hide entirely via
 * `when` clauses on the `sweetShelf.focused` context key.
 *
 * Responsibilities:
 *   - Walk `store.library` for normal-mode root
 *   - Resolve `getFocusedItem()` for focus-mode root
 *   - Lazy-read disk for inline-browsed folder content
 *   - Surface broken state (consults `brokenLinks`)
 *   - Resolve any shelf id back to a `ShelfNode` for `treeView.reveal`
 *     (used by Search and Add-File flows)
 *
 * Empty-state copy is rendered via `TreeView.message` (set externally
 * in `extension.ts`), not as a fake leaf.
 */
export class LibraryTreeProvider
  implements vscode.TreeDataProvider<ShelfNode>, vscode.Disposable
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    ShelfNode | undefined
  >();
  readonly onDidChangeTreeData: vscode.Event<ShelfNode | undefined> =
    this._onDidChangeTreeData.event;

  private readonly storeSubscription: vscode.Disposable;
  private readonly configSubscription: vscode.Disposable;
  private readonly cacheSubscription: vscode.Disposable;

  constructor(
    private readonly store: ShelfStore,
    private readonly brokenLinks: BrokenLinkCache,
  ) {
    this.storeSubscription = store.onDidChange(() => {
      this._onDidChangeTreeData.fire(undefined);
    });
    this.configSubscription = vscode.workspace.onDidChangeConfiguration((e) => {
      if (LABEL_AFFECTING_SETTINGS.some((key) => e.affectsConfiguration(key))) {
        this._onDidChangeTreeData.fire(undefined);
      }
    });
    this.cacheSubscription = brokenLinks.onDidUpdate(() => {
      this._onDidChangeTreeData.fire(undefined);
    });
  }

  getTreeItem(node: ShelfNode): vscode.TreeItem {
    switch (node.kind) {
      case "category":
        return buildCategoryTreeItem(node.category);
      case "file":
        return buildFileTreeItem(
          node.file,
          this.store.library,
          this.showFileExtensions(),
          this.brokenStateFor(node.file.path),
          this.store.isFavoritedPath(node.file.path),
        );
      case "folder":
        return buildFolderTreeItem(
          node.folder,
          this.store.library,
          this.showFileExtensions(),
          this.brokenStateFor(node.folder.path),
          this.store.isFavoritedPath(node.folder.path),
        );
      case "folderEntry":
        return buildFolderEntryTreeItem(
          node,
          this.store.isFavoritedPath(node.uri.fsPath),
          this.store.inheritedColorForPath(node.uri.fsPath),
        );
      case "folderEntryError":
        return buildFolderEntryErrorTreeItem(node);
      case "folderEntryOverflow":
        return buildFolderEntryOverflowTreeItem(node);
      case "focusHeader":
        return buildFocusHeaderTreeItem(node);
      case "favoritesEntry":
      case "recentEntry":
        // Library never renders entry variants — those are owned by
        // Favorites and Recent providers respectively. Defensive
        // throw makes it loud if a stale node arrives here.
        throw new Error(
          `LibraryTreeProvider received unexpected node kind: ${node.kind}`,
        );
      default:
        return assertNever(node);
    }
  }

  async getChildren(node?: ShelfNode): Promise<ShelfNode[]> {
    if (!node) {
      return this.rootChildren();
    }
    switch (node.kind) {
      case "category":
        return node.category.children.map((child) => {
          switch (child.kind) {
            case "category":
              return buildCategoryNode(child, node.category.id);
            case "file":
              return buildFileNode(child, node.category.id);
            case "folder":
              return buildFolderNode(child, node.category.id);
            default:
              return assertNever(child);
          }
        });
      case "folder":
        return readFolderEntries(
          vscode.Uri.file(node.folder.path),
          this.showHiddenFiles(),
        );
      case "folderEntry":
        if (!node.isDirectory) {
          return [];
        }
        return readFolderEntries(node.uri, this.showHiddenFiles());
      case "file":
      case "folderEntryError":
      case "folderEntryOverflow":
      case "focusHeader":
        return [];
      case "favoritesEntry":
      case "recentEntry":
        return [];
      default:
        return assertNever(node);
    }
  }

  /**
   * Walk up the parent chain so `treeView.reveal` can position items
   * inside nested categories or inline-browsed folders. In focus mode
   * we stop at the focus boundary — items whose natural parent is
   * the focused item return `undefined` (root-level), since focused-
   * subtree children render at root alongside the focus header.
   */
  getParent(node: ShelfNode): ShelfNode | undefined {
    switch (node.kind) {
      case "focusHeader":
        return undefined;
      case "category": {
        if (this.isDirectChildOfFocus(node.parentId, "category")) {
          return undefined;
        }
        if (node.parentId === null) {
          return undefined;
        }
        return this.parentCategoryNode(node.parentId);
      }
      case "file":
      case "folder": {
        if (this.isDirectChildOfFocus(node.parentId, "category")) {
          return undefined;
        }
        return this.parentCategoryNode(node.parentId);
      }
      case "folderEntry":
      case "folderEntryError":
      case "folderEntryOverflow":
        if (this.isDirectChildOfFocusedFolder(node.parentUri)) {
          return undefined;
        }
        return this.parentOfFolderEntry(node.parentUri);
      case "favoritesEntry":
      case "recentEntry":
        // Library doesn't render entry variants; reveal targeting
        // them shouldn't reach here, but answer cleanly if it does.
        return undefined;
      default:
        return assertNever(node);
    }
  }

  /**
   * Resolve any shelf id (category, file, or folder) to a freshly-built
   * `ShelfNode` with the correct parent linkage. Used by Search to feed
   * `libraryTreeView.reveal` after a result is selected.
   */
  nodeForId(id: string): ShelfNode | undefined {
    const category = this.store.findCategory(id);
    if (category) {
      const info = this.store.getCategoryParent(id);
      const parentId = info?.parent?.id ?? null;
      return buildCategoryNode(category, parentId);
    }
    const file = this.store.findFile(id);
    if (file) {
      const info = this.store.getRefParent(id);
      if (!info) {
        return undefined;
      }
      return buildFileNode(file, info.parent.id);
    }
    const folder = this.store.findFolder(id);
    if (folder) {
      const info = this.store.getRefParent(id);
      if (!info) {
        return undefined;
      }
      return buildFolderNode(folder, info.parent.id);
    }
    return undefined;
  }

  /**
   * Resolve an absolute on-disk path to a Library `ShelfNode` if any
   * file/folder ref's path matches. Used by the Favorites click
   * dispatcher: a folder favorite's path may correspond exactly to a
   * Library folder ref, or to nothing (in which case the dispatcher
   * walks up to the closest Library ancestor).
   */
  nodeForPath(path: string): ShelfNode | undefined {
    for (const node of walkAll(this.store.library)) {
      if (node.kind === "category") {
        continue;
      }
      if (!pathsEqual(node.path, path)) {
        continue;
      }
      const info = this.store.getRefParent(node.id);
      if (!info) {
        continue;
      }
      return node.kind === "file"
        ? buildFileNode(node, info.parent.id)
        : buildFolderNode(node, info.parent.id);
    }
    return undefined;
  }

  dispose(): void {
    this.storeSubscription.dispose();
    this.configSubscription.dispose();
    this.cacheSubscription.dispose();
    this._onDidChangeTreeData.dispose();
  }

  /* ────────────────── internals ────────────────── */

  /**
   * Root of the Library view. Normal mode: top-level categories. Focus
   * mode: focus header + focused subtree's content. An orphaned
   * `focusedItemId` (id no longer resolves) auto-exits focus on next
   * render.
   */
  private async rootChildren(): Promise<ShelfNode[]> {
    if (!this.store.isFocused()) {
      return this.store.library.map((c) => buildCategoryNode(c, null));
    }
    const focused = this.store.getFocusedItem();
    if (!focused) {
      logWarn("Focus auto-exited: focused item could not be found.");
      this.store.exitFocus();
      void vscode.window.showInformationMessage(
        "Sweet Shelf: Exited Focus — the focused item couldn't be found.",
      );
      return this.store.library.map((c) => buildCategoryNode(c, null));
    }
    const header: ShelfNode = {
      kind: "focusHeader",
      label: focusedDisplayLabel(focused),
      itemKind: focused.kind,
      itemId: focused.kind === "category" ? focused.category.id : focused.folder.id,
    };
    if (focused.kind === "category") {
      const children = focused.category.children.map((child) => {
        switch (child.kind) {
          case "category":
            return buildCategoryNode(child, focused.category.id);
          case "file":
            return buildFileNode(child, focused.category.id);
          case "folder":
            return buildFolderNode(child, focused.category.id);
          default:
            return assertNever(child);
        }
      });
      return [header, ...children];
    }
    const entries = await readFolderEntries(
      vscode.Uri.file(focused.folder.path),
      this.showHiddenFiles(),
    );
    return [header, ...entries];
  }

  private parentCategoryNode(parentCategoryId: string): ShelfNode | undefined {
    const parent = this.store.findCategory(parentCategoryId);
    if (!parent) {
      return undefined;
    }
    const grandparentInfo = this.store.getCategoryParent(parentCategoryId);
    const grandparentId = grandparentInfo?.parent?.id ?? null;
    return buildCategoryNode(parent, grandparentId);
  }

  /**
   * Climb out of an inline browse. If `parentUri` matches a `FolderRef`
   * on the shelf, return that ref's shelf node. Otherwise synthesize
   * a folderEntry for the parent directory and let the next
   * `getParent` call walk further up.
   */
  private parentOfFolderEntry(parentUri: vscode.Uri): ShelfNode | undefined {
    const parentPath = parentUri.fsPath;
    const folderShelfNode = this.findFolderRefByPath(parentPath);
    if (folderShelfNode) {
      return folderShelfNode;
    }
    const grandparentPath = nodePath.dirname(canonicalizePath(parentPath));
    if (grandparentPath === parentPath) {
      return undefined;
    }
    return {
      kind: "folderEntry",
      uri: parentUri,
      isDirectory: true,
      isSymlink: false,
      parentUri: vscode.Uri.file(grandparentPath),
    };
  }

  private findFolderRefByPath(targetPath: string): ShelfNode | undefined {
    for (const node of walkAll(this.store.library)) {
      if (node.kind !== "folder") {
        continue;
      }
      if (!pathsEqual(node.path, targetPath)) {
        continue;
      }
      const container = this.store.getRefParent(node.id);
      if (!container) {
        continue;
      }
      return buildFolderNode(node, container.parent.id);
    }
    return undefined;
  }

  private isDirectChildOfFocus(
    parentId: string | null,
    expect: "category",
  ): boolean {
    if (!this.store.isFocused()) {
      return false;
    }
    const focused = this.store.getFocusedItem();
    if (!focused || focused.kind !== expect) {
      return false;
    }
    return parentId === focused.category.id;
  }

  private isDirectChildOfFocusedFolder(parentUri: vscode.Uri): boolean {
    if (!this.store.isFocused()) {
      return false;
    }
    const focused = this.store.getFocusedItem();
    if (!focused || focused.kind !== "folder") {
      return false;
    }
    return pathsEqual(parentUri.fsPath, focused.folder.path);
  }

  private brokenStateFor(path: string): boolean {
    const cached = this.brokenLinks.isBroken(path);
    if (cached === undefined) {
      this.brokenLinks.scheduleCheck(path);
      return false;
    }
    return cached;
  }

  private showFileExtensions(): boolean {
    return vscode.workspace
      .getConfiguration("sweetShelf")
      .get<boolean>("showFileExtensions", true);
  }

  private showHiddenFiles(): boolean {
    return vscode.workspace
      .getConfiguration("sweetShelf")
      .get<boolean>("showHiddenFiles", false);
  }
}

function focusedDisplayLabel(
  focused:
    | { kind: "category"; category: Category }
    | { kind: "folder"; folder: import("../shelf/types").FolderRef },
): string {
  if (focused.kind === "category") {
    return focused.category.label;
  }
  return focused.folder.alias ?? focused.folder.label;
}

function assertNever(value: never): never {
  throw new Error(`Unexpected variant: ${JSON.stringify(value)}`);
}
