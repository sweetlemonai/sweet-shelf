import type { Category, FileRef, FolderRef } from "./types";
import { walkAll } from "./categories";

/**
 * Pure helper backing the Recent view.
 *
 * Recent is a derived view: walk every ref in Library, keep the ones
 * with `lastOpenedAt`, sort newest-first, take the top `maxItems`.
 * No order is stored anywhere — the timestamps are the source of truth.
 *
 * ISO 8601 strings sort correctly via `localeCompare` in descending
 * order, so we don't need to parse to Dates.
 */
export function buildRecentView(
  library: readonly Category[],
  maxItems: number,
): Array<FileRef | FolderRef> {
  const out: Array<FileRef | FolderRef> = [];
  for (const node of walkAll(library)) {
    if (node.kind === "category") {
      continue;
    }
    if (node.lastOpenedAt !== undefined) {
      out.push(node);
    }
  }
  out.sort((a, b) => {
    const aTime = a.lastOpenedAt ?? "";
    const bTime = b.lastOpenedAt ?? "";
    return bTime.localeCompare(aTime);
  });
  if (maxItems <= 0) {
    return [];
  }
  return out.length > maxItems ? out.slice(0, maxItems) : out;
}

/** True iff at least one ref in Library has `lastOpenedAt` set. */
export function hasRecentEntries(library: readonly Category[]): boolean {
  for (const node of walkAll(library)) {
    if (node.kind === "category") {
      continue;
    }
    if (node.lastOpenedAt !== undefined) {
      return true;
    }
  }
  return false;
}
