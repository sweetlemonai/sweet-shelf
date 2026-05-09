import * as vscode from "vscode";

import type { ShelfNode } from "./types";

/**
 * Inline-browsing helpers. Reads a directory from disk, filters,
 * sorts, and shapes the result into `folderEntry`-family nodes.
 *
 * These nodes are pure view state: never persisted, never carry an ID
 * beyond what's derived from their URI, and the store never sees them.
 * `getChildren` recomputes them on every expansion, so the contract
 * with the user is "you see what was on disk at the moment you
 * expanded" — no filesystem watchers, no caching.
 */

/** Soft cap on entries rendered per directory. */
export const ENTRY_RENDER_CAP = 500;

/**
 * Read a directory and return the nodes the tree provider should
 * render. On read failure returns a single `folderEntryError` node;
 * over-cap directories return the first `ENTRY_RENDER_CAP` plus a
 * single `folderEntryOverflow` placeholder.
 *
 * `showHidden` controls whether dotfiles are included.
 *
 * The function is the only async surface in the inline-browse code
 * path. It captures the URI by value before awaiting, so the result
 * is safe to render even if the originating shelf state has changed
 * during the read.
 */
export async function readFolderEntries(
  uri: vscode.Uri,
  showHidden: boolean,
): Promise<ShelfNode[]> {
  let raw: ReadonlyArray<readonly [string, vscode.FileType]>;
  try {
    raw = await vscode.workspace.fs.readDirectory(uri);
  } catch (err) {
    return [
      {
        kind: "folderEntryError",
        parentUri: uri,
        message: errorPlaceholderMessage(err),
      },
    ];
  }

  const filtered = showHidden
    ? raw
    : raw.filter(([name]) => !name.startsWith("."));

  // Directories first, then files; case-insensitive alphabetical.
  // Symlinks are forced to `isDirectory: false` below, so a symlink
  // pointing at a directory sorts as a file. Acceptable trade — keeps
  // the inline view free of cycles without per-entry stat probes.
  const sorted = [...filtered].sort(([aName, aType], [bName, bType]) => {
    const aDir = isDirectoryType(aType) && !isSymlinkType(aType);
    const bDir = isDirectoryType(bType) && !isSymlinkType(bType);
    if (aDir !== bDir) {
      return aDir ? -1 : 1;
    }
    return aName.localeCompare(bName, undefined, { sensitivity: "base" });
  });

  const visible = sorted.slice(0, ENTRY_RENDER_CAP);
  const overflow = sorted.length - visible.length;

  const nodes: ShelfNode[] = visible.map(([name, type]) => {
    const isSymlink = isSymlinkType(type);
    const isDirectory = isDirectoryType(type) && !isSymlink;
    return {
      kind: "folderEntry",
      uri: vscode.Uri.joinPath(uri, name),
      isDirectory,
      isSymlink,
      parentUri: uri,
    };
  });

  if (overflow > 0) {
    nodes.push({
      kind: "folderEntryOverflow",
      parentUri: uri,
      hiddenCount: overflow,
    });
  }

  return nodes;
}

/** Stable id for a folderEntry-family node, suitable for `TreeItem.id`. */
export function folderEntryId(uri: vscode.Uri): string {
  return `folderEntry:${uri.toString()}`;
}

/** Stable id for the read-failure placeholder. */
export function folderEntryErrorId(parentUri: vscode.Uri): string {
  return `folderEntryError:${parentUri.toString()}`;
}

/** Stable id for the over-cap placeholder. */
export function folderEntryOverflowId(parentUri: vscode.Uri): string {
  return `folderEntryOverflow:${parentUri.toString()}`;
}

/**
 * Platform-aware copy for the over-cap placeholder so the suggested
 * action matches the user's OS file manager.
 */
export function overflowMessage(hiddenCount: number): string {
  const noun = hiddenCount === 1 ? "entry" : "entries";
  switch (process.platform) {
    case "darwin":
      return `…and ${hiddenCount} more ${noun} (open in Finder to see all)`;
    case "win32":
      return `…and ${hiddenCount} more ${noun} (open in Explorer to see all)`;
    default:
      return `…and ${hiddenCount} more ${noun} (open in your file manager to see all)`;
  }
}

function errorPlaceholderMessage(err: unknown): string {
  if (err instanceof vscode.FileSystemError) {
    if (err.code === "FileNotFound" || err.code === "EntryNotFound") {
      return "Couldn't read this folder — it may have been moved or removed.";
    }
    if (err.code === "NoPermissions") {
      return "Couldn't read this folder — permission denied.";
    }
  }
  return "Couldn't read this folder.";
}

function isDirectoryType(type: vscode.FileType): boolean {
  return (type & vscode.FileType.Directory) !== 0;
}

function isSymlinkType(type: vscode.FileType): boolean {
  return (type & vscode.FileType.SymbolicLink) !== 0;
}
