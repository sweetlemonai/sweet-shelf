import * as vscode from "vscode";

import { MAX_CATEGORY_LABEL_LENGTH } from "../shelf/types";

/**
 * Show an input box for a category name. Validates live: empty/whitespace
 * and over-length show an inline error. Returns the trimmed value, or
 * `undefined` if the user cancelled.
 *
 * `value` is the seed text (used for rename to pre-fill the current
 * name). `placeHolder` and `prompt` follow VS Code's input box conventions.
 */
export interface CategoryNameOptions {
  title: string;
  prompt?: string;
  placeHolder?: string;
  value?: string;
}

export async function promptForCategoryName(
  options: CategoryNameOptions,
): Promise<string | undefined> {
  return await promptForLabel({
    ...options,
    placeHolder: options.placeHolder ?? "Category name",
    emptyMessage: "Please enter a name.",
  });
}

/**
 * Show an input box for a file/folder display alias. Same validation
 * as `promptForCategoryName` (non-empty, ≤100 chars), but with a
 * caller-supplied `prompt` so the "won't rename the file on disk" hint
 * shows beneath the input.
 */
export async function promptForDisplayName(
  options: CategoryNameOptions,
): Promise<string | undefined> {
  return await promptForLabel({
    ...options,
    placeHolder: options.placeHolder ?? "Display name",
    emptyMessage: "Please enter a display name.",
  });
}

interface InternalLabelOptions {
  title: string;
  placeHolder: string;
  emptyMessage: string;
  prompt?: string;
  value?: string;
}

async function promptForLabel(
  options: InternalLabelOptions,
): Promise<string | undefined> {
  const inputOptions: vscode.InputBoxOptions = {
    title: options.title,
    placeHolder: options.placeHolder,
    validateInput: (input: string): string | null => {
      const trimmed = input.trim();
      if (trimmed.length === 0) {
        return options.emptyMessage;
      }
      if (trimmed.length > MAX_CATEGORY_LABEL_LENGTH) {
        return `That's longer than ${MAX_CATEGORY_LABEL_LENGTH} characters.`;
      }
      return null;
    },
  };
  if (options.prompt !== undefined) {
    inputOptions.prompt = options.prompt;
  }
  if (options.value !== undefined) {
    inputOptions.value = options.value;
  }
  const result = await vscode.window.showInputBox(inputOptions);
  return result?.trim();
}
