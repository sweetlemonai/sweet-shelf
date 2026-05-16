import * as nodePath from "node:path";
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
  const target = aliasTarget(node, "file");
  if (!target) {
    throw new Error("This command needs to be run on a file.");
  }
  const newName = await promptForDisplayName({
    title: RENAME_FILE_TITLE,
    prompt: RENAME_HINT,
    value: target.current,
  });
  if (!newName) {
    return;
  }
  if (target.scope === "favorite") {
    store.setFavoriteAlias(target.id, newName);
  } else {
    store.setFileAlias(target.id, newName);
  }
}

function clearFileDisplayName(
  store: ShelfStore,
  node: ShelfNode | undefined,
): void {
  const target = aliasTarget(node, "file");
  if (!target) {
    throw new Error("This command needs to be run on a file.");
  }
  if (target.scope === "favorite") {
    store.clearFavoriteAlias(target.id);
  } else {
    store.clearFileAlias(target.id);
  }
}

async function renameFolderDisplayName(
  store: ShelfStore,
  node: ShelfNode | undefined,
): Promise<void> {
  const target = aliasTarget(node, "folder");
  if (!target) {
    throw new Error("This command needs to be run on a folder.");
  }
  const newName = await promptForDisplayName({
    title: RENAME_FOLDER_TITLE,
    prompt: RENAME_HINT,
    value: target.current,
  });
  if (!newName) {
    return;
  }
  if (target.scope === "favorite") {
    store.setFavoriteAlias(target.id, newName);
  } else {
    store.setFolderAlias(target.id, newName);
  }
}

function clearFolderDisplayName(
  store: ShelfStore,
  node: ShelfNode | undefined,
): void {
  const target = aliasTarget(node, "folder");
  if (!target) {
    throw new Error("This command needs to be run on a folder.");
  }
  if (target.scope === "favorite") {
    store.clearFavoriteAlias(target.id);
  } else {
    store.clearFolderAlias(target.id);
  }
}

interface AliasTarget {
  scope: "library" | "favorite";
  id: string;
  current: string;
}

function aliasTarget(
  node: ShelfNode | undefined,
  expected: "file" | "folder",
): AliasTarget | null {
  if (!node) {
    return null;
  }
  if (expected === "file" && node.kind === "file") {
    return {
      scope: "library",
      id: node.file.id,
      current: node.file.alias ?? node.file.label,
    };
  }
  if (expected === "folder" && node.kind === "folder") {
    return {
      scope: "library",
      id: node.folder.id,
      current: node.folder.alias ?? node.folder.label,
    };
  }
  if (node.kind === "favoritesEntry" && node.favorite.kind === expected) {
    const fav = node.favorite;
    return {
      scope: "favorite",
      id: fav.id,
      current: fav.alias ?? nodePath.basename(fav.path),
    };
  }
  if (node.kind === "recentEntry" && node.ref.kind === expected) {
    return {
      scope: "library",
      id: node.ref.id,
      current: node.ref.alias ?? node.ref.label,
    };
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
