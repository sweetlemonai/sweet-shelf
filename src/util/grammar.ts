import type { DescendantCounts } from "../shelf/categories";

/**
 * Grammar helpers for user-facing copy.
 *
 * Pure — no VS Code imports. Keeping these out of the command handlers
 * makes the wording trivially testable and keeps the handlers focused
 * on flow.
 */

/**
 * Format a kind-aware count phrase, e.g. "2 subcategories, 5 files, and
 * 1 folder". Skips zero-count kinds. Returns an empty string if every
 * count is zero (callers should branch on that before composing copy).
 */
export function describeDescendantCounts(counts: DescendantCounts): string {
  const parts: string[] = [];
  if (counts.categories > 0) {
    parts.push(
      `${counts.categories} ${counts.categories === 1 ? "subcategory" : "subcategories"}`,
    );
  }
  if (counts.files > 0) {
    parts.push(`${counts.files} ${counts.files === 1 ? "file" : "files"}`);
  }
  if (counts.folders > 0) {
    parts.push(
      `${counts.folders} ${counts.folders === 1 ? "folder" : "folders"}`,
    );
  }
  return joinList(parts);
}

/**
 * Join a list with grammatical conjunction:
 *   []                        -> ""
 *   ["a"]                     -> "a"
 *   ["a", "b"]                -> "a and b"
 *   ["a", "b", "c"]           -> "a, b, and c"   (Oxford comma)
 */
export function joinList(items: readonly string[]): string {
  if (items.length === 0) {
    return "";
  }
  if (items.length === 1) {
    return items[0];
  }
  if (items.length === 2) {
    return `${items[0]} and ${items[1]}`;
  }
  const head = items.slice(0, -1).join(", ");
  return `${head}, and ${items[items.length - 1]}`;
}
