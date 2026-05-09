import * as nodePath from "node:path";
import * as vscode from "vscode";

import {
  ENTRY_RENDER_CAP,
  folderEntryErrorId,
  folderEntryId,
  folderEntryOverflowId,
  overflowMessage,
  readFolderEntries,
} from "./folderEntries";
import { buildFavoritesView } from "./favorites";
import { buildRecentView } from "./recent";
import { canonicalizePath, pathsEqual } from "./paths";
import { computeDisambiguator } from "./disambiguation";
import { fileDisplayName, folderDisplayName } from "./labels";
import { logWarn } from "../util/logger";
import { themeColorIdFor, type ColorLabel } from "./color";
import type { BrokenLinkCache } from "./brokenLinks";
import {
  SECTION_LABELS,
  type Category,
  type FileRef,
  type FolderRef,
  type SectionId,
  type ShelfNode,
} from "./types";
import { walkAll } from "./categories";
import type { ShelfStore } from "./store";

/** Settings keys whose value affects rendered labels — refresh on change. */
const LABEL_AFFECTING_SETTINGS: readonly string[] = [
  "sweetShelf.showFileExtensions",
  "sweetShelf.maxRecentItems",
];

/** Default cap on Recent items when the setting is missing or invalid. */
const DEFAULT_MAX_RECENT_ITEMS = 20;

/**
 * Tree data provider backing the Sweet Shelf sidebar view.
 *
 * Reads exclusively from the `ShelfStore` for shelf items, and from
 * the live filesystem (via `readFolderEntries`) for inline-browsed
 * folders. The `_onDidChangeTreeData` event refires whenever the
 * store reports a change; inline-browse content refreshes only on
 * collapse + re-expand (no filesystem watchers in v1).
 *
 * All branching on node variants uses `switch (node.kind)` so adding
 * new variants in later tasks surfaces missing cases at compile time.
 */
