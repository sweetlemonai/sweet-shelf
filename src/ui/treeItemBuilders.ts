import * as nodePath from "node:path";
import * as vscode from "vscode";

import {
  ENTRY_RENDER_CAP,
  folderEntryErrorId,
  folderEntryId,
  folderEntryOverflowId,
  overflowMessage,
} from "../shelf/folderEntries";
import { computeDisambiguator } from "../shelf/disambiguation";
import { fileDisplayName, folderDisplayName } from "../shelf/labels";
import { themeColorIdFor, type ColorLabel } from "../shelf/color";
import type {
  Category,
  Favorite,
  FileRef,
  FolderRef,
  ShelfNode,
} from "../shelf/types";

/**
 * Shared rendering helpers used by all three tree providers (Library,
 * Favorites, Recent). Each builder takes the underlying ref/category,
 * the library snapshot (for disambiguation), the active settings, the
 * broken state, and a favorited flag — then returns a `vscode.TreeItem`.
 *
 * Favorites are path-based and authoritative across the sidebar
 * (Task 16). Tree builders accept `favorited: boolean` from callers
 * — providers pass `store.isFavoritedPath(path)`. The `.favorited`
 * suffix on `contextValue` toggles the menu item between "Add to
 * Favorites" and "Remove from Favorites".
 */

/* ────────────────── ShelfNode constructors ────────────────── */

export function buildCategoryNode(
  category: Category,
  parentId: string | null,
): ShelfNode {
  return { kind: "category", category, parentId };
}

export function buildFileNode(file: FileRef, parentId: string): ShelfNode {
  return { kind: "file", file, parentId };
}

export function buildFolderNode(
  folder: FolderRef,
  parentId: string,
): ShelfNode {
  return { kind: "folder", folder, parentId };
}

/* ────────────────── TreeItem builders ────────────────── */

/**
 * Build a TreeItem for a category. Color tints the folder icon
 * directly. Click toggles expand/collapse so a click anywhere on the
 * row behaves the same as the chevron (the tree row is the focused
 * row by the time the command fires).
 */
export function buildCategoryTreeItem(category: Category): vscode.TreeItem {
  const collapsible =
    category.children.length > 0
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None;
  const item = new vscode.TreeItem(category.label, collapsible);
  item.id = `category:${category.id}`;
  item.contextValue = "category";
  item.iconPath = categoryIcon(category.colorLabel);
  item.tooltip = category.label;
  if (collapsible !== vscode.TreeItemCollapsibleState.None) {
    item.command = {
      command: "sweetShelf._toggleExpand",
      title: "Toggle",
    };
  }
  return item;
}

/** Build a TreeItem for a Library file ref. */
export function buildFileTreeItem(
  file: FileRef,
  library: readonly Category[],
  showExtensions: boolean,
  broken: boolean,
  favorited: boolean,
): vscode.TreeItem {
  const item = new vscode.TreeItem(
    fileDisplayName(file, showExtensions),
    vscode.TreeItemCollapsibleState.None,
  );
  item.id = `file:${file.id}`;
  item.contextValue = refContextValue(
    "file",
    file.alias !== undefined,
    favorited,
    broken,
  );
  item.resourceUri = vscode.Uri.file(file.path);
  item.iconPath = vscode.ThemeIcon.File;
  item.tooltip = brokenTooltip(file.path, broken, "file");
  const description = composeDescription(
    computeDisambiguator(file, library, showExtensions),
    broken,
  );
  if (description !== undefined) {
    item.description = description;
  }
  item.command = brokenClickCommand(broken, {
    kind: "file",
    file,
    parentId: "",
  } satisfies ShelfNode, "sweetShelf._openFileDefault");
  return item;
}

/**
 * Build a TreeItem for a Library folder ref. Click toggles
 * expand/collapse — same behavior as clicking the chevron — so the
 * click target is forgiving. Inline-browsed contents render
 * underneath when the folder is expanded. Missing folders fall back
 * to `_brokenClick` (the friendly toast); the recovery menu offers
 * Locate Again / Reveal Parent.
 */
export function buildFolderTreeItem(
  folder: FolderRef,
  library: readonly Category[],
  showExtensions: boolean,
  broken: boolean,
  favorited: boolean,
): vscode.TreeItem {
  const item = new vscode.TreeItem(
    folderDisplayName(folder),
    broken
      ? vscode.TreeItemCollapsibleState.None
      : vscode.TreeItemCollapsibleState.Collapsed,
  );
  item.id = `folder:${folder.id}`;
  item.contextValue = refContextValue(
    "folder",
    folder.alias !== undefined,
    favorited,
    broken,
  );
  item.resourceUri = vscode.Uri.file(folder.path);
  item.iconPath = vscode.ThemeIcon.Folder;
  item.tooltip = brokenTooltip(folder.path, broken, "folder");
  const description = composeDescription(
    computeDisambiguator(folder, library, showExtensions),
    broken,
  );
  if (description !== undefined) {
    item.description = description;
  }
  if (broken) {
    item.command = brokenClickCommand(
      broken,
      { kind: "folder", folder, parentId: "" } satisfies ShelfNode,
      "sweetShelf._openFolderDefault",
    );
  } else {
    item.command = { command: "sweetShelf._toggleExpand", title: "Toggle" };
  }
  return item;
}

