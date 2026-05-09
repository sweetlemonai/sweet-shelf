import * as nodePath from "node:path";

import type {
  Category,
  CategoryChild,
  FileRef,
  FolderRef,
} from "./types";

/**
 * Path utilities for the shelf data model. Pure — no VS Code imports.
 *
 * Sweet Shelf stores absolute, syntactically normalized paths. Symlinks
 * are intentionally not resolved: two symlink paths that target the
 * same file count as different references, matching what users pick in
 * the file dialog.
 */

/**
 * Return an absolute, syntactically normalized form of `p` suitable for
 * persistence. Resolves `.`/`..` and normalizes separators. Does NOT
 * resolve symlinks. Case is preserved on macOS/Linux; Windows callers
 * should additionally lowercase before *comparing* via `pathsEqual`.
 */
export function canonicalizePath(p: string): string {
  return nodePath.resolve(p);
}

/**
 * Compare two on-disk paths for equality. Case-folds on Windows and
 * macOS where the default filesystems are case-insensitive; case-
 * sensitive on Linux. Both inputs are canonicalized so callers don't
 * have to.
 *
 * macOS's default APFS is case-insensitive but case-preserving — two
 * paths differing only in case point to the same file, so we treat
 * them as the same reference. Users on case-sensitive APFS volumes
 * trade a few false-positive duplicate warnings for the much more
 * common case of avoiding accidental dupes.
 */
export function pathsEqual(a: string, b: string): boolean {
  const ca = canonicalizePath(a);
  const cb = canonicalizePath(b);
  if (process.platform === "win32" || process.platform === "darwin") {
    return ca.toLowerCase() === cb.toLowerCase();
  }
  return ca === cb;
}

/**
 * The basename users see as the default label. Strips trailing slashes
 * for folders ("/foo/bar/" -> "bar"). Empty result falls back to the
 * full path so the tree never renders blank.
 */
export function deriveLabelFromPath(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, "");
  const base = nodePath.basename(trimmed);
  return base.length > 0 ? base : trimmed;
}

/**
 * Walk the forest looking for a file or folder reference at the given
 * path. Returns the matching ref together with its parent category's
 * label so callers can surface a precise "already on your shelf in X"
 * message without re-walking.
 */
export function findExistingReferenceByPath(
  forest: readonly Category[],
  path: string,
): { ref: FileRef | FolderRef; parentLabel: string } | undefined {
  for (const root of forest) {
    const hit = findInCategory(root, path);
    if (hit) {
      return hit;
    }
  }
  return undefined;
}

function findInCategory(
  category: Category,
  path: string,
): { ref: FileRef | FolderRef; parentLabel: string } | undefined {
  for (const child of category.children) {
    const hit = visitChild(child, category.label, path);
    if (hit) {
      return hit;
    }
  }
  return undefined;
}

function visitChild(
  child: CategoryChild,
  parentLabel: string,
  path: string,
): { ref: FileRef | FolderRef; parentLabel: string } | undefined {
  switch (child.kind) {
    case "category":
      return findInCategory(child, path);
    case "file":
    case "folder":
      return pathsEqual(child.path, path) ? { ref: child, parentLabel } : undefined;
    default:
      return undefined;
  }
}
