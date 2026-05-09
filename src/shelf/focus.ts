import { walkAll } from "./categories";
import type { Category, FolderRef } from "./types";

/**
 * Pure helper that resolves `focusedItemId` against the current
 * library. Files are explicitly not focusable — they'd have nothing
 * to render in the sidebar — so file refs return `null` even if their
 * id matches.
 *
 * Called at render time so the result always reflects current state.
 * If the id no longer resolves (removed, hand-edited to garbage,
 * etc.), the caller is expected to call `store.exitFocus()` and
 * surface a friendly toast.
 */
export type FocusedItem =
  | { kind: "category"; category: Category }
  | { kind: "folder"; folder: FolderRef };

export function resolveFocus(
  library: readonly Category[],
  focusedItemId: string | null,
): FocusedItem | null {
  if (focusedItemId === null) {
    return null;
  }
  for (const node of walkAll(library)) {
    if (node.id !== focusedItemId) {
      continue;
    }
    if (node.kind === "category") {
      return { kind: "category", category: node };
    }
    if (node.kind === "folder") {
      return { kind: "folder", folder: node };
    }
    // File or any other kind: not focusable. Stop scanning.
    return null;
  }
  return null;
}
