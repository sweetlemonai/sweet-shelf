import * as vscode from "vscode";

import { logError } from "../util/logger";
import type { ShelfNode } from "../shelf/types";

/**
 * Commands that act identically on shelf items and inline-browsed
 * entries: reveal in the OS file manager, copy the absolute path.
 *
 * Reveal is registered three times — once per platform-specific
 * command id — so the menu label matches the host OS via `isMac` /
 * `isWindows` / `isLinux` `when` clauses. All three call into the
 * same handler.
 */

export function registerSharedCommands(
  context: vscode.ExtensionContext,
): void {
  const reveal = (node?: ShelfNode): Promise<void> =>
    runCommand("Reveal in OS", () => revealInOS(node));
  context.subscriptions.push(
    vscode.commands.registerCommand("sweetShelf.revealInFinder", reveal),
    vscode.commands.registerCommand("sweetShelf.revealInExplorer", reveal),
    vscode.commands.registerCommand("sweetShelf.openContainingFolder", reveal),
    vscode.commands.registerCommand(
      "sweetShelf.copyPath",
      (node?: ShelfNode) =>
        runCommand("Copy Path", () => copyPath(node)),
    ),
  );
}

async function revealInOS(node: ShelfNode | undefined): Promise<void> {
  const path = pathFromNode(node);
  await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(path));
}

async function copyPath(node: ShelfNode | undefined): Promise<void> {
  const path = pathFromNode(node);
  await vscode.env.clipboard.writeText(path);
  vscode.window.setStatusBarMessage("Path copied.", 2000);
}

function pathFromNode(node: ShelfNode | undefined): string {
  if (!node) {
    throw new Error("This command needs a file or folder.");
  }
  switch (node.kind) {
    case "file":
      return node.file.path;
    case "folder":
      return node.folder.path;
    case "favoritesEntry":
    case "recentEntry":
      return node.ref.path;
    case "folderEntry":
      return node.uri.fsPath;
    default:
      throw new Error("This command needs a file or folder.");
  }
}

async function runCommand(
  label: string,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    logError(label, err);
    const message = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`Sweet Shelf: ${message}`);
  }
}
