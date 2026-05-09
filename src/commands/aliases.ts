import * as vscode from "vscode";

import { logError } from "../util/logger";
import { promptForDisplayName } from "../ui/prompts";
import type { ShelfNode } from "../shelf/types";
import type { ShelfStore } from "../shelf/store";

/**
 * Display-name alias commands for shelf file and folder refs.
 *
 * "Rename Display Name…" sets an alias that wins over the basename in
 * the tree label. The hint copy explicitly tells the user the file on
 * disk is unaffected — that's the difference between Sweet Shelf's
 * idea of a name and the filesystem's.
 *
 * "Clear Display Name" removes the alias and re-enables automatic
 * context disambiguation. Only visible when an alias is set (the
 * tree provider emits `file.aliased` / `folder.aliased` contextValue
 * for those, gating the menu entry).
 *
 * Categories use the simpler "Rename" command (in commands/categories.ts).
 * Categories don't have an underlying basename to disambiguate from, so
 * the long form would be misleading.
 */

const RENAME_HINT =
  "Display name only — this won't rename the file on disk.";
const RENAME_FILE_TITLE = "Rename File Display Name";
const RENAME_FOLDER_TITLE = "Rename Folder Display Name";

export function registerAliasCommands(
  context: vscode.ExtensionContext,
  store: ShelfStore,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "sweetShelf.renameFileDisplayName",
      (node?: ShelfNode) =>
        runCommand("Rename File Display Name", () =>
          renameFileDisplayName(store, node),
        ),
    ),
    vscode.commands.registerCommand(
      "sweetShelf.clearFileDisplayName",
      (node?: ShelfNode) =>
        runCommand("Clear File Display Name", () =>
          clearFileDisplayName(store, node),
        ),
    ),
    vscode.commands.registerCommand(
      "sweetShelf.renameFolderDisplayName",
      (node?: ShelfNode) =>
        runCommand("Rename Folder Display Name", () =>
          renameFolderDisplayName(store, node),
        ),
    ),
    vscode.commands.registerCommand(
      "sweetShelf.clearFolderDisplayName",
      (node?: ShelfNode) =>
        runCommand("Clear Folder Display Name", () =>
          clearFolderDisplayName(store, node),
        ),
    ),
  );
}

async function renameFileDisplayName(
  store: ShelfStore,
  node: ShelfNode | undefined,
): Promise<void> {
  const ref = unwrapFileRef(node);
  if (!ref) {
    throw new Error("This command needs to be run on a file.");
  }
  const current = ref.alias ?? ref.label;
  const newName = await promptForDisplayName({
    title: RENAME_FILE_TITLE,
    prompt: RENAME_HINT,
    value: current,
  });
  if (!newName) {
    return;
  }
  store.setFileAlias(ref.id, newName);
}

function clearFileDisplayName(
  store: ShelfStore,
  node: ShelfNode | undefined,
): void {
  const ref = unwrapFileRef(node);
  if (!ref) {
    throw new Error("This command needs to be run on a file.");
  }
  store.clearFileAlias(ref.id);
}

async function renameFolderDisplayName(
  store: ShelfStore,
  node: ShelfNode | undefined,
): Promise<void> {
  const ref = unwrapFolderRef(node);
  if (!ref) {
    throw new Error("This command needs to be run on a folder.");
  }
  const current = ref.alias ?? ref.label;
  const newName = await promptForDisplayName({
    title: RENAME_FOLDER_TITLE,
    prompt: RENAME_HINT,
    value: current,
  });
  if (!newName) {
    return;
  }
  store.setFolderAlias(ref.id, newName);
}

function clearFolderDisplayName(
  store: ShelfStore,
  node: ShelfNode | undefined,
): void {
  const ref = unwrapFolderRef(node);
  if (!ref) {
    throw new Error("This command needs to be run on a folder.");
  }
  store.clearFolderAlias(ref.id);
}

function unwrapFileRef(
  node: ShelfNode | undefined,
): { id: string; alias?: string; label: string } | null {
  if (!node) {
    return null;
  }
  if (node.kind === "file") {
    return node.file;
  }
  if (
    (node.kind === "favoritesEntry" || node.kind === "recentEntry") &&
    node.ref.kind === "file"
  ) {
    return node.ref;
  }
  return null;
}

function unwrapFolderRef(
  node: ShelfNode | undefined,
): { id: string; alias?: string; label: string } | null {
  if (!node) {
    return null;
  }
  if (node.kind === "folder") {
    return node.folder;
  }
  if (
    (node.kind === "favoritesEntry" || node.kind === "recentEntry") &&
    node.ref.kind === "folder"
  ) {
    return node.ref;
  }
  return null;
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
