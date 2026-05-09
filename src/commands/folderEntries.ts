import * as vscode from "vscode";

import {
  AlreadyOnShelfError,
  type FileRef,
  type FolderRef,
  type ShelfNode,
} from "../shelf/types";
import {
  buildFileNode,
  buildFolderNode,
} from "../ui/treeItemBuilders";
import { logError } from "../util/logger";
import { pickCategoryId } from "../ui/quickPicks";
import type { ShelfStore } from "../shelf/store";

/**
 * Commands specific to inline-browsed `folderEntry` nodes.
 *
 * Two flows:
 *
 *   - **Add to Category…** pins an inline-browsed file or folder as
 *     a top-level shelf reference under a category the user picks.
 *   - **Add to Favorites…** does the same pin AND favorites it in one
 *     atomic mutation. If the path is already on the shelf, the user
 *     can favorite the existing reference instead.
 *
 * Symlinks don't get either command — their menu exposes only Reveal
 * and Copy Path. Drag-to-shelf still works for symlinks via the OS-
 * drop loop, which stats and resolves the target.
 */

export function registerFolderEntryCommands(
  context: vscode.ExtensionContext,
  store: ShelfStore,
  treeView: vscode.TreeView<ShelfNode>,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "sweetShelf.addFolderEntryToShelf",
      (node?: ShelfNode) =>
        runCommand("Add to Category", () =>
          addFolderEntryToShelf(store, treeView, node),
        ),
    ),
    vscode.commands.registerCommand(
      "sweetShelf.addFolderEntryToFavorites",
      (node?: ShelfNode) =>
        runCommand("Add to Favorites", () =>
          addFolderEntryToFavorites(store, treeView, node),
        ),
    ),
  );
}

async function addFolderEntryToShelf(
  store: ShelfStore,
  treeView: vscode.TreeView<ShelfNode>,
  node: ShelfNode | undefined,
): Promise<void> {
  const target = requireFolderEntry(node);
  const path = target.uri.fsPath;
  const categoryId = await pickCategoryId(
    store,
    target.isDirectory
      ? "Where should this folder go?"
      : "Where should this file go?",
  );
  if (!categoryId) {
    return;
  }
  try {
    if (target.isDirectory) {
      const ref = store.addFolder(categoryId, path);
      await revealRef(treeView, buildFolderNode(ref, categoryId), "folder");
    } else {
      const ref = store.addFile(categoryId, path);
      await revealRef(treeView, buildFileNode(ref, categoryId), "file");
    }
  } catch (err) {
    if (err instanceof AlreadyOnShelfError) {
      void vscode.window.showInformationMessage(`Sweet Shelf: ${err.message}`);
      return;
    }
    throw err;
  }
}

async function addFolderEntryToFavorites(
  store: ShelfStore,
  treeView: vscode.TreeView<ShelfNode>,
  node: ShelfNode | undefined,
): Promise<void> {
  const target = requireFolderEntry(node);
  const path = target.uri.fsPath;
  const categoryId = await pickCategoryId(
    store,
    target.isDirectory
      ? "Where should this folder go?"
      : "Where should this file go?",
  );
  if (!categoryId) {
    return;
  }
  try {
    if (target.isDirectory) {
      const ref = store.addAndFavoriteFolder(categoryId, path);
      await revealRef(treeView, buildFolderNode(ref, categoryId), "folder");
    } else {
      const ref = store.addAndFavoriteFile(categoryId, path);
      await revealRef(treeView, buildFileNode(ref, categoryId), "file");
    }
  } catch (err) {
    if (err instanceof AlreadyOnShelfError) {
      await offerFavoriteExisting(store, treeView, err);
      return;
    }
    throw err;
  }
}

/**
 * Path is already on the shelf; offer to favorite that existing ref
 * instead of adding a duplicate. The follow-up favorite is a single
 * mutation — no add path runs, so there's nothing to bundle.
 */
async function offerFavoriteExisting(
  store: ShelfStore,
  treeView: vscode.TreeView<ShelfNode>,
  err: AlreadyOnShelfError,
): Promise<void> {
  const ref = err.ref;
  if (ref.favoritedAt !== undefined) {
    void vscode.window.showInformationMessage(
      `Sweet Shelf: "${ref.label}" is already on your shelf in "${err.parentLabel}" and already favorited.`,
    );
    return;
  }
  const choice = await vscode.window.showInformationMessage(
    `Sweet Shelf: "${ref.label}" is already on your shelf in "${err.parentLabel}". Favorite that one?`,
    "Favorite Existing",
  );
  if (choice !== "Favorite Existing") {
    return;
  }
  if (ref.kind === "file") {
    store.favoriteFile(ref.id);
    await revealExisting(store, treeView, ref);
  } else {
    store.favoriteFolder(ref.id);
    await revealExisting(store, treeView, ref);
  }
}

async function revealExisting(
  store: ShelfStore,
  treeView: vscode.TreeView<ShelfNode>,
  ref: FileRef | FolderRef,
): Promise<void> {
  const container = store.getRefParent(ref.id);
  if (!container) {
    return;
  }
  const node =
    ref.kind === "file"
      ? buildFileNode(ref, container.parent.id)
      : buildFolderNode(ref, container.parent.id);
  await revealRef(treeView, node, ref.kind);
}

async function revealRef(
  treeView: vscode.TreeView<ShelfNode>,
  node: ShelfNode,
  kind: "file" | "folder",
): Promise<void> {
  try {
    await treeView.reveal(node, { select: true, focus: false, expand: true });
  } catch (err) {
    logError(`revealing pinned ${kind}`, err);
  }
}

function requireFolderEntry(
  node: ShelfNode | undefined,
): Extract<ShelfNode, { kind: "folderEntry" }> {
  if (!node || node.kind !== "folderEntry" || node.isSymlink) {
    throw new Error("This command needs a file or folder you're browsing.");
  }
  return node;
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
