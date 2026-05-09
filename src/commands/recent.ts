import * as vscode from "vscode";

import { hasRecentEntries } from "../shelf/recent";
import { logError } from "../util/logger";
import type { ShelfNode } from "../shelf/types";
import type { ShelfStore } from "../shelf/store";

/**
 * Recent commands.
 *
 * "Remove from Recent" clears `lastOpenedAt` on a single ref so it
 * stops surfacing in the Recent section. The ref itself remains in
 * Library and stays favorited if it was — Recent is purely a view.
 *
 * "Clear Recent" is the bulk version. Confirmed via modal because
 * the user is asking for "everything"; skipped silently when there's
 * already nothing to clear so the user doesn't see a confirmation
 * for a no-op.
 */

export function registerRecentCommands(
  context: vscode.ExtensionContext,
  store: ShelfStore,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "sweetShelf.removeFromRecent",
      (node?: ShelfNode) =>
        runCommand("Remove from Recent", () => removeFromRecent(store, node)),
    ),
    vscode.commands.registerCommand("sweetShelf.clearRecent", () =>
      runCommand("Clear Recent", () => clearRecent(store)),
    ),
  );
}

function removeFromRecent(
  store: ShelfStore,
  node: ShelfNode | undefined,
): void {
  if (!node || node.kind !== "recentEntry") {
    throw new Error("This command needs to be run on a Recent item.");
  }
  store.clearLastOpened(node.ref.id);
}

async function clearRecent(store: ShelfStore): Promise<void> {
  if (!hasRecentEntries(store.library)) {
    return;
  }
  const choice = await vscode.window.showWarningMessage(
    "Clear your Recent list? Your real files are not affected.",
    { modal: true },
    "Clear Recent",
  );
  if (choice !== "Clear Recent") {
    return;
  }
  store.clearAllRecent();
  void vscode.window.showInformationMessage("Sweet Shelf: Recent cleared.");
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
