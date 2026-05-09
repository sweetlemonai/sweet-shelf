import * as vscode from "vscode";

import { buildCategoryNode } from "../ui/treeItemBuilders";
import {
  countDescendantsByKind,
  totalDescendants,
} from "../shelf/categories";
import { describeDescendantCounts } from "../util/grammar";
import { logError } from "../util/logger";
import { promptForCategoryName } from "../ui/prompts";
import type { Category, ShelfNode } from "../shelf/types";
import type { ShelfStore } from "../shelf/store";

/**
 * Category command handlers.
 *
 * Each handler is wrapped in `runCommand` so unexpected errors flow to
 * the output channel + a friendly toast instead of crashing the host.
 * Validation lives in two places: live `validateInput` in the prompt
 * (good UX) and a defensive throw in `ShelfStore` (correctness).
 */

const NEW_CATEGORY_TITLE = "New Sweet Shelf Category";
const NEW_SUBCATEGORY_TITLE = "New Sweet Shelf Subcategory";
const RENAME_TITLE = "Rename Sweet Shelf Category";

export function registerCategoryCommands(
  context: vscode.ExtensionContext,
  store: ShelfStore,
  treeView: vscode.TreeView<ShelfNode>,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "sweetShelf.newCategory",
      () => runCommand("New Category", () => newCategory(store, treeView)),
    ),
    vscode.commands.registerCommand(
      "sweetShelf.newSubcategory",
      (node?: ShelfNode) =>
        runCommand("New Subcategory", () =>
          newSubcategory(store, treeView, node),
        ),
    ),
    vscode.commands.registerCommand(
      "sweetShelf.renameCategory",
      (node?: ShelfNode) =>
        runCommand("Rename Category", () => renameCategory(store, node)),
    ),
    vscode.commands.registerCommand(
      "sweetShelf.removeCategory",
      (node?: ShelfNode) =>
        runCommand("Remove Category", () => removeCategory(store, node)),
    ),
    vscode.commands.registerCommand(
      "sweetShelf.moveCategoryUp",
      (node?: ShelfNode) =>
        runCommand("Move Category Up", () => moveCategoryByOne(store, node, -1)),
    ),
    vscode.commands.registerCommand(
      "sweetShelf.moveCategoryDown",
      (node?: ShelfNode) =>
        runCommand("Move Category Down", () => moveCategoryByOne(store, node, 1)),
    ),
  );
}

async function newCategory(
  store: ShelfStore,
  treeView: vscode.TreeView<ShelfNode>,
): Promise<void> {
  const name = await promptForCategoryName({
    title: NEW_CATEGORY_TITLE,
    prompt: "What would you like to call this category?",
  });
  if (!name) {
    return;
  }
  const created = store.createCategory(null, name);
  await revealCategory(treeView, created, null);
}

async function newSubcategory(
  store: ShelfStore,
  treeView: vscode.TreeView<ShelfNode>,
  node: ShelfNode | undefined,
): Promise<void> {
  const parent = requireCategoryNode(node);
  const name = await promptForCategoryName({
    title: NEW_SUBCATEGORY_TITLE,
    prompt: `Add a subcategory inside "${parent.category.label}".`,
  });
  if (!name) {
    return;
  }
  const created = store.createCategory(parent.category.id, name);
  await revealCategory(treeView, created, parent.category.id);
}

async function renameCategory(
  store: ShelfStore,
  node: ShelfNode | undefined,
): Promise<void> {
  const target = requireCategoryNode(node);
  const newName = await promptForCategoryName({
    title: RENAME_TITLE,
    value: target.category.label,
  });
  if (!newName) {
    return;
  }
  store.renameCategory(target.category.id, newName);
}

async function removeCategory(
  store: ShelfStore,
  node: ShelfNode | undefined,
): Promise<void> {
  const target = requireCategoryNode(node);
  const live = store.findCategory(target.category.id);
  if (!live) {
    return;
  }
  const total = totalDescendants(live);
  const shouldConfirm =
    total > 0 &&
    vscode.workspace
      .getConfiguration("sweetShelf")
      .get<boolean>("confirmRemoveCategory", true);

  if (shouldConfirm) {
    const phrase = describeDescendantCounts(countDescendantsByKind(live));
    const choice = await vscode.window.showWarningMessage(
      `Remove "${live.label}" and its ${phrase} from Sweet Shelf? Your real files are not affected.`,
      { modal: true },
      "Remove from Sweet Shelf",
    );
    if (choice !== "Remove from Sweet Shelf") {
      return;
    }
  }
  store.removeCategory(live.id);
}

function moveCategoryByOne(
  store: ShelfStore,
  node: ShelfNode | undefined,
  delta: -1 | 1,
): void {
  const target = requireCategoryNode(node);
  const info = store.getCategoryParent(target.category.id);
  if (!info) {
    return;
  }
  const parentId = info.parent ? info.parent.id : null;
  const newIndex = info.index + delta;
  store.moveCategory(target.category.id, parentId, newIndex);
}

function requireCategoryNode(
  node: ShelfNode | undefined,
): Extract<ShelfNode, { kind: "category" }> {
  if (!node || node.kind !== "category") {
    throw new Error("This command needs to be run on a category.");
  }
  return node;
}

async function revealCategory(
  treeView: vscode.TreeView<ShelfNode>,
  category: Category,
  parentId: string | null,
): Promise<void> {
  const node = buildCategoryNode(category, parentId);
  try {
    await treeView.reveal(node, { select: true, focus: false, expand: true });
  } catch (err) {
    logError("revealing new category", err);
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
