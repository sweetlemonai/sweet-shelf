import * as nodePath from "node:path";

import type { FileRef, FolderRef } from "./types";

/**
 * Pure label-formatting helpers for shelf items.
 *
 * `displayName` is what shows in the tree's primary label. Aliases
 * win over basenames; for files, the `showFileExtensions` setting
 * trims the trailing extension when an alias is *not* set. Folder
 * labels are unaffected by the extension setting.
 *
 * These helpers are also used by the disambiguation algorithm to
 * compare what the user actually sees, so two refs displayed as the
 * same string collide regardless of underlying basename.
 */

/** File display label: alias verbatim, or basename with extension toggled by setting. */
export function fileDisplayName(ref: FileRef, showExtensions: boolean): string {
  if (ref.alias !== undefined) {
    return ref.alias;
  }
  return showExtensions ? ref.label : stripExtension(ref.label);
}

/** Folder display label: alias verbatim, or basename. Extensions setting doesn't apply. */
export function folderDisplayName(ref: FolderRef): string {
  return ref.alias ?? ref.label;
}

/**
 * Strip a single trailing extension from a basename. `"README.md"` →
 * `"README"`; `"foo.tar.gz"` → `"foo.tar"`; `"Makefile"` → `"Makefile"`.
 * Leading-dot files like `".env"` are not "extensions" — left alone.
 */
export function stripExtension(filename: string): string {
  const ext = nodePath.extname(filename);
  if (ext.length === 0 || ext === filename) {
    return filename;
  }
  return filename.slice(0, -ext.length);
}
