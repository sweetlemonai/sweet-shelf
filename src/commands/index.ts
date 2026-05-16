import * as vscode from "vscode";

import { logError } from "../util/logger";
import { registerAliasCommands } from "./aliases";
import { registerBrokenLinkCommands } from "./brokenLinks";
import { registerCategoryCommands } from "./categories";
import { registerColorCommands } from "./color";
import { registerExportImportCommands } from "./exportImport";
import { registerFavoriteCommands } from "./favorites";
import { registerFileCommands } from "./files";
import { registerFocusCommands } from "./focus";
import { registerFolderCommands } from "./folders";
import { registerFolderEntryCommands } from "./folderEntries";
import { registerRecentCommands } from "./recent";
import { registerRenameOnDiskCommands } from "./renameOnDisk";
import { registerSearchCommands } from "./search";
import { registerSettingsCommands } from "./settings";
import { registerSharedCommands } from "./shared";
import type { BrokenLinkCache } from "../shelf/brokenLinks";
import type { ShelfNode } from "../shelf/types";
import type { ShelfStore } from "../shelf/store";
import type { LibraryTreeProvider } from "../ui/libraryTreeProvider";

/** Wire every command Sweet Shelf contributes. Called once from `activate`. */
export function registerCommands(
  context: vscode.ExtensionContext,
  store: ShelfStore,
  treeView: vscode.TreeView<ShelfNode>,
  brokenLinks: BrokenLinkCache,
  provider: LibraryTreeProvider,
): void {
  registerCategoryCommands(context, store, treeView);
  registerFileCommands(context, store, treeView);
  registerFolderCommands(context, store, treeView);
  registerFolderEntryCommands(context, store, treeView);
  registerAliasCommands(context, store);
  registerFavoriteCommands(context, store, treeView, provider);
  registerRecentCommands(context, store);
  registerFocusCommands(context, store);
  registerColorCommands(context, store);
  registerRenameOnDiskCommands(context, store);
  registerBrokenLinkCommands(context, store, brokenLinks);
  registerSearchCommands(context, store, treeView, brokenLinks, provider);
  registerSettingsCommands(context);
  registerExportImportCommands(context, store, brokenLinks);
  registerSharedCommands(context);
  registerRevealConfigCommand(context, store);
}

function registerRevealConfigCommand(
  context: vscode.ExtensionContext,
  store: ShelfStore,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("sweetShelf.revealConfigFile", async () => {
      try {
        // `revealFileInOS` opens the parent dir with the file
        // selected — Finder on macOS, Explorer on Windows, file
        // manager on Linux. The user can then open with their
        // preferred editor or do other file ops. (Task 9 changed
        // this from "open as text in VS Code" — the OS-reveal is
        // a friendlier surface for inspection and editing.)
        await vscode.commands.executeCommand(
          "revealFileInOS",
          store.configFileUri,
        );
      } catch (err) {
        logError("revealConfigFile", err);
        const message = err instanceof Error ? err.message : String(err);
        void vscode.window.showWarningMessage(
          `Sweet Shelf: couldn't reveal shelf.json (${message}).`,
        );
      }
    }),
  );
}
