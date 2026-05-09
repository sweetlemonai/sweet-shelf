import * as nodePath from "node:path";

import { fileDisplayName, folderDisplayName } from "./labels";
import { findContainer } from "./categories";
import type { Category, FileRef, FolderRef } from "./types";

/**
 * Per-render disambiguation for shelf file/folder labels.
 *
 * Pure: given a ref, the library, and the current `showExtensions`
 * setting, returns the trailing description to append (or `undefined`
 * when no disambiguation is needed). Computed every time the tree
 * provider renders an item — no caching, no invalidation.
 *
 * Aliased refs never participate: once a user names something, we
 * don't second-guess them with appended context.
 *
 * Format: `" · <breadcrumb>"`, ready to drop into `TreeItem.description`.
 *
 * Algorithm summary:
 *   1. If the ref has an alias, return undefined.
 *   2. Walk the library; collect non-aliased file/folder refs whose
 *      *displayed* label (post-extension-stripping) equals this one's.
 *   3. None match → undefined.
 *   4. At least one other match has a different breadcrumb → use my
 *      breadcrumb (top-level category … immediate parent).
 *   5. Every other match shares my breadcrumb → fall back to the
 *      basename of my on-disk parent directory.
 */
export function computeDisambiguator(
  ref: FileRef | FolderRef,
  library: readonly Category[],
  showExtensions: boolean,
): string | undefined {
  if (ref.alias !== undefined) {
    return undefined;
  }

  const myDisplay = displayLabelFor(ref, showExtensions);
  const myContainer = findContainer(library as Category[], ref.id);
  if (!myContainer || !myContainer.parent) {
    // Files/folders always have a category parent; if they don't,
    // something is structurally wrong — bail rather than assert.
    return undefined;
  }
  const myBreadcrumb = buildBreadcrumb(myContainer.parent.id, library);

  let labelMatches = 0;
  let breadcrumbAndLabelMatches = 0;

  for (const node of walkRefs(library)) {
    if (node.id === ref.id) {
      continue;
    }
    if (node.alias !== undefined) {
      continue;
    }
    if (displayLabelFor(node, showExtensions) !== myDisplay) {
      continue;
    }
    labelMatches += 1;
    const otherContainer = findContainer(library as Category[], node.id);
    if (!otherContainer || !otherContainer.parent) {
      continue;
    }
    const otherBreadcrumb = buildBreadcrumb(otherContainer.parent.id, library);
    if (otherBreadcrumb === myBreadcrumb) {
      breadcrumbAndLabelMatches += 1;
    }
  }

  if (labelMatches === 0) {
    return undefined;
  }
  if (breadcrumbAndLabelMatches > 0) {
    // Someone else shares both my label and my category path —
    // pull in the on-disk folder name for further distinction.
    return ` · ${onDiskFolderName(ref.path)}`;
  }
  return ` · ${myBreadcrumb}`;
}

/* ───────────────────────── helpers ───────────────────────── */

function displayLabelFor(
  ref: FileRef | FolderRef,
  showExtensions: boolean,
): string {
  return ref.kind === "file"
    ? fileDisplayName(ref, showExtensions)
    : folderDisplayName(ref);
}

function* walkRefs(
  forest: readonly Category[],
): Generator<FileRef | FolderRef, void, void> {
  for (const c of forest) {
    yield* walkCategoryRefs(c);
  }
}

function* walkCategoryRefs(
  category: Category,
): Generator<FileRef | FolderRef, void, void> {
  for (const child of category.children) {
    if (child.kind === "category") {
      yield* walkCategoryRefs(child);
    } else if (child.kind === "file" || child.kind === "folder") {
      yield child;
    }
  }
}

/**
 * Build a category breadcrumb from the immediate parent up to (and
 * including) the top-level category, joined with " / " in top-down
 * order. Library section is implicit and never appears in the string.
 */
function buildBreadcrumb(
  parentCategoryId: string,
  library: readonly Category[],
): string {
  const labels: string[] = [];
  let currentId: string | null = parentCategoryId;
  // Bound the walk by category count so a malformed tree can't loop.
  let safety = 256;
  while (currentId !== null && safety-- > 0) {
    const found = findCategoryAndContainer(library, currentId);
    if (!found) {
      break;
    }
    labels.unshift(found.category.label);
    currentId = found.containerParentId;
  }
  return labels.join(" / ");
}

interface CategoryLookup {
  category: Category;
  /** Parent category id, or null if `category` is at the Library root. */
  containerParentId: string | null;
}

function findCategoryAndContainer(
  forest: readonly Category[],
  id: string,
): CategoryLookup | undefined {
  for (let i = 0; i < forest.length; i += 1) {
    const c = forest[i];
    if (c.id === id) {
      return { category: c, containerParentId: null };
    }
    const inner = findCategoryAndContainerInside(c, id);
    if (inner) {
      return inner;
    }
  }
  return undefined;
}

function findCategoryAndContainerInside(
  parent: Category,
  id: string,
): CategoryLookup | undefined {
  for (const child of parent.children) {
    if (child.kind !== "category") {
      continue;
    }
    if (child.id === id) {
      return { category: child, containerParentId: parent.id };
    }
    const deeper = findCategoryAndContainerInside(child, id);
    if (deeper) {
      return deeper;
    }
  }
  return undefined;
}

function onDiskFolderName(p: string): string {
  const parent = nodePath.dirname(p);
  const base = nodePath.basename(parent);
  return base.length > 0 ? base : parent;
}
