import * as nodePath from "node:path";
import * as vscode from "vscode";

import { buildFolderNode } from "../ui/treeItemBuilders";
import { logError } from "../util/logger";
import { pickCategoryId } from "../ui/quickPicks";
import {
  AlreadyOnShelfError,
  type FolderRef,
  type ShelfNode,
} from "../shelf/types";
import type { ShelfStore } from "../shelf/store";

/**
 * Folder command handlers.
 *
 * Open commands accept either a `folder` shelf node or a `folderEntry`
 * directory: `folderTarget` folds both into "URI to open" plus an
 * optional id to record-opened-on. `recordOpened` only fires for shelf
 * refs; inline-browsed folders aren't on the shelf.
 *
 * `_openFolderDefault` is the click dispatcher. The `browse` action
 * now expands the folder ref inline via `treeView.reveal({ expand })`,
 * replacing the Task 3 toast-and-fallback. The `globalState` key
 * `sweetShelf.browseFallbackShown` is left in place — it's a one-shot
 * and harmless to leave.
 */

export function registerFolderCommands(
  context: vscode.ExtensionContext,
  store: ShelfStore,
  treeView: vscode.TreeView<ShelfNode>,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "sweetShelf.addFolder",
      (node?: ShelfNode) =>
        runCommand("Add Folder", () => addFolder(store, treeView, node)),
    ),
    vscode.commands.registerCommand(
      "sweetShelf.removeFolder",
      (node?: ShelfNode) =>
        runCommand("Remove Folder", () => removeFolder(store, node)),
    ),
    vscode.commands.registerCommand(
      "sweetShelf.openFolderInCurrentWindow",
      (node?: ShelfNode) =>
        runCommand("Open Folder", () =>
          openFolderInWindow(store, node, false),
        ),
    ),
    vscode.commands.registerCommand(
      "sweetShelf.openFolderInNewWindow",
      (node?: ShelfNode) =>
        runCommand("Open Folder in New Window", () =>
          openFolderInWindow(store, node, true),
        ),
    ),
    vscode.commands.registerCommand(
      "sweetShelf.openTerminalHere",
      (node?: ShelfNode) =>
        runCommand("Open Terminal Here", () => openTerminalHere(node)),
    ),
    vscode.commands.registerCommand(
      "sweetShelf._openFolderDefault",
      (node?: ShelfNode) =>
        runCommand("Open Folder", () =>
          openFolderDefault(store, treeView, node),
        ),
    ),
  );
}

async function addFolder(
  store: ShelfStore,
  treeView: vscode.TreeView<ShelfNode>,
  invokedFrom: ShelfNode | undefined,
): Promise<void> {
  const preselectedCategoryId = preselectedCategoryFrom(invokedFrom);
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: "Add to Sweet Shelf",
  });
  if (!picked || picked.length === 0) {
    return;
  }
  const folderPath = picked[0].fsPath;

  const categoryId =
    preselectedCategoryId ??
    (await pickCategoryId(store, "Where should this folder go?"));
  if (!categoryId) {
    return;
  }

  try {
    const ref = store.addFolder(categoryId, folderPath);
    await revealRef(treeView, ref, categoryId);
  } catch (err) {
    if (err instanceof AlreadyOnShelfError) {
      void vscode.window.showInformationMessage(`Sweet Shelf: ${err.message}`);
      return;
    }
    throw err;
  }
}

function removeFolder(store: ShelfStore, node: ShelfNode | undefined): void {
  const id = folderRefIdFromNode(node);
  if (!id) {
    throw new Error("This command needs to be run on a folder.");
  }
  store.removeFolder(id);
}

function folderRefIdFromNode(node: ShelfNode | undefined): string | null {
  if (!node) {
    return null;
  }
  if (node.kind === "folder") {
    return node.folder.id;
  }
  if (
    (node.kind === "favoritesEntry" || node.kind === "recentEntry") &&
    node.ref.kind === "folder"
  ) {
    return node.ref.id;
  }
  return null;
}

async function openFolderInWindow(
  store: ShelfStore,
  node: ShelfNode | undefined,
  forceNewWindow: boolean,
): Promise<void> {
  const target = folderTarget(node);
  await runOpenFolder(target.uri, forceNewWindow);
  if (target.recordOnId) {
    store.recordOpened(target.recordOnId);
  }
}

async function openTerminalHere(node: ShelfNode | undefined): Promise<void> {
  const target = folderTarget(node);
  const terminal = vscode.window.createTerminal({
    name: target.label,
    cwd: target.uri.fsPath,
  });
  terminal.show();
}

async function openFolderDefault(
  store: ShelfStore,
  treeView: vscode.TreeView<ShelfNode>,
  node: ShelfNode | undefined,
): Promise<void> {
  if (!node || node.kind !== "folder") {
    throw new Error("This command needs a folder.");
  }
  const folder = node.folder;
  const action = vscode.workspace
    .getConfiguration("sweetShelf")
    .get<string>("defaultFolderClickAction", "browse");

  if (action === "openInNewWindow") {
    await runOpenFolder(vscode.Uri.file(folder.path), true);
    store.recordOpened(folder.id);
    return;
  }
  if (action === "openInCurrentWindow") {
    await runOpenFolder(vscode.Uri.file(folder.path), false);
    store.recordOpened(folder.id);
    return;
  }
  // "browse" — expand inline. No recordOpened: browsing is lower
  // signal than an explicit open, and Task 6's Recent will lean on
  // explicit opens.
  try {
    await treeView.reveal(node, { expand: true });
  } catch (err) {
    logError("expanding folder ref", err);
  }
}

interface FolderTarget {
  uri: vscode.Uri;
  label: string;
  /** Set only for shelf refs; null for inline-browsed directories. */
  recordOnId: string | null;
}

function folderTarget(node: ShelfNode | undefined): FolderTarget {
  if (!node) {
    throw new Error("This command needs a folder.");
  }
  if (node.kind === "folder") {
    return {
      uri: vscode.Uri.file(node.folder.path),
      label: node.folder.label,
      recordOnId: node.folder.id,
    };
  }
  if (
    (node.kind === "favoritesEntry" || node.kind === "recentEntry") &&
    node.ref.kind === "folder"
  ) {
    return {
      uri: vscode.Uri.file(node.ref.path),
      label: node.ref.label,
      recordOnId: node.ref.id,
    };
  }
  if (node.kind === "folderEntry" && node.isDirectory && !node.isSymlink) {
    return {
      uri: node.uri,
      label: nodePath.basename(node.uri.fsPath) || node.uri.fsPath,
      recordOnId: null,
    };
  }
  throw new Error("This command needs a folder.");
}

async function runOpenFolder(
  uri: vscode.Uri,
  forceNewWindow: boolean,
): Promise<void> {
  try {
    await vscode.commands.executeCommand("vscode.openFolder", uri, forceNewWindow);
  } catch (err) {
    logError(`opening folder ${uri.fsPath}`, err);
    void vscode.window.showWarningMessage(
      "Sweet Shelf: couldn't open this folder. It may have been moved or deleted.",
    );
  }
}

async function revealRef(
  treeView: vscode.TreeView<ShelfNode>,
  ref: FolderRef,
  parentCategoryId: string,
): Promise<void> {
  const node = buildFolderNode(ref, parentCategoryId);
  try {
    await treeView.reveal(node, { select: true, focus: false, expand: true });
  } catch (err) {
    logError("revealing new folder", err);
  }
}

function preselectedCategoryFrom(node: ShelfNode | undefined): string | null {
  if (node && node.kind === "category") {
    return node.category.id;
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
