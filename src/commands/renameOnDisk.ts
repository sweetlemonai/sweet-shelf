import * as nodePath from "node:path";
import * as vscode from "vscode";

import { logError } from "../util/logger";
import type { FileRef, FolderRef, ShelfNode } from "../shelf/types";
import type { ShelfStore } from "../shelf/store";

/**
 * Rename-on-disk commands.
 *
 * The hint copy ("This will rename the actual file on disk.") is the
 * key UX signal that distinguishes these from the cosmetic-only
 * "Rename Display Name…" commands from Task 5. Both verbs sit
 * adjacent in the right-click menu so the user can read both at
 * once.
 *
 * Live `validateInput` blocks bad names at the prompt; the store
 * also throws defensively on the same rules. On success the rename
 * has run and the store has been updated atomically.
 */

const FILE_TITLE = "Rename File on Disk";
const FOLDER_TITLE = "Rename Folder on Disk";
const HINT = "This will rename the actual file on disk.";

export function registerRenameOnDiskCommands(
  context: vscode.ExtensionContext,
  store: ShelfStore,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "sweetShelf.renameFileOnDisk",
      (node?: ShelfNode) =>
        runCommand(FILE_TITLE, () => renameFileOnDisk(store, node)),
    ),
    vscode.commands.registerCommand(
      "sweetShelf.renameFolderOnDisk",
      (node?: ShelfNode) =>
        runCommand(FOLDER_TITLE, () => renameFolderOnDisk(store, node)),
    ),
  );
}

async function renameFileOnDisk(
  store: ShelfStore,
  node: ShelfNode | undefined,
): Promise<void> {
  const ref = unwrapFileRef(node);
  if (!ref) {
    throw new Error("This command needs to be run on a file.");
  }
  const newName = await promptForOnDiskName(
    FILE_TITLE,
    nodePath.basename(ref.path),
  );
  if (!newName) {
    return;
  }
  try {
    await store.renameFileOnDisk(ref.id, newName);
  } catch (err) {
    logError(FILE_TITLE, err);
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith("Renamed on disk but")) {
      // Half-state recovery — already toasted by the store layer.
      return;
    }
    throw err;
  }
}

async function renameFolderOnDisk(
  store: ShelfStore,
  node: ShelfNode | undefined,
): Promise<void> {
  const ref = unwrapFolderRef(node);
  if (!ref) {
    throw new Error("This command needs to be run on a folder.");
  }
  const newName = await promptForOnDiskName(
    FOLDER_TITLE,
    nodePath.basename(ref.path),
  );
  if (!newName) {
    return;
  }
  await store.renameFolderOnDisk(ref.id, newName);
}

async function promptForOnDiskName(
  title: string,
  currentBasename: string,
): Promise<string | undefined> {
  return await vscode.window.showInputBox({
    title,
    prompt: HINT,
    value: currentBasename,
    validateInput: (input: string): string | null => {
      return validateNewNameForUI(input, currentBasename);
    },
  });
}

/**
 * UI-side mirror of the store's name validation. Same rules; same
 * order; the live error string surfaces under the input box. The
 * store re-validates defensively so a mismatch can't slip through.
 */
function validateNewNameForUI(
  input: string,
  currentName: string,
): string | null {
  if (input.length === 0) {
    return "Please enter a name.";
  }
  if (input.trim() !== input) {
    return "Name can't have leading or trailing spaces.";
  }
  if (input.includes("/") || input.includes("\\")) {
    return "Name can't contain / or \\.";
  }
  if (input.includes("\0")) {
    return "Name can't contain null bytes.";
  }
  if (input.length > 255) {
    return "Name is longer than 255 characters.";
  }
  if (input === currentName) {
    return "Same as current name.";
  }
  if (process.platform === "win32") {
    const stem = input.split(".")[0].toUpperCase();
    const reserved = new Set([
      "CON",
      "PRN",
      "AUX",
      "NUL",
      "COM1",
      "COM2",
      "COM3",
      "COM4",
      "COM5",
      "COM6",
      "COM7",
      "COM8",
      "COM9",
      "LPT1",
      "LPT2",
      "LPT3",
      "LPT4",
      "LPT5",
      "LPT6",
      "LPT7",
      "LPT8",
      "LPT9",
    ]);
    if (reserved.has(stem)) {
      return "That name is reserved on Windows.";
    }
    if (input.endsWith(".")) {
      return "Names can't end with a period on Windows.";
    }
  }
  return null;
}

function unwrapFileRef(node: ShelfNode | undefined): FileRef | null {
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

function unwrapFolderRef(node: ShelfNode | undefined): FolderRef | null {
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
