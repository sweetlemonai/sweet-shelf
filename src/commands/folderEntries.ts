import * as vscode from "vscode";

import type { ShelfNode } from "../shelf/types";
import type { ShelfStore } from "../shelf/store";

/**
 * Inline-browsed `folderEntry` nodes carry no commands of their own
 * after Task 16 — favoriting works via the generic Add/Remove from
 * Favorites action contributed in `commands/favorites.ts`, which
 * resolves a path from any sidebar node (including folderEntry).
 *
 * The previous "Add to Category…" command has been removed from the
 * spec's right-click surface; this module now exists as a no-op
 * registration so the wiring in `commands/index.ts` stays uniform.
 */
export function registerFolderEntryCommands(
  _context: vscode.ExtensionContext,
  _store: ShelfStore,
  _treeView: vscode.TreeView<ShelfNode>,
): void {
  // Intentional no-op.
}
