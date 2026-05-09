import * as vscode from "vscode";

import type { Category } from "../shelf/types";
import type { ShelfStore } from "../shelf/store";

/**
 * Quick Pick helpers for category selection.
 *
 * Picker items are flattened from the category forest into breadcrumb
 * labels ("Books / Code Smarter / Drafts") so the user can find any
 * category regardless of nesting depth in a single list.
 */

interface CategoryPickItem extends vscode.QuickPickItem {
  categoryId: string;
}

/**
 * Show a Quick Pick listing every category as a breadcrumb-labelled
 * row. Returns the chosen category's id, or `undefined` if the user
 * cancelled. If there are no categories, returns `undefined` after
 * showing a friendly toast suggesting how to create one.
 *
 * `placeHolder` lets callers tailor the prompt ("Where should this
 * file go?" vs "Where should this folder go?").
 */
export async function pickCategoryId(
  store: ShelfStore,
  placeHolder: string,
): Promise<string | undefined> {
  const items = collectCategoryItems(store.library);
  if (items.length === 0) {
    void vscode.window.showInformationMessage(
      "Sweet Shelf: create a category first to add files or folders.",
    );
    return undefined;
  }
  const choice = await vscode.window.showQuickPick(items, {
    placeHolder,
    matchOnDescription: true,
  });
  return choice?.categoryId;
}

function collectCategoryItems(
  forest: readonly Category[],
): CategoryPickItem[] {
  const out: CategoryPickItem[] = [];
  for (const root of forest) {
    walk(root, [], out);
  }
  return out;
}

function walk(
  category: Category,
  trail: string[],
  out: CategoryPickItem[],
): void {
  const path = [...trail, category.label];
  out.push({
    label: path.join(" / "),
    categoryId: category.id,
  });
  for (const child of category.children) {
    if (child.kind === "category") {
      walk(child, path, out);
    }
  }
}
