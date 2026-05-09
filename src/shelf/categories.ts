import { randomUUID } from "node:crypto";

import { canonicalizePath, deriveLabelFromPath } from "./paths";
import type {
  Category,
  CategoryChild,
  FileRef,
  FolderRef,
} from "./types";

/**
 * Pure tree operations on the category forest.
 *
 * No VS Code imports here on purpose: the store wraps these with state,
 * events, and persistence; pure functions stay trivially testable and
 * keep the data layer free of editor concerns.
 *
 * "Forest" means an array of top-level categories — the shape stored in
 * `ShelfConfig.library`. Categories are the only kind that nests; files
 * and folders are leaves at the data-model level.
 */

/* ─────────────────────── Construction ─────────────────────── */

/** Build a new category with fresh ID and timestamps. */
export function makeCategory(label: string): Category {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    kind: "category",
    label,
    children: [],
    createdAt: now,
    updatedAt: now,
  };
}

/** Build a new file reference. `path` is canonicalized; label is the basename. */
export function makeFileRef(path: string): FileRef {
  const canonical = canonicalizePath(path);
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    kind: "file",
    path: canonical,
    label: deriveLabelFromPath(canonical),
    createdAt: now,
    updatedAt: now,
  };
}

/** Build a new folder reference. `path` is canonicalized; label is the basename. */
export function makeFolderRef(path: string): FolderRef {
  const canonical = canonicalizePath(path);
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    kind: "folder",
    path: canonical,
    label: deriveLabelFromPath(canonical),
    createdAt: now,
    updatedAt: now,
  };
}

/* ─────────────────────── Lookup ─────────────────────── */

/**
 * Find a category by id anywhere in the forest. Returns `undefined` if
 * the id refers to a file/folder or doesn't exist.
 */
export function findCategory(
  forest: readonly Category[],
  id: string,
): Category | undefined {
  for (const c of forest) {
    if (c.id === id) {
      return c;
    }
    const inner = findCategory(
      c.children.filter(isCategory),
      id,
    );
    if (inner) {
      return inner;
    }
  }
  return undefined;
}

/**
 * Find any child (category, file, or folder) by id anywhere in the
 * forest. The store's specialized `findFile`/`findFolder` use this and
 * filter by kind.
 */
export function findChild(
  forest: readonly Category[],
  id: string,
): CategoryChild | undefined {
  for (const c of forest) {
    if (c.id === id) {
      return c;
    }
    const inner = findChildInCategory(c, id);
    if (inner) {
      return inner;
    }
  }
  return undefined;
}

function findChildInCategory(
  category: Category,
  id: string,
): CategoryChild | undefined {
  for (const child of category.children) {
    if (child.id === id) {
      return child;
    }
    if (child.kind === "category") {
      const inner = findChildInCategory(child, id);
      if (inner) {
        return inner;
      }
    }
  }
  return undefined;
}

/**
 * Locate any child and its container. `parent` is `null` only when the
 * matched node is a top-level category — files and folders always have
 * a non-null parent because they cannot live at the section root.
 */
export function findContainer(
  forest: Category[],
  id: string,
): { parent: Category | null; index: number; child: CategoryChild } | undefined {
  const rootIndex = forest.findIndex((c) => c.id === id);
  if (rootIndex >= 0) {
    return { parent: null, index: rootIndex, child: forest[rootIndex] };
  }
  for (const c of forest) {
    const result = findContainerInCategory(c, id);
    if (result) {
      return result;
    }
  }
  return undefined;
}

function findContainerInCategory(
  category: Category,
  id: string,
): { parent: Category | null; index: number; child: CategoryChild } | undefined {
  const idx = category.children.findIndex((c) => c.id === id);
  if (idx >= 0) {
    return { parent: category, index: idx, child: category.children[idx] };
  }
  for (const child of category.children) {
    if (child.kind === "category") {
      const inner = findContainerInCategory(child, id);
      if (inner) {
        return inner;
      }
    }
  }
  return undefined;
}

/**
 * @deprecated Kept for the existing category-move call sites. Prefer
 * `findContainer` in new code; this thin wrapper just drops the `child`
 * field for backward compatibility.
 */
export function findParent(
  forest: Category[],
  id: string,
): { parent: Category | null; index: number } | undefined {
  const result = findContainer(forest, id);
  if (!result) {
    return undefined;
  }
  return { parent: result.parent, index: result.index };
}

/* ─────────────────────── Mutation ─────────────────────── */

