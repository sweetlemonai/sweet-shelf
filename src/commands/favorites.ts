import * as nodePath from "node:path";
import * as vscode from "vscode";

import { logError } from "../util/logger";
import { pathsEqual } from "../shelf/paths";
import { walkAll } from "../shelf/categories";
import type { Favorite, ShelfNode } from "../shelf/types";
import type { LibraryTreeProvider } from "../ui/libraryTreeProvider";
import type { ShelfStore } from "../shelf/store";

/**
 * Favorites commands — path-based.
 *
 * A favorite is a flag on a path. The right-click menus surface
 * "Add to Favorites" or "Remove from Favorites" on every file or
 * folder shown in the sidebar (Library refs, inline-browsed entries,
 * Favorites and Recent rows). Both commands resolve the path from
 * the right-clicked node, then add or remove an entry in
 * `ShelfConfig.favorites`.
 *
 * Move Up / Move Down operate on the favorited row's id (a `Favorite.id`,
 * not a Library ref id). The `when` clauses gate the menu so the
 * commands only see `favoritesEntry` nodes.
 *
 * `_openFavoriteDefault` is the click dispatcher for Favorites rows.
 * Files open in place. Folders walk up the path to find the closest
 * Library ancestor; reveal that ancestor in Library and expand down
 * to the favorited folder. If no Library ancestor resolves, the
 * favorite stays selected in the Favorites view (no fallback open).
 */

export function registerFavoriteCommands(
  context: vscode.ExtensionContext,
  store: ShelfStore,
  libraryView: vscode.TreeView<ShelfNode>,
  libraryProvider: LibraryTreeProvider,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "sweetShelf.addToFavorites",
      (node?: ShelfNode) =>
        runCommand("Add to Favorites", () => addFavorite(store, node)),
    ),
    vscode.commands.registerCommand(
      "sweetShelf.removeFromFavorites",
      (node?: ShelfNode) =>
        runCommand("Remove from Favorites", () => removeFavorite(store, node)),
    ),
    vscode.commands.registerCommand(
      "sweetShelf.moveFavoriteUp",
      (node?: ShelfNode) =>
        runCommand("Move Favorite Up", () =>
          moveFavorite(store, node, "up"),
        ),
    ),
    vscode.commands.registerCommand(
      "sweetShelf.moveFavoriteDown",
      (node?: ShelfNode) =>
        runCommand("Move Favorite Down", () =>
          moveFavorite(store, node, "down"),
        ),
    ),
    vscode.commands.registerCommand(
      "sweetShelf._openFavoriteDefault",
      (node?: ShelfNode) =>
        runCommand("Open Favorite", () =>
          openFavoriteDefault(store, libraryView, libraryProvider, node),
        ),
    ),
    vscode.commands.registerCommand(
      "sweetShelf._toggleExpand",
      () => runCommand("Toggle Expand", () => toggleExpand()),
    ),
    vscode.commands.registerCommand(
      "sweetShelf.revealInLibrary",
      (node?: ShelfNode) =>
        runCommand("Reveal in Library", () =>
          revealInLibrary(store, libraryView, libraryProvider, node),
        ),
    ),
  );
}

/**
 * Right-click handler that scrolls the Library view to the given
 * favorite's path and expands the chain to make it visible. Same
 * behavior as the click default for folder favorites; surfaced
 * explicitly for file favorites because their click default opens
 * the file.
 */
async function revealInLibrary(
  store: ShelfStore,
  libraryView: vscode.TreeView<ShelfNode>,
  libraryProvider: LibraryTreeProvider,
  node: ShelfNode | undefined,
): Promise<void> {
  if (!node || node.kind !== "favoritesEntry") {
    return;
  }
  await revealPathInLibrary(
    store,
    libraryView,
    libraryProvider,
    node.favorite.path,
    node.favorite.kind,
  );
}

/**
 * Toggle expand/collapse on the focused tree row. Wired as the click
 * handler for category, Library folder, and inline-browsed directory
 * rows so a click anywhere on the row matches the chevron's behavior.
 *
 * The clicked row is already the focused row by the time the command
 * fires (VS Code's TreeView click model selects+focuses before
 * invoking the row's `command`), so we don't need to plumb the node
 * through — we just dispatch the built-in toggle.
 */
async function toggleExpand(): Promise<void> {
  await vscode.commands.executeCommand("list.toggleExpand");
}

interface FavoriteTarget {
  path: string;
  kind: "file" | "folder";
  /** Display name to use in toasts. */
  displayName: string;
}

