import * as vscode from "vscode";

import {
  ALL_COLOR_LABELS,
  isColorLabel,
  type ColorLabel,
} from "./color";
import { fileDisplayName, folderDisplayName } from "./labels";
import { findCategory } from "./categories";
import type { BrokenLinkCache } from "./brokenLinks";
import type { Category, FileRef, FolderRef } from "./types";

/**
 * Pure helpers backing the Search Quick Pick.
 *
 * Architectural rule: `buildSearchableItems` is the only library walk
 * per Search session — the keystroke handler in `commands/search.ts`
 * filters this pre-built array without re-walking. For typical shelves
 * this is fast enough that no caching or memoization is warranted.
 *
 * Filter parsing recognizes a known token at the *start* of the input
 * (per brief's option d); successive parses accumulate filters via
 * closure state in the command handler. Free text after the last
 * stripped token is what Quick Pick fuzzy-matches against.
 */

export interface SearchableItem extends vscode.QuickPickItem {
  /**
   * Kind of the underlying shelf node. Named `nodeKind` instead of
   * `kind` to avoid colliding with `vscode.QuickPickItem.kind`,
   * which is the `Default | Separator` enum.
   */
  nodeKind: "category" | "file" | "folder";
  /** Reference to the underlying ref or category. */
  ref: Category | FileRef | FolderRef;
  isFavorited: boolean;
  isBroken: boolean;
  colorLabel?: ColorLabel;
}

/** Active filter state, accumulated across successive parses. */
export interface SearchFilters {
  color?: ColorLabel;
  is?: "favorited" | "broken";
}

/** Outcome of parsing one keystroke's worth of input. */
export interface ParsedQuery {
  /** Filter signals extracted from the consumed token, if any. */
  filters: SearchFilters;
  /** Input with the leading token (and trailing whitespace) stripped. */
  remainder: string;
  /** True iff a known token was recognized and consumed. */
  consumedToken: boolean;
}

/**
 * Walk the library, build one `SearchableItem` per category, file ref,
 * and folder ref. Order is depth-first / library order — natural for
 * users who scroll without typing.
 *
 * Disambiguation is intentionally skipped: the breadcrumb in
 * `description` already distinguishes same-named items across
 * categories, and per-render disambiguation is wasted work in the
 * Quick Pick context.
 *
 * `isFavoritedPath` resolves the `is:favorited` filter by path —
 * Library refs and favorites are independent storage in v1.0.0, so
 * we can't read the flag off the ref itself. Callers pass the
 * store's `isFavoritedPath` bound to the current state.
 *
 * `rootCategoryId` scopes the walk to one subtree (used by Task 13's
 * "Search in this category"). The scope category itself is included
 * as the first item; its descendants follow. Returns an empty array
 * if the id doesn't resolve.
 */
export function buildSearchableItems(
  library: readonly Category[],
  isFavoritedPath: (path: string) => boolean,
  brokenLinks: BrokenLinkCache,
  showExtensions: boolean,
  rootCategoryId?: string,
): SearchableItem[] {
  const out: SearchableItem[] = [];
  if (rootCategoryId !== undefined) {
    const root = findCategory(library, rootCategoryId);
    if (!root) {
      return out;
    }
    const ancestors = collectAncestorLabels(library, rootCategoryId);
    visitCategory(root, ancestors, out, isFavoritedPath, brokenLinks, showExtensions);
    return out;
  }
  for (const top of library) {
    visitCategory(top, [], out, isFavoritedPath, brokenLinks, showExtensions);
  }
  return out;
}

/**
 * Collect the ancestor category labels above `categoryId` (excluding
 * the category itself). Used to anchor scoped-search breadcrumbs at
 * the same path the user would see in unscoped search — so a result
 * inside `Books / Code Smarter` reads `Library / Books / Code Smarter`
 * even when search was scoped to `Code Smarter`.
 */
function collectAncestorLabels(
  library: readonly Category[],
  categoryId: string,
): string[] {
  const path: string[] = [];
  const found = findInForest(library, categoryId, []);
  return found ?? path;
}

function findInForest(
  forest: readonly Category[],
  id: string,
  ancestors: readonly string[],
): string[] | null {
  for (const cat of forest) {
    if (cat.id === id) {
      return [...ancestors];
    }
    const inner = findInForest(
      cat.children.filter((c): c is Category => c.kind === "category"),
      id,
      [...ancestors, cat.label],
    );
    if (inner) {
      return inner;
    }
  }
  return null;
}