export class SweetShelfTreeProvider
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
    // Settings that affect label rendering (extension visibility today;
    // more in later tasks) re-emit a tree-change so labels refresh
    // without requiring a window reload.
    this.configSubscription = vscode.workspace.onDidChangeConfiguration((e) => {
      if (LABEL_AFFECTING_SETTINGS.some((key) => e.affectsConfiguration(key))) {
        this._onDidChangeTreeData.fire(undefined);
      }
    });
    // When a stat resolves and flips a broken state, refresh the
    // tree so the (missing) suffix and the contextValue update.
    // FileDecorationProvider already handles the badge; this is for
    // the in-tree label and right-click menu wiring.
    this.cacheSubscription = brokenLinks.onDidUpdate(() => {
      this._onDidChangeTreeData.fire(undefined);
    });
  }

  /**
   * Convert a `ShelfNode` to the VS Code `TreeItem` rendered in the
   * sidebar. File and folder shelf nodes carry a `command` so single-
   * click dispatches the user's configured open action; folder refs
   * are now collapsible (Task 4) and trigger lazy inline browsing.
   */
  getTreeItem(node: ShelfNode): vscode.TreeItem {
    switch (node.kind) {
      case "section": {
        const item = new vscode.TreeItem(
          node.label,
          vscode.TreeItemCollapsibleState.Expanded,
        );
        item.id = `section:${node.id}`;
        item.contextValue = `section.${node.id}`;
        return item;
      }
      case "empty": {
        const item = new vscode.TreeItem(
          node.message,
          vscode.TreeItemCollapsibleState.None,
        );
        item.id = `empty:${node.parentSectionId}`;
        item.contextValue = "empty";
        item.tooltip = node.message;
        return item;
      }
      case "category": {
        const collapsible =
          node.category.children.length > 0
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None;
        const item = new vscode.TreeItem(node.category.label, collapsible);
        item.id = `category:${node.category.id}`;
        item.contextValue = "category";
        item.iconPath = categoryIcon(node.category.colorLabel);
        item.tooltip = node.category.label;
        return item;
      }
      case "file":
        return buildFileItem(
          node.file,
          this.store.library,
          this.showFileExtensions(),
          this.brokenStateFor(node.file.path),
        );
      case "folder":
        return buildFolderItem(
          node.folder,
          this.store.library,
          this.showFileExtensions(),
          this.brokenStateFor(node.folder.path),
        );
      case "favoritesEntry":
        return buildEntryItem(
          node.ref,
          "favoritesEntry",
          this.store.library,
          this.showFileExtensions(),
          /* includeFavoritedFlag */ false,
          this.brokenStateFor(node.ref.path),
        );
      case "recentEntry":
        return buildEntryItem(
          node.ref,
          "recentEntry",
          this.store.library,
          this.showFileExtensions(),
          /* includeFavoritedFlag */ true,
          this.brokenStateFor(node.ref.path),
        );
      case "folderEntry":
        return buildFolderEntryItem(node);
      case "folderEntryError":
        return buildFolderEntryErrorItem(node);
      case "folderEntryOverflow":
        return buildFolderEntryOverflowItem(node);
      case "focusHeader":
        return buildFocusHeaderItem(node);
      default:
        return assertNever(node);
    }
  }

  /**
   * Walk the tree. Synchronous for shelf nodes; async for folder-shaped
   * nodes that need to read the filesystem. The `await` boundary is
   * confined to `readFolderEntries`, which captures its inputs by
   * value so a stale shelf state during the read doesn't crash.
   */
  async getChildren(node?: ShelfNode): Promise<ShelfNode[]> {
    if (!node) {
      return this.rootChildren();
    }
    switch (node.kind) {
      case "section":
        return this.childrenOfSection(node.id);
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
      case "favoritesEntry":
      case "recentEntry":
      case "empty":
      case "folderEntryError":
      case "folderEntryOverflow":
      case "focusHeader":
        return [];
      default:
        return assertNever(node);
    }
  }

  /**
   * Required for `treeView.reveal()`. Walks up shelf nodes via the
   * store; for folderEntry nodes, walks up the URI path until it hits
   * the originating shelf folder ref. Reconstructs nodes fresh on each
   * call so they always reflect current state — VS Code matches by
   * `treeItem.id`, so identity isn't required.
   */
  getParent(node: ShelfNode): ShelfNode | undefined {
    switch (node.kind) {
      case "section":
      case "focusHeader":
        return undefined;
      case "empty":
        return buildSectionNode(node.parentSectionId);
      case "category": {
        if (this.isDirectChildOfFocus(node.parentId, "category")) {
          return undefined;
        }
        if (node.parentId === null) {
          return buildSectionNode("library");
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
      case "favoritesEntry":
        return buildSectionNode("favorites");
      case "recentEntry":
        return buildSectionNode("recent");
      case "folderEntry":
      case "folderEntryError":
      case "folderEntryOverflow":
        if (this.isDirectChildOfFocusedFolder(node.parentUri)) {
          return undefined;
        }
        return this.parentOfFolderEntry(node.parentUri);
      default:
        return assertNever(node);
    }
  }

  /**
   * In focus mode, items at the "first level inside focus" render at
   * tree root alongside the focus header. Their natural parent isn't
   * visible, so `getParent` returns `undefined` rather than walking
   * into hidden state — keeps `treeView.reveal` working for items
   * dropped into the focused container (e.g. after Add File).
   */
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

  /**
   * Resolve any shelf id (category, file, or folder) to a freshly-built
   * `ShelfNode` with the correct parent linkage. Used by Search to feed
   * `treeView.reveal` after a result is selected. Returns `undefined`
   * if the id no longer resolves (concurrent removal between search
   * and selection).
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
   * on the shelf, return that ref's shelf node (closes the loop with
   * `getParent` for shelf items). Otherwise synthesize a folderEntry
   * for the parent directory and let the next `getParent` call walk
   * further up.
   */
  private parentOfFolderEntry(parentUri: vscode.Uri): ShelfNode | undefined {
    const parentPath = parentUri.fsPath;
    const folderShelfNode = this.findFolderRefByPath(parentPath);
    if (folderShelfNode) {
      return folderShelfNode;
    }
    const grandparentPath = nodePath.dirname(canonicalizePath(parentPath));
    if (grandparentPath === parentPath) {
      // Reached filesystem root without finding a shelf folder ref —
      // bail out rather than loop forever.
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

  /**
   * Root of the tree. In normal mode this is the section list. In
   * Focus Mode it becomes a single header followed by the focused
   * item's contents. An orphaned `focusedItemId` (id no longer
   * resolves) auto-exits focus on next render and surfaces a
   * friendly toast — defensive recovery beyond the cascade-cleanup
   * already in the store's remove paths.
   */
  private async rootChildren(): Promise<ShelfNode[]> {
    if (!this.store.isFocused()) {
      return this.store.sectionOrder.map(buildSectionNode);
    }
    const focused = this.store.getFocusedItem();
    if (!focused) {
      // Orphaned focus id (hand-edited shelf.json, weird state).
      // Recover silently, log, and render normally.
      logWarn("Focus auto-exited: focused item could not be found.");
      this.store.exitFocus();
      void vscode.window.showInformationMessage(
        "Sweet Shelf: Exited Focus — the focused item couldn't be found.",
      );
      return this.store.sectionOrder.map(buildSectionNode);
    }
    const showExtensions = this.showFileExtensions();
    const header: ShelfNode = {
      kind: "focusHeader",
      label: focusHeaderLabel(focused, showExtensions),
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
      if (children.length === 0) {
        return [
          header,
          {
            kind: "empty",
            parentSectionId: "library",
            message:
              "This category is empty. Click 'Show All' to see your full shelf.",
          },
        ];
      }
      return [header, ...children];
    }
    // Folder focus: lazy-read the directory, same as inline-browse.
    const entries = await readFolderEntries(
      vscode.Uri.file(focused.folder.path),
      this.showHiddenFiles(),
    );
    return [header, ...entries];
  }

  private childrenOfSection(id: SectionId): ShelfNode[] {
    switch (id) {
      case "library": {
        const lib = this.store.library;
        if (lib.length === 0) {
          return [
            {
              kind: "empty",
              parentSectionId: "library",
              message: "No categories yet. Click + above to create one.",
            },
          ];
        }
        return lib.map((c) => buildCategoryNode(c, null));
      }
      case "favorites": {
        const view = buildFavoritesView(
          this.store.library,
          this.store.favoritesOrder,
        );
        if (view.cleanedOrder !== null) {
          // Persist the cleaned order. The resulting onDidChange fires
          // a re-render; the second pass finds drift === false and is
          // a no-op, so the recursion terminates in one bounce.
          this.store.replaceFavoritesOrder(view.cleanedOrder);
        }
        if (view.refs.length === 0) {
          return [
            {
              kind: "empty",
              parentSectionId: "favorites",
              message:
                "No favorites yet. Right-click any file or folder and choose Add to Favorites.",
            },
          ];
        }
        return view.refs.map((ref) => ({ kind: "favoritesEntry", ref }));
      }
      case "recent": {
        const max = this.maxRecentItems();
        const refs = buildRecentView(this.store.library, max);
        if (refs.length === 0) {
          return [
            {
              kind: "empty",
              parentSectionId: "recent",
              message:
                "Nothing recent. Files you open from your shelf will appear here.",
            },
          ];
        }
        return refs.map((ref) => ({ kind: "recentEntry", ref }));
      }
      default:
        return assertNever(id);
    }
  }

  private showHiddenFiles(): boolean {
    return vscode.workspace
      .getConfiguration("sweetShelf")
      .get<boolean>("showHiddenFiles", false);
  }

  private showFileExtensions(): boolean {
    return vscode.workspace
      .getConfiguration("sweetShelf")
      .get<boolean>("showFileExtensions", true);
  }

  /**
   * Best-effort broken state for a path. Returns `false` (treat as
   * fine) when the cache hasn't seen the path yet, but schedules a
   * stat so the next render reflects the resolved truth. Stat errors
   * other than "file not found" never mark a path broken — they're
   * logged in the cache and we keep rendering normally.
   */
  private brokenStateFor(path: string): boolean {
    const cached = this.brokenLinks.isBroken(path);
    if (cached === undefined) {
      this.brokenLinks.scheduleCheck(path);
      return false;
    }
    return cached;
  }

  private maxRecentItems(): number {
    const raw = vscode.workspace
      .getConfiguration("sweetShelf")
      .get<number>("maxRecentItems", DEFAULT_MAX_RECENT_ITEMS);
    if (!Number.isFinite(raw) || raw < 1) {
      return DEFAULT_MAX_RECENT_ITEMS;
    }
    return Math.min(100, Math.max(1, Math.floor(raw)));
  }

  dispose(): void {
    this.storeSubscription.dispose();
    this.configSubscription.dispose();
    this.cacheSubscription.dispose();
    this._onDidChangeTreeData.dispose();
  }
}

/* ────────────────── Node builders (exported for command handlers) ────────────────── */

/** Construct a section node from a section id. */
export function buildSectionNode(id: SectionId): ShelfNode {
  return { kind: "section", id, label: SECTION_LABELS[id] };
}

/** Construct a category node from a category and its parent's id. */
export function buildCategoryNode(
  category: Category,
  parentId: string | null,
): ShelfNode {
  return { kind: "category", category, parentId };
}

/** Construct a file node. `parentId` is the containing category's id. */
export function buildFileNode(file: FileRef, parentId: string): ShelfNode {
  return { kind: "file", file, parentId };
}

/** Construct a folder node. `parentId` is the containing category's id. */
export function buildFolderNode(
  folder: FolderRef,
  parentId: string,
): ShelfNode {
  return { kind: "folder", folder, parentId };
}

/* ────────────────── TreeItem builders ────────────────── */

function buildFileItem(
  file: FileRef,
  library: readonly Category[],
  showExtensions: boolean,
  broken: boolean,
): vscode.TreeItem {
  const item = new vscode.TreeItem(
    fileDisplayName(file, showExtensions),
    vscode.TreeItemCollapsibleState.None,
  );
  item.id = `file:${file.id}`;
  item.contextValue = refContextValue("file", file, true, broken);
  item.resourceUri = vscode.Uri.file(file.path);
  item.iconPath = vscode.ThemeIcon.File;
  item.tooltip = brokenTooltip(file.path, broken, "file");
  const fileDescription = composeDescription(
    computeDisambiguator(file, library, showExtensions),
    broken,
  );
  if (fileDescription !== undefined) {
    item.description = fileDescription;
  }
  item.command = brokenClickCommand(broken, {
    kind: "file",
    file,
    parentId: "",
  } satisfies ShelfNode, "sweetShelf._openFileDefault");
  return item;
}

function buildFolderItem(
  folder: FolderRef,
  library: readonly Category[],
  showExtensions: boolean,
  broken: boolean,
): vscode.TreeItem {
  // Folders are collapsible — clicking the chevron triggers inline
  // browsing via `getChildren`. Single-click on the label dispatches
  // `_openFolderDefault`, which honors the configured action. Missing
  // folders fall back to `_brokenClick` (the toast).
  const item = new vscode.TreeItem(
    folderDisplayName(folder),
    broken
      ? vscode.TreeItemCollapsibleState.None
      : vscode.TreeItemCollapsibleState.Collapsed,
  );
  item.id = `folder:${folder.id}`;
  item.contextValue = refContextValue("folder", folder, true, broken);
  item.resourceUri = vscode.Uri.file(folder.path);
  item.iconPath = vscode.ThemeIcon.Folder;
  item.tooltip = brokenTooltip(folder.path, broken, "folder");
  const folderDescription = composeDescription(
    computeDisambiguator(folder, library, showExtensions),
    broken,
  );
  if (folderDescription !== undefined) {
    item.description = folderDescription;
  }
  item.command = brokenClickCommand(broken, {
    kind: "folder",
    folder,
    parentId: "",
  } satisfies ShelfNode, "sweetShelf._openFolderDefault");
  return item;
}

/**
 * Build the TreeItem for a favoritesEntry / recentEntry node. Reuses
 * the same display logic as Library file/folder rendering — alias →
 * basename → disambiguator — so favorited and recent items look and
 * feel consistent with their Library counterparts.
 *
 * Folders surfaced via Favorites/Recent are intentionally rendered as
 * leaves (no `Collapsed` state). Inline-browsing a folder ref happens
 * in Library; surfacing the same folder under Favorites/Recent just
 * shows a row that opens (or is acted on) like any other shortcut.
 */
function buildEntryItem(
  ref: FileRef | FolderRef,
  prefix: "favoritesEntry" | "recentEntry",
  library: readonly Category[],
  showExtensions: boolean,
  includeFavoritedFlag: boolean,
  broken: boolean,
): vscode.TreeItem {
  const isFile = ref.kind === "file";
  const display = isFile
    ? fileDisplayName(ref, showExtensions)
    : folderDisplayName(ref);
  const item = new vscode.TreeItem(
    display,
    vscode.TreeItemCollapsibleState.None,
  );
  item.id = `${prefix}:${ref.kind}:${ref.id}`;
  item.contextValue = refContextValue(
    `${prefix}.${ref.kind}`,
    ref,
    includeFavoritedFlag,
    broken,
  );
  item.resourceUri = vscode.Uri.file(ref.path);
  item.iconPath = isFile ? vscode.ThemeIcon.File : vscode.ThemeIcon.Folder;
  item.tooltip = brokenTooltip(ref.path, broken, isFile ? "file" : "folder");
  const entryDescription = composeDescription(
    computeDisambiguator(ref, library, showExtensions),
    broken,
  );
  if (entryDescription !== undefined) {
    item.description = entryDescription;
  }
  const node: ShelfNode = { kind: prefix, ref };
  item.command = brokenClickCommand(
    broken,
    node,
    isFile ? "sweetShelf._openFileDefault" : "sweetShelf._openFolderDefault",
  );
  return item;
}

/**
 * Compose a contextValue string for shelf refs:
 *   <prefix>[.aliased][.favorited][.missing]
 *
 * `includeFavoritedFlag` is `false` for favoritesEntry rows since
 * they're always favorited — adding the suffix is redundant. The
 * `.missing` suffix is appended last so menu when-clauses can match
 * on `\.missing$` to filter to the recovery menu.
 */
function refContextValue(
  prefix: string,
  ref: FileRef | FolderRef,
  includeFavoritedFlag: boolean,
  broken: boolean,
): string {
  const parts = [prefix];
  if (ref.alias !== undefined) {
    parts.push("aliased");
  }
  if (includeFavoritedFlag && ref.favoritedAt !== undefined) {
    parts.push("favorited");
  }
  if (broken) {
    parts.push("missing");
  }
  return parts.join(".");
}

/**
 * Append " (missing)" after any disambiguator. Setting `description`
 * to an empty string would render an empty span, so when neither
 * piece is present we leave it undefined.
 */
function composeDescription(
  disambiguator: string | undefined,
  broken: boolean,
): string | undefined {
  if (disambiguator !== undefined && broken) {
    return `${disambiguator} (missing)`;
  }
  if (disambiguator !== undefined) {
    return disambiguator;
  }
  if (broken) {
    return "(missing)";
  }
  return undefined;
}

function brokenTooltip(
  path: string,
  broken: boolean,
  kind: "file" | "folder",
): string {
  if (!broken) {
    return path;
  }
  return `This ${kind} appears to be missing. Last known path: ${path}`;
}

/**
 * Click command for shelf file/folder rows. When the path is broken,
 * route the click through `_brokenClick` instead of the open
 * dispatcher — opening a missing file would error or silently fail
 * with VS Code's "Cannot open" toast; the friendly message and the
 * recovery menu are what the user actually wants.
 */
function brokenClickCommand(
  broken: boolean,
  node: ShelfNode,
  defaultCommand: string,
): vscode.Command {
  if (broken) {
    return {
      command: "sweetShelf._brokenClick",
      title: "Missing",
      arguments: [node],
    };
  }
  return {
    command: defaultCommand,
    title: "Open",
    arguments: [node],
  };
}

/**
 * Build the icon for a category, optionally tinted when the user has
 * set a color label. Categories don't pass through the
 * `FileDecorationProvider` (no URI), so the tint applies via the
 * `ThemeIcon` color parameter directly.
 */
function categoryIcon(colorLabel: ColorLabel | undefined): vscode.ThemeIcon {
  if (colorLabel === undefined) {
    return new vscode.ThemeIcon("folder");
  }
  return new vscode.ThemeIcon(
    "folder",
    new vscode.ThemeColor(themeColorIdFor(colorLabel)),
  );
}

function buildFolderEntryItem(
  node: Extract<ShelfNode, { kind: "folderEntry" }>,
): vscode.TreeItem {
  const collapsible = node.isDirectory
    ? vscode.TreeItemCollapsibleState.Collapsed
    : vscode.TreeItemCollapsibleState.None;
  const item = new vscode.TreeItem(
    nodePath.basename(node.uri.fsPath) || node.uri.fsPath,
    collapsible,
  );
  item.id = folderEntryId(node.uri);
  item.resourceUri = node.uri;
  item.tooltip = node.uri.fsPath;
  if (node.isSymlink) {
    item.contextValue = "folderEntry.symlink";
    item.iconPath = new vscode.ThemeIcon("file-symlink-file");
  } else if (node.isDirectory) {
    item.contextValue = "folderEntry.directory";
    item.iconPath = vscode.ThemeIcon.Folder;
  } else {
    item.contextValue = "folderEntry.file";
    item.iconPath = vscode.ThemeIcon.File;
    item.command = {
      command: "sweetShelf._openFileDefault",
      title: "Open",
      arguments: [
        {
          kind: "folderEntry",
          uri: node.uri,
          isDirectory: false,
          isSymlink: false,
          parentUri: node.parentUri,
        } satisfies ShelfNode,
      ],
    };
  }
  return item;
}

function buildFolderEntryErrorItem(
  node: Extract<ShelfNode, { kind: "folderEntryError" }>,
): vscode.TreeItem {
  const item = new vscode.TreeItem(
    `⚠ ${node.message}`,
    vscode.TreeItemCollapsibleState.None,
  );
  item.id = folderEntryErrorId(node.parentUri);
  item.contextValue = "folderEntryError";
  item.tooltip = `${node.message}\n${node.parentUri.fsPath}`;
  item.iconPath = new vscode.ThemeIcon("warning");
  return item;
}

function buildFolderEntryOverflowItem(
  node: Extract<ShelfNode, { kind: "folderEntryOverflow" }>,
): vscode.TreeItem {
  const message = overflowMessage(node.hiddenCount);
  const item = new vscode.TreeItem(
    message,
    vscode.TreeItemCollapsibleState.None,
  );
  item.id = folderEntryOverflowId(node.parentUri);
  item.contextValue = "folderEntryOverflow";
  item.tooltip = `Sweet Shelf renders the first ${ENTRY_RENDER_CAP} entries per folder for performance.`;
  item.iconPath = new vscode.ThemeIcon("ellipsis");
  return item;
}

function buildFocusHeaderItem(
  node: Extract<ShelfNode, { kind: "focusHeader" }>,
): vscode.TreeItem {
  const item = new vscode.TreeItem(
    `Focus: ${node.label}`,
    vscode.TreeItemCollapsibleState.None,
  );
  item.id = `focusHeader:${node.itemKind}:${node.itemId}`;
  item.contextValue = "focusHeader";
  item.iconPath = new vscode.ThemeIcon("target");
  // VS Code renders `description` in a dimmer color, so this reads as
  // a hint, not part of the label. The whole row is also clickable,
  // and the right-click menu offers the same "Show All" command —
  // three ways to exit, all unmistakable.
  item.description = "Show All";
  item.tooltip = `You're focused on "${node.label}". Click to show all.`;
  item.command = {
    command: "sweetShelf.exitFocus",
    title: "Show All",
  };
  return item;
}

function focusHeaderLabel(
  focused: { kind: "category"; category: Category } | { kind: "folder"; folder: FolderRef },
  showExtensions: boolean,
): string {
  if (focused.kind === "category") {
    return focused.category.label;
  }
  return fileLikeFolderDisplay(focused.folder, showExtensions);
}

// Folders ignore `showFileExtensions` per Task 5, but we keep this
// indirection so the call site stays symmetrical with the file branch.
function fileLikeFolderDisplay(
  folder: FolderRef,
  _showExtensions: boolean,
): string {
  return folderDisplayName(folder);
}

function assertNever(value: never): never {
  throw new Error(`Unexpected variant: ${JSON.stringify(value)}`);
}