function targetFromNode(node: ShelfNode | undefined): FavoriteTarget | null {
  if (!node) {
    return null;
  }
  switch (node.kind) {
    case "file":
      return {
        path: node.file.path,
        kind: "file",
        displayName: node.file.alias ?? node.file.label,
      };
    case "folder":
      return {
        path: node.folder.path,
        kind: "folder",
        displayName: node.folder.alias ?? node.folder.label,
      };
    case "favoritesEntry":
      return {
        path: node.favorite.path,
        kind: node.favorite.kind,
        displayName:
          node.favorite.alias ?? nodePath.basename(node.favorite.path),
      };
    case "recentEntry":
      return {
        path: node.ref.path,
        kind: node.ref.kind,
        displayName: node.ref.alias ?? node.ref.label,
      };
    case "folderEntry":
      if (node.isSymlink) {
        return null;
      }
      return {
        path: node.uri.fsPath,
        kind: node.isDirectory ? "folder" : "file",
        displayName: nodePath.basename(node.uri.fsPath),
      };
    default:
      return null;
  }
}

function addFavorite(store: ShelfStore, node: ShelfNode | undefined): void {
  const target = targetFromNode(node);
  if (!target) {
    throw new Error("This command needs a file or folder.");
  }
  if (store.isFavoritedPath(target.path)) {
    void vscode.window.showInformationMessage("Already in Favorites.");
    return;
  }
  store.addFavorite(target.path, target.kind);
  void vscode.window.showInformationMessage(
    `Added '${target.displayName}' to Favorites.`,
  );
}

function removeFavorite(store: ShelfStore, node: ShelfNode | undefined): void {
  const target = targetFromNode(node);
  if (!target) {
    throw new Error("This command needs a file or folder.");
  }
  if (!store.removeFavoriteByPath(target.path)) {
    return;
  }
  void vscode.window.showInformationMessage(
    `Removed '${target.displayName}' from Favorites.`,
  );
}

function moveFavorite(
  store: ShelfStore,
  node: ShelfNode | undefined,
  direction: "up" | "down",
): void {
  if (!node || node.kind !== "favoritesEntry") {
    throw new Error("This command needs to be run on a favorite.");
  }
  store.moveFavorite(node.favorite.id, direction);
}

/* ───────────────── Favorites click dispatcher ───────────────── */

async function openFavoriteDefault(
  store: ShelfStore,
  libraryView: vscode.TreeView<ShelfNode>,
  libraryProvider: LibraryTreeProvider,
  node: ShelfNode | undefined,
): Promise<void> {
  if (!node || node.kind !== "favoritesEntry") {
    return;
  }
  const fav = node.favorite;
  if (fav.kind === "file") {
    await openFileInPlace(store, fav);
    return;
  }
  await revealPathInLibrary(
    store,
    libraryView,
    libraryProvider,
    fav.path,
    fav.kind,
  );
}

async function openFileInPlace(
  store: ShelfStore,
  fav: Favorite,
): Promise<void> {
  // `vscode.open` routes through VS Code's universal opener, so
  // images, PDFs, custom editors, etc. all work — `openTextDocument`
  // would throw on anything binary and surface a misleading
  // "moved or deleted" toast.
  try {
    await vscode.commands.executeCommand(
      "vscode.open",
      vscode.Uri.file(fav.path),
      vscode.ViewColumn.Active,
    );
  } catch (err) {
    logError(`opening ${fav.path}`, err);
    void vscode.window.showWarningMessage(
      "Sweet Shelf: couldn't open this file. It may have been moved or deleted.",
    );
    return;
  }
  // Record the open against the matching Library ref, when one
  // exists at this path. Favorites without a Library home don't
  // surface in Recent — Recent walks Library only.
  const ref = findLibraryRefByPath(store, fav.path);
  if (ref) {
    store.recordOpened(ref.id);
  }
}

/**
 * Reveal a path in the Library view. Three cases:
 *
 *   1. The path is exactly a Library file or folder ref → reveal
 *      that ref directly.
 *   2. The path lives inside a Library folder ref's tree (deep
 *      inline-browse descendant) → step the reveal down the
 *      ancestor chain. Each `reveal({ expand: true })` triggers
 *      `getChildren` on the ancestor, which is what makes the next
 *      step in the chain addressable. A single reveal on the deep
 *      target only partially resolves (VS Code's lazy reveal walks
 *      `getParent` but doesn't wait for each ancestor's
 *      `getChildren` to populate before painting).
 *   3. The path isn't reachable through Library at all → no-op.
 *
 * Reveal preserves state: only the chain leading to the target gets
 * expanded; sibling and unrelated branches keep their state. The
 * target itself is expanded only when it's a folder.
 */