/**
 * Insert `child` into `parent`'s children at the given index (default:
 * append). Mutates in place.
 */
export function insertChild(
  parent: Category,
  child: CategoryChild,
  index?: number,
): void {
  const at =
    index === undefined
      ? parent.children.length
      : Math.max(0, Math.min(index, parent.children.length));
  parent.children.splice(at, 0, child);
}

/**
 * Insert a category into the forest under `parentId` (or at root if
 * `parentId` is `null`). Returns `true` on success, `false` if the
 * parent does not exist.
 */
export function insertCategory(
  forest: Category[],
  parentId: string | null,
  category: Category,
): boolean {
  if (parentId === null) {
    forest.push(category);
    return true;
  }
  const parent = findCategory(forest, parentId);
  if (!parent) {
    return false;
  }
  parent.children.push(category);
  return true;
}

/**
 * Remove the child with `id` from the forest, regardless of kind.
 * Mutates in place. Returns the removed child or `undefined`.
 */
export function removeChildById(
  forest: Category[],
  id: string,
): CategoryChild | undefined {
  const rootIndex = forest.findIndex((c) => c.id === id);
  if (rootIndex >= 0) {
    return forest.splice(rootIndex, 1)[0];
  }
  for (const c of forest) {
    const removed = removeFromSubtree(c, id);
    if (removed) {
      return removed;
    }
  }
  return undefined;
}

function removeFromSubtree(
  node: Category,
  id: string,
): CategoryChild | undefined {
  const idx = node.children.findIndex((c) => c.id === id);
  if (idx >= 0) {
    return node.children.splice(idx, 1)[0];
  }
  for (const child of node.children) {
    if (child.kind === "category") {
      const removed = removeFromSubtree(child, id);
      if (removed) {
        return removed;
      }
    }
  }
  return undefined;
}

/* ─────────────────────── Cycle detection / counting ─────────────────────── */

/**
 * True when `candidateId` is `ancestor` itself or a descendant category.
 * Files and folders never matter for cycle detection because they don't
 * accept children.
 */
export function isSelfOrDescendant(
  ancestor: Category,
  candidateId: string,
): boolean {
  if (ancestor.id === candidateId) {
    return true;
  }
  for (const child of ancestor.children) {
    if (child.kind === "category" && isSelfOrDescendant(child, candidateId)) {
      return true;
    }
  }
  return false;
}

/** Per-kind descendant counts, used in remove-confirmation copy. */
export interface DescendantCounts {
  categories: number;
  files: number;
  folders: number;
}

/** Walk a category subtree, tallying descendants by kind. */
export function countDescendantsByKind(category: Category): DescendantCounts {
  const counts: DescendantCounts = { categories: 0, files: 0, folders: 0 };
  for (const child of category.children) {
    switch (child.kind) {
      case "category": {
        counts.categories += 1;
        const inner = countDescendantsByKind(child);
        counts.categories += inner.categories;
        counts.files += inner.files;
        counts.folders += inner.folders;
        break;
      }
      case "file":
        counts.files += 1;
        break;
      case "folder":
        counts.folders += 1;
        break;
      default:
        return assertNever(child);
    }
  }
  return counts;
}

/** Total descendants across all kinds. */
export function totalDescendants(category: Category): number {
  const c = countDescendantsByKind(category);
  return c.categories + c.files + c.folders;
}

/**
 * Maximum nesting depth of a category forest. Root categories count as
 * depth 1. Files and folders don't add depth. Used by the validator to
 * enforce `MAX_CATEGORY_DEPTH`.
 */
export function forestDepth(forest: readonly Category[]): number {
  let max = 0;
  for (const c of forest) {
    const d = 1 + forestDepth(c.children.filter(isCategory));
    if (d > max) {
      max = d;
    }
  }
  return max;
}

/** Walk every node in the forest in pre-order, regardless of kind. */
export function* walkAll(
  forest: readonly Category[],
): Generator<CategoryChild, void, void> {
  for (const c of forest) {
    yield c;
    yield* walkCategoryChildren(c);
  }
}

function* walkCategoryChildren(
  category: Category,
): Generator<CategoryChild, void, void> {
  for (const child of category.children) {
    yield child;
    if (child.kind === "category") {
      yield* walkCategoryChildren(child);
    }
  }
}

function isCategory(child: CategoryChild): child is Category {
  return child.kind === "category";
}

function assertNever(value: never): never {
  throw new Error(`Unexpected variant: ${JSON.stringify(value)}`);
}
