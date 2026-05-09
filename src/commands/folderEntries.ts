import * as vscode from "vscode";

import { AlreadyOnShelfError, type ShelfNode } from "../shelf/types";
import {
  buildFileNode,
  buildFolderNode,
} from "../shelf/treeProvider";
import { logError } from "../util/logger";
import { pickCategoryId } from "../ui/quickPicks";
import type { ShelfStore } from "../shelf/store";

/**
 * Commands specific to inline-browsed `folderEntry` nodes.
 *
 * Right now there's just one: "Add to Sweet Shelf," which prompts
 * for a destination category (using the same Quick Pick as Task 3's
 * Add File / Add Folder) and pins the entry as a top-level shelf
 * reference. Path-uniqueness is enforced by the store, surfaced as
 * the friendly "already on your shelf in X" toast.
 *
 * Symlinks don't get this command — their menu (`folderEntry.symlink`)
 * exposes only Reveal and Copy Path. Drag-to-shelf still works for
 * symlinks via the OS-drop loop, which stats and resolves the target.
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
        runCommand("Add to Sweet Shelf", () =>
          addFolderEntryToShelf(store, treeView, node),
        ),
    ),
  );
}

async function addFolderEntryToShelf(
  store: ShelfStore,
  treeView: vscode.TreeView<ShelfNode>,
  node: ShelfNode | undefined,
): Promise<void> {
  if (!node || node.kind !== "folderEntry" || node.isSymlink) {
    throw new Error("This command needs an inline-browsed file or folder.");
  }
  const path = node.uri.fsPath;
  const categoryId = await pickCategoryId(
    store,
    node.isDirectory
      ? "Where should this folder go?"
      : "Where should this file go?",
  );
  if (!categoryId) {
    return;
  }
  try {
    if (node.isDirectory) {
      const ref = store.addFolder(categoryId, path);
      try {
        await treeView.reveal(buildFolderNode(ref, categoryId), {
          select: true,
          focus: false,
          expand: true,
        });
      } catch (err) {
        logError("revealing pinned folder", err);
      }
    } else {
      const ref = store.addFile(categoryId, path);
      try {
        await treeView.reveal(buildFileNode(ref, categoryId), {
          select: true,
          focus: false,
          expand: true,
        });
      } catch (err) {
        logError("revealing pinned file", err);
      }
    }
  } catch (err) {
    if (err instanceof AlreadyOnShelfError) {
      void vscode.window.showInformationMessage(`Sweet Shelf: ${err.message}`);
      return;
    }
    throw err;
  }
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