async function revealPathInLibrary(
  store: ShelfStore,
  libraryView: vscode.TreeView<ShelfNode>,
  libraryProvider: LibraryTreeProvider,
  path: string,
  kind: "file" | "folder",
): Promise<void> {
  const expandTarget = kind === "folder";
  const exactNode = libraryProvider.nodeForPath(path);
  if (exactNode) {
    try {
      await libraryView.reveal(exactNode, {
        select: true,
        focus: true,
        expand: expandTarget,
      });
    } catch (err) {
      logError("revealing path in Library", err);
    }
    return;
  }

  const ancestorPath = closestLibraryAncestor(store, path);
  if (!ancestorPath) {
    return;
  }
  const ancestorNode = libraryProvider.nodeForPath(ancestorPath);
  if (!ancestorNode) {
    return;
  }

  // Build the ancestor → … → target chain of folderEntry nodes
  // (one per directory between the Library folder ref and the
  // target path). Then walk the chain front-to-back, revealing
  // each step so VS Code populates `getChildren` for the previous
  // step before we ask for the next one.
  const chain = buildFolderEntryChain(ancestorPath, path, kind);

  try {
    await libraryView.reveal(ancestorNode, { expand: true });
  } catch (err) {
    logError("revealing ancestor in Library", err);
    return;
  }

  for (let i = 0; i < chain.length - 1; i += 1) {
    try {
      await libraryView.reveal(chain[i], { expand: true });
    } catch (err) {
      logError("revealing chain step", err);
      return;
    }
  }

  const target = chain[chain.length - 1] ?? ancestorNode;
  try {
    await libraryView.reveal(target, {
      select: true,
      focus: true,
      expand: expandTarget,
    });
  } catch (err) {
    logError("revealing target in Library", err);
  }
}

/**
 * Construct the sequence of `folderEntry` nodes from the immediate
 * child of `ancestorPath` down to `targetPath` inclusive. The final
 * entry's `isDirectory` reflects the target's `kind`; intermediate
 * entries are always directories.
 */
function buildFolderEntryChain(
  ancestorPath: string,
  targetPath: string,
  targetKind: "file" | "folder",
): ShelfNode[] {
  const segments: string[] = [];
  let current = targetPath;
  while (!pathsEqual(current, ancestorPath)) {
    segments.unshift(current);
    const parent = nodePath.dirname(current);
    if (parent === current) {
      // Hit filesystem root without matching the ancestor — shouldn't
      // happen since the caller verified ancestry, but bail safely.
      return [];
    }
    current = parent;
  }
  return segments.map((path, index) => {
    const isLastSegment = index === segments.length - 1;
    const isDirectory = isLastSegment ? targetKind === "folder" : true;
    return {
      kind: "folderEntry",
      uri: vscode.Uri.file(path),
      isDirectory,
      isSymlink: false,
      parentUri: vscode.Uri.file(nodePath.dirname(path)),
    };
  });
}

function findLibraryRefByPath(
  store: ShelfStore,
  path: string,
): { id: string; path: string } | undefined {
  for (const node of walkAll(store.library)) {
    if (node.kind === "category") {
      continue;
    }
    if (pathsEqual(node.path, path)) {
      return { id: node.id, path: node.path };
    }
  }
  return undefined;
}

function closestLibraryAncestor(
  store: ShelfStore,
  childPath: string,
): string | null {
  let best: string | null = null;
  let bestDepth = -1;
  for (const node of walkAll(store.library)) {
    if (node.kind !== "folder") {
      continue;
    }
    if (!isAncestorPath(node.path, childPath)) {
      continue;
    }
    if (node.path.length > bestDepth) {
      bestDepth = node.path.length;
      best = node.path;
    }
  }
  return best;
}

function isAncestorPath(ancestor: string, descendant: string): boolean {
  if (pathsEqual(ancestor, descendant)) {
    return true;
  }
  const sep = nodePath.sep;
  const prefix = ancestor.endsWith(sep) ? ancestor : ancestor + sep;
  if (process.platform === "win32" || process.platform === "darwin") {
    return descendant.toLowerCase().startsWith(prefix.toLowerCase());
  }
  return descendant.startsWith(prefix);
}

async function runCommand(
  label: string,
  fn: () => Promise<void> | void,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    logError(label, err);
    const message = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`Sweet Shelf: ${message}`);
  }
}