function visitCategory(
  category: Category,
  ancestors: readonly string[],
  out: SearchableItem[],
  isFavoritedPath: (path: string) => boolean,
  brokenLinks: BrokenLinkCache,
  showExtensions: boolean,
): void {
  const breadcrumb = ["Library", ...ancestors, category.label].join(" / ");
  const item: SearchableItem = {
    label: category.label,
    description: breadcrumb,
    iconPath: new vscode.ThemeIcon("folder"),
    nodeKind: "category",
    ref: category,
    isFavorited: false,
    isBroken: false,
  };
  if (category.colorLabel !== undefined) {
    item.colorLabel = category.colorLabel;
  }
  out.push(item);

  const childAncestors = [...ancestors, category.label];
  const containerBreadcrumb = ["Library", ...childAncestors].join(" / ");

  for (const child of category.children) {
    if (child.kind === "category") {
      visitCategory(
        child,
        childAncestors,
        out,
        isFavoritedPath,
        brokenLinks,
        showExtensions,
      );
    } else {
      out.push(
        buildRefItem(
          child,
          containerBreadcrumb,
          isFavoritedPath,
          brokenLinks,
          showExtensions,
        ),
      );
    }
  }
}

function buildRefItem(
  ref: FileRef | FolderRef,
  breadcrumb: string,
  isFavoritedPath: (path: string) => boolean,
  brokenLinks: BrokenLinkCache,
  showExtensions: boolean,
): SearchableItem {
  const isFile = ref.kind === "file";
  const display = isFile
    ? fileDisplayName(ref, showExtensions)
    : folderDisplayName(ref);
  const cached = brokenLinks.isBroken(ref.path);
  if (cached === undefined) {
    // Schedule but don't await — the Quick Pick will show the item
    // as not-broken on first render; if a stat resolves true while
    // the picker is open, we accept the staleness for v1.
    brokenLinks.scheduleCheck(ref.path);
  }
  const item: SearchableItem = {
    label: display,
    description: breadcrumb,
    detail: ref.path,
    iconPath: vscode.Uri.file(ref.path),
    nodeKind: ref.kind,
    ref,
    isFavorited: isFavoritedPath(ref.path),
    isBroken: cached === true,
  };
  if (ref.colorLabel !== undefined) {
    item.colorLabel = ref.colorLabel;
  }
  return item;
}

/**
 * Recognize a filter token at the start of `value`. The token must
 * be either followed by whitespace or come at the end of input — so
 * partial typing (`color:re`) is ignored until the user types the
 * final char. Unknown values (`color:fuchsia`) do not consume,
 * letting Quick Pick fall through to fuzzy match (which generally
 * yields zero results and teaches the user the syntax).
 */
export function parseQuery(value: string): ParsedQuery {
  const colorMatch = value.match(/^color:([a-zA-Z]+)(\s+|$)/);
  if (colorMatch && isColorLabel(colorMatch[1].toLowerCase())) {
    const color = colorMatch[1].toLowerCase() as ColorLabel;
    return {
      filters: { color },
      remainder: value.slice(colorMatch[0].length),
      consumedToken: true,
    };
  }
  const isMatch = value.match(/^is:(favorited|broken)(\s+|$)/);
  if (isMatch) {
    return {
      filters: { is: isMatch[1] as "favorited" | "broken" },
      remainder: value.slice(isMatch[0].length),
      consumedToken: true,
    };
  }
  return { filters: {}, remainder: value, consumedToken: false };
}

/**
 * Apply accumulated filters to the pre-built item set. Categories are
 * never `is:favorited` or `is:broken` (categories aren't favoritable; no `path` to
 * stat) — the predicates exclude them naturally.
 */
export function applyFilters(
  items: readonly SearchableItem[],
  filters: SearchFilters,
): SearchableItem[] {
  if (filters.color === undefined && filters.is === undefined) {
    return [...items];
  }
  return items.filter((item) => {
    if (filters.color !== undefined && item.colorLabel !== filters.color) {
      return false;
    }
    if (filters.is === "favorited" && !item.isFavorited) {
      return false;
    }
    if (filters.is === "broken" && !item.isBroken) {
      return false;
    }
    return true;
  });
}

/**
 * Walk a ref's ancestor categories (immediate parent first, then
 * upward). Used to determine whether a search hit lives inside the
 * currently focused subtree (for the auto-exit-on-out-of-focus rule).
 *
 * Imported helpers: deliberately accept the store's two parent-lookup
 * methods as callbacks so this module stays VS Code-import-free.
 */
export function ancestorCategoryIds(
  refOrCategoryId: string,
  lookup: AncestorLookup,
): string[] {
  const out: string[] = [];
  let parent = lookup.firstParent(refOrCategoryId);
  while (parent !== null) {
    out.push(parent);
    parent = lookup.parentOf(parent);
  }
  return out;
}

export interface AncestorLookup {
  /** Parent of an arbitrary id (category, file, or folder). */
  firstParent(id: string): string | null;
  /** Parent of a category id. */
  parentOf(categoryId: string): string | null;
}

/** Available filter values for documentation / palette help. */
export const KNOWN_COLOR_FILTERS: readonly string[] = ALL_COLOR_LABELS;
export const KNOWN_IS_FILTERS: readonly ("favorited" | "broken")[] = [
  "favorited",
  "broken",
];
