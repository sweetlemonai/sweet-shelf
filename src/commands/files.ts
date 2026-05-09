import * as vscode from "vscode";

import { buildFileNode } from "../ui/treeItemBuilders";
import { logError } from "../util/logger";
import { pickCategoryId } from "../ui/quickPicks";
import {
  AlreadyOnShelfError,
  type FileRef,
  type ShelfNode,
} from "../shelf/types";
import type { ShelfStore } from "../shelf/store";

/**
 * File command handlers.
 *
 * Open commands accept either a `file` shelf node or a `folderEntry`
 * file (inline-browsed file): a small abstraction (`fileTarget`) folds
 * both into "URI to open" plus an optional id to record-opened-on.
 * `recordOpened` only fires for shelf refs — inline-browsed files
 * aren't on the shelf and won't surface in Recent (Task 6).
 *
 * `_openFileDefault` is the single-click dispatcher bound to
 * TreeItem's `command`. Reads the configured action and delegates.
 */

export function registerFileCommands(
  context: vscode.ExtensionContext,
  store: ShelfStore,
  treeView: vscode.TreeView<ShelfNode>,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "sweetShelf.addFile",
      (node?: ShelfNode) =>
        runCommand("Add File", () => addFile(store, treeView, node)),
    ),
    vscode.commands.registerCommand(
      "sweetShelf.removeFile",
      (node?: ShelfNode) =>
        runCommand("Remove File", () => removeFile(store, node)),
    ),
    vscode.commands.registerCommand(
      "sweetShelf.openFile",
      (node?: ShelfNode) =>
        runCommand("Open File", () => openFile(store, node)),
    ),
    vscode.commands.registerCommand(
      "sweetShelf.openFileToSide",
      (node?: ShelfNode) =>
        runCommand("Open to Side", () => openFileToSide(store, node)),
    ),
    vscode.commands.registerCommand(
      "sweetShelf._openFileDefault",
      (node?: ShelfNode) =>
        runCommand("Open File", () => openFileDefault(store, node)),
    ),
  );
}

async function addFile(
  store: ShelfStore,
  treeView: vscode.TreeView<ShelfNode>,
  invokedFrom: ShelfNode | undefined,
): Promise<void> {
  const preselectedCategoryId = preselectedCategoryFrom(invokedFrom);
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    openLabel: "Add to Sweet Shelf",
  });
  if (!picked || picked.length === 0) {
    return;
  }
  const filePath = picked[0].fsPath;

  const categoryId =
    preselectedCategoryId ??
    (await pickCategoryId(store, "Where should this file go?"));
  if (!categoryId) {
    return;
  }

  try {
    const ref = store.addFile(categoryId, filePath);
    await revealRef(treeView, ref, categoryId);
  } catch (err) {
    if (err instanceof AlreadyOnShelfError) {
      void vscode.window.showInformationMessage(`Sweet Shelf: ${err.message}`);
      return;
    }
    throw err;
  }
}

function removeFile(store: ShelfStore, node: ShelfNode | undefined): void {
  const id = fileRefIdFromNode(node);
  if (!id) {
    throw new Error("This command needs to be run on a file.");
  }
  store.removeFile(id);
}

/**
 * Extract the underlying FileRef id from any node that wraps one
 * (Library `file`, or a favorites/recent entry whose ref is a file).
 * Returns `null` for anything else — callers throw the user-facing
 * error so the message can match the command being run.
 */
function fileRefIdFromNode(node: ShelfNode | undefined): string | null {
  if (!node) {
    return null;
  }
  if (node.kind === "file") {
    return node.file.id;
  }
  if (
    (node.kind === "favoritesEntry" || node.kind === "recentEntry") &&
    node.ref.kind === "file"
  ) {
    return node.ref.id;
  }
  return null;
}

async function openFile(
  store: ShelfStore,
  node: ShelfNode | undefined,
): Promise<void> {
  const target = fileTarget(node);
  await tryOpenFile(target.uri, vscode.ViewColumn.Active);
  if (target.recordOnId) {
    store.recordOpened(target.recordOnId);
  }
}

async function openFileToSide(
  store: ShelfStore,
  node: ShelfNode | undefined,
): Promise<void> {
  const target = fileTarget(node);
  await tryOpenFile(target.uri, vscode.ViewColumn.Beside);
  if (target.recordOnId) {
    store.recordOpened(target.recordOnId);
  }
}

async function openFileDefault(
  store: ShelfStore,
  node: ShelfNode | undefined,
): Promise<void> {
  const target = fileTarget(node);
  const action = vscode.workspace
    .getConfiguration("sweetShelf")
    .get<string>("defaultFileClickAction", "open");
  const column =
    action === "openToSide" ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active;
  await tryOpenFile(target.uri, column);
  if (target.recordOnId) {
    store.recordOpened(target.recordOnId);
  }
}

interface FileTarget {
  uri: vscode.Uri;
  /** Set only when the open should be recorded (shelf refs); null for inline-browsed files. */
  recordOnId: string | null;
}

function fileTarget(node: ShelfNode | undefined): FileTarget {
  if (!node) {
    throw new Error("This command needs a file.");
  }
  if (node.kind === "file") {
    return { uri: vscode.Uri.file(node.file.path), recordOnId: node.file.id };
  }
  if (
    (node.kind === "favoritesEntry" || node.kind === "recentEntry") &&
    node.ref.kind === "file"
  ) {
    return { uri: vscode.Uri.file(node.ref.path), recordOnId: node.ref.id };
  }
  if (node.kind === "folderEntry" && !node.isDirectory && !node.isSymlink) {
    return { uri: node.uri, recordOnId: null };
  }
  throw new Error("This command needs a file.");
}

async function tryOpenFile(
  uri: vscode.Uri,
  column: vscode.ViewColumn,
): Promise<void> {
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { viewColumn: column });
  } catch (err) {
    logError(`opening ${uri.fsPath}`, err);
    void vscode.window.showWarningMessage(
      "Sweet Shelf: couldn't open this file. It may have been moved or deleted.",
    );
  }
}

async function revealRef(
  treeView: vscode.TreeView<ShelfNode>,
  ref: FileRef,
  parentCategoryId: string,
): Promise<void> {
  const node = buildFileNode(ref, parentCategoryId);
  try {
    await treeView.reveal(node, { select: true, focus: false, expand: true });
  } catch (err) {
    logError("revealing new file", err);
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
