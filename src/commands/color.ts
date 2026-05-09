import * as vscode from "vscode";

import { ALL_COLOR_LABELS, type ColorLabel } from "../shelf/color";
import { logError } from "../util/logger";
import type { ShelfNode } from "../shelf/types";
import type { ShelfStore } from "../shelf/store";

/**
 * Color label commands.
 *
 * Eight commands total: seven `setColorX` + one `clearColor`. Each
 * is kind-agnostic — the handler dispatches on the right-clicked
 * node's `kind` and calls the appropriate store mutator. This is a
 * deliberate deviation from the brief's "6 commands split by kind":
 * `package.json` submenus invoke commands by id with no arguments,
 * so we can't have a single `setFileColor` command that accepts a
 * color value. The kind-agnostic shape keeps the command registry
 * to 8 entries instead of 24.
 */

export function registerColorCommands(
  context: vscode.ExtensionContext,
  store: ShelfStore,
): void {
  for (const color of ALL_COLOR_LABELS) {
    context.subscriptions.push(
      vscode.commands.registerCommand(
        commandIdFor(color),
        (node?: ShelfNode) =>
          runCommand(`Set color: ${color}`, () =>
            applyColor(store, node, color),
          ),
      ),
    );
  }
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "sweetShelf.clearColor",
      (node?: ShelfNode) =>
        runCommand("Clear color", () => applyColor(store, node, null)),
    ),
  );
}

/** Command id for the "set color to X" command, by enum value. */
export function commandIdFor(color: ColorLabel): string {
  switch (color) {
    case "red":
      return "sweetShelf.setColorRed";
    case "orange":
      return "sweetShelf.setColorOrange";
    case "yellow":
      return "sweetShelf.setColorYellow";
    case "green":
      return "sweetShelf.setColorGreen";
    case "blue":
      return "sweetShelf.setColorBlue";
    case "purple":
      return "sweetShelf.setColorPurple";
    case "gray":
      return "sweetShelf.setColorGray";
    default:
      return assertNever(color);
  }
}

function applyColor(
  store: ShelfStore,
  node: ShelfNode | undefined,
  color: ColorLabel | null,
): void {
  if (!node) {
    throw new Error("This command needs a category, file, or folder.");
  }
  switch (node.kind) {
    case "category":
      if (color === null) {
        store.clearCategoryColorLabel(node.category.id);
      } else {
        store.setCategoryColorLabel(node.category.id, color);
      }
      return;
    case "file":
      if (color === null) {
        store.clearFileColorLabel(node.file.id);
      } else {
        store.setFileColorLabel(node.file.id, color);
      }
      return;
    case "folder":
      if (color === null) {
        store.clearFolderColorLabel(node.folder.id);
      } else {
        store.setFolderColorLabel(node.folder.id, color);
      }
      return;
    case "favoritesEntry":
    case "recentEntry": {
      const id = node.ref.id;
      if (node.ref.kind === "file") {
        if (color === null) {
          store.clearFileColorLabel(id);
        } else {
          store.setFileColorLabel(id, color);
        }
      } else {
        if (color === null) {
          store.clearFolderColorLabel(id);
        } else {
          store.setFolderColorLabel(id, color);
        }
      }
      return;
    }
    default:
      throw new Error("This command needs a category, file, or folder.");
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

function assertNever(value: never): never {
  throw new Error(`Unexpected variant: ${JSON.stringify(value)}`);
}
