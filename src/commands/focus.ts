import * as vscode from "vscode";

import { logError } from "../util/logger";
import type { ShelfNode } from "../shelf/types";
import type { ShelfStore } from "../shelf/store";

/**
 * Focus Mode commands.
 *
 * "Focus on this" works from any node that wraps a focusable shelf
 * item: a Library `category`, a Library `folder` (any contextValue
 * variant), or a `favoritesEntry`/`recentEntry` whose underlying ref
 * is a folder. Files are not focusable — there'd be nothing to render
 * in the sidebar — and the menu `when` clauses already hide the entry
 * for file rows. The handler still validates defensively.
 *
 * Entering focus while another item is focused silently switches.
 * Re-entering on the current focus is a no-op. The store throws on
 * orphaned ids; the handler catches and surfaces a friendly toast.
 */

export function registerFocusCommands(
  context: vscode.ExtensionContext,
  store: ShelfStore,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "sweetShelf.enterFocus",
      (node?: ShelfNode) =>
        runCommand("Focus on this", () => enterFocus(store, node)),
    ),
    vscode.commands.registerCommand("sweetShelf.exitFocus", () =>
      runCommand("Show All", () => exitFocus(store)),
    ),
  );
}

function enterFocus(store: ShelfStore, node: ShelfNode | undefined): void {
  const id = focusableIdFromNode(node);
  if (!id) {
    throw new Error("This command needs a category or folder.");
  }
  store.enterFocus(id);
}

function exitFocus(store: ShelfStore): void {
  store.exitFocus();
}

function focusableIdFromNode(node: ShelfNode | undefined): string | null {
  if (!node) {
    return null;
  }
  switch (node.kind) {
    case "category":
      return node.category.id;
    case "folder":
      return node.folder.id;
    case "recentEntry":
      return node.ref.kind === "folder" ? node.ref.id : null;
    case "favoritesEntry":
      // Favorites are path-based and have no Library id to focus on.
      // The right-click menu doesn't surface "Focus on this" on
      // favorites for that reason.
      return null;
    default:
      return null;
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
