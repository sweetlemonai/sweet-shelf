import * as vscode from "vscode";

import { logError } from "../util/logger";
import type { FileRef, FolderRef, ShelfNode } from "../shelf/types";
import type { ShelfStore } from "../shelf/store";

/**
 * Favorites commands.
 *
 * Add / Remove from Favorites accept any node that wraps a shelf ref:
 *   - Library `file` / `folder`
 *   - `favoritesEntry` (Remove only — context menu hides Add there)
 *   - `recentEntry` (toggle from Recent)
 *
 * Move Up / Move Down only make sense on `favoritesEntry` rows; the
 * `when` clauses in package.json gate them accordingly. The store
 * silently no-ops at the top/bottom (matches the Move category pattern).
 */

export function registerFavoriteCommands(
  context: vscode.ExtensionContext,
  store: ShelfStore,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "sweetShelf.addToFavorites",
      (node?: ShelfNode) =>
        runCommand("Add to Favorites", () => toggleFavorite(store, node, true)),
    ),
    vscode.commands.registerCommand(
      "sweetShelf.removeFromFavorites",
      (node?: ShelfNode) =>
        runCommand("Remove from Favorites", () =>
          toggleFavorite(store, node, false),
        ),
    ),
    vscode.commands.registerCommand(
      "sweetShelf.moveFavoriteUp",
      (node?: ShelfNode) =>
        runCommand("Move Favorite Up", () =>
          moveFavorite(store, node, "up"),
        ),
    ),
    vscode.commands.registerCommand(
      "sweetShelf.moveFavoriteDown",
      (node?: ShelfNode) =>
        runCommand("Move Favorite Down", () =>
          moveFavorite(store, node, "down"),
        ),
    ),
  );
}

function toggleFavorite(
  store: ShelfStore,
  node: ShelfNode | undefined,
  favorite: boolean,
): void {
  const ref = unwrapRef(node);
  if (!ref) {
    throw new Error("This command needs a file or folder.");
  }
  if (ref.kind === "file") {
    if (favorite) {
      store.favoriteFile(ref.id);
    } else {
      store.unfavoriteFile(ref.id);
    }
  } else {
    if (favorite) {
      store.favoriteFolder(ref.id);
    } else {
      store.unfavoriteFolder(ref.id);
    }
  }
}

function moveFavorite(
  store: ShelfStore,
  node: ShelfNode | undefined,
  direction: "up" | "down",
): void {
  if (!node || node.kind !== "favoritesEntry") {
    throw new Error("This command needs to be run on a favorite.");
  }
  store.moveFavorite(node.ref.id, direction);
}

function unwrapRef(node: ShelfNode | undefined): FileRef | FolderRef | null {
  if (!node) {
    return null;
  }
  switch (node.kind) {
    case "file":
      return node.file;
    case "folder":
      return node.folder;
    case "favoritesEntry":
    case "recentEntry":
      return node.ref;
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