/**
 * Build a TreeItem for a Favorites view row. Favorites are path-based
 * and independent of Library, so display reads from the `Favorite`
 * directly (alias falls back to basename). The Favorites view does
 * not show the star badge — every row in this view is favorited, so
 * the badge is redundant. The decoration provider suppresses the
 * star on file URIs that are exclusive to the favorites view (it
 * treats path-favorited as universal; the redundancy is only an
 * issue inside Favorites itself, where the dedicated row already
 * communicates the meaning).
 *
 * Click → `_openFavoriteDefault`. Files open in place; folders
 * navigate to the closest Library ancestor and reveal/expand there.
 */
export function buildFavoriteTreeItem(
  fav: Favorite,
  broken: boolean,
): vscode.TreeItem {
  const isFile = fav.kind === "file";
  const display = fav.alias ?? nodePath.basename(fav.path) ?? fav.path;
  const item = new vscode.TreeItem(
    display,
    vscode.TreeItemCollapsibleState.None,
  );
  item.id = `favoritesEntry:${fav.kind}:${fav.id}`;
  item.contextValue = refContextValue(
    `favoritesEntry.${fav.kind}`,
    fav.alias !== undefined,
    /* favorited */ true,
    broken,
  );
  item.resourceUri = vscode.Uri.file(fav.path);
  item.iconPath = isFile ? vscode.ThemeIcon.File : vscode.ThemeIcon.Folder;
  item.tooltip = brokenTooltip(fav.path, broken, fav.kind);
  if (broken) {
    item.description = "(missing)";
  }
  const node: ShelfNode = { kind: "favoritesEntry", favorite: fav };
  item.command = brokenClickCommand(
    broken,
    node,
    "sweetShelf._openFavoriteDefault",
  );
  return item;
}

/**
 * Build a TreeItem for a Recent view row. Files open in place;
 * folders honor `defaultFolderClickAction`.
 */
export function buildRecentEntryTreeItem(
  ref: FileRef | FolderRef,
  library: readonly Category[],
  showExtensions: boolean,
  broken: boolean,
  favorited: boolean,
): vscode.TreeItem {
  const isFile = ref.kind === "file";
  const display = isFile
    ? fileDisplayName(ref, showExtensions)
    : folderDisplayName(ref);
  const item = new vscode.TreeItem(
    display,
    vscode.TreeItemCollapsibleState.None,
  );
  item.id = `recentEntry:${ref.kind}:${ref.id}`;
  item.contextValue = refContextValue(
    `recentEntry.${ref.kind}`,
    ref.alias !== undefined,
    favorited,
    broken,
  );
  item.resourceUri = vscode.Uri.file(ref.path);
  item.iconPath = isFile ? vscode.ThemeIcon.File : vscode.ThemeIcon.Folder;
  item.tooltip = brokenTooltip(ref.path, broken, ref.kind);
  const description = composeDescription(
    computeDisambiguator(ref, library, showExtensions),
    broken,
  );
  if (description !== undefined) {
    item.description = description;
  }
  const node: ShelfNode = { kind: "recentEntry", ref };
  item.command = brokenClickCommand(
    broken,
    node,
    isFile ? "sweetShelf._openFileDefault" : "sweetShelf._openFolderDefault",
  );
  return item;
}

/**
 * Build a TreeItem for an inline-browsed folder entry. `favorited`
 * decides whether the contextValue ends in `.favorited`, which the
 * right-click menu uses to swap "Add to Favorites" for "Remove from
 * Favorites". Symlinks never get the favorites menu — they aren't
 * unambiguous file/folder targets.
 */
export function buildFolderEntryTreeItem(
  node: Extract<ShelfNode, { kind: "folderEntry" }>,
  favorited: boolean,
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
    item.contextValue = favorited
      ? "folderEntry.directory.favorited"
      : "folderEntry.directory";
    item.iconPath = vscode.ThemeIcon.Folder;
    item.command = {
      command: "sweetShelf._toggleExpand",
      title: "Toggle",
    };
  } else {
    item.contextValue = favorited
      ? "folderEntry.file.favorited"
      : "folderEntry.file";
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

/** Build a TreeItem for the read-failure placeholder inside an inline browse. */
export function buildFolderEntryErrorTreeItem(
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

/** Build a TreeItem for the over-cap placeholder inside an inline browse. */
export function buildFolderEntryOverflowTreeItem(
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

/** Build a TreeItem for the focus-mode header at the top of the Library view. */
export function buildFocusHeaderTreeItem(
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
  // a hint, not part of the label.
  item.description = "Show All";
  item.tooltip = `You're focused on "${node.label}". Click to show all.`;
  item.command = {
    command: "sweetShelf.exitFocus",
    title: "Show All",
  };
  return item;
}

/* ────────────────── Internal helpers ────────────────── */

/**
 * Compose a contextValue string for shelf rows:
 *   <prefix>[.aliased][.favorited][.missing]
 *
 * The `.missing` suffix is appended last so menu when-clauses can
 * match on `\.missing$` to filter to the recovery menu. The
 * `.favorited` suffix toggles Add/Remove from Favorites.
 */
function refContextValue(
  prefix: string,
  aliased: boolean,
  favorited: boolean,
  broken: boolean,
): string {
  const parts = [prefix];
  if (aliased) {
    parts.push("aliased");
  }
  if (favorited) {
    parts.push("favorited");
  }
  if (broken) {
    parts.push("missing");
  }
  return parts.join(".");
}

/**
 * Append " (missing)" after any disambiguator. Returns `undefined`
 * when neither piece is present so the caller can skip setting
 * `item.description` entirely (avoids an empty span).
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
