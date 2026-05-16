import * as nodePath from "node:path";
import * as vscode from "vscode";

import { log, logError } from "../util/logger";
import { walkAll } from "../shelf/categories";
import type { BrokenLinkCache } from "../shelf/brokenLinks";
import type { ShelfNode } from "../shelf/types";
import type { ShelfStore } from "../shelf/store";

/**
 * Broken-link recovery commands.
 *
 *   - Locate Again…   → user picks a new on-disk path; ref re-points
 *   - Reveal Parent   → reveals the nearest existing ancestor in OS
 *   - Copy Missing    → copies the now-missing absolute path
 *   - Validate Paths  → command-palette refresh of the cache
 *
 * `Locate Again` rejects wrong-kind picks (file ref → folder picked,
 * or vice versa). The store updates `path` and `label` atomically;
 * alias is untouched per Task 5/7 carry-forward.
 */

export function registerBrokenLinkCommands(
  context: vscode.ExtensionContext,
  store: ShelfStore,
  cache: BrokenLinkCache,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "sweetShelf.locateAgain",
      (node?: ShelfNode) =>
        runCommand("Locate Again", () => locateAgain(store, node)),
    ),
    vscode.commands.registerCommand(
      "sweetShelf.revealParentFolder",
      (node?: ShelfNode) =>
        runCommand("Reveal Parent Folder", () => revealParent(node)),
    ),
    vscode.commands.registerCommand(
      "sweetShelf.copyMissingPath",
      (node?: ShelfNode) =>
        runCommand("Copy Missing Path", () => copyMissingPath(node)),
    ),
    vscode.commands.registerCommand("sweetShelf.validatePaths", () =>
      runCommand("Validate Paths", () => validatePaths(store, cache)),
    ),
    vscode.commands.registerCommand(
      "sweetShelf._brokenClick",
      () =>
        runCommand("Missing Item Click", () =>
          showBrokenClickToast(),
        ),
    ),
  );
}

async function locateAgain(
  store: ShelfStore,
  node: ShelfNode | undefined,
): Promise<void> {
  const target = brokenTarget(node);
  if (!target) {
    throw new Error("This command needs a file or folder.");
  }
  const isFile = target.kind === "file";
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: isFile,
    canSelectFolders: !isFile,
    canSelectMany: false,
    openLabel: "Locate Again",
  });
  if (!picked || picked.length === 0) {
    return;
  }
  const newPath = picked[0].fsPath;
  const stat = await safeStat(picked[0]);
  if (!stat) {
    throw new Error("Couldn't read that path.");
  }
  if (isFile && (stat.type & vscode.FileType.File) === 0) {
    throw new Error(
      "Selected item is a folder, not a file. Please pick a file.",
    );
  }
  if (!isFile && (stat.type & vscode.FileType.Directory) === 0) {
    throw new Error(
      "Selected item is a file, not a folder. Please pick a folder.",
    );
  }
  if (target.scope === "favorite") {
    store.relocateFavorite(target.id, newPath);
  } else {
    store.locateAgain(target.id, newPath);
  }
}

async function revealParent(node: ShelfNode | undefined): Promise<void> {
  const target = brokenTarget(node);
  if (!target) {
    throw new Error("This command needs a file or folder.");
  }
  const ancestor = await findExistingAncestor(target.path);
  if (ancestor === null) {
    throw new Error("Couldn't find any existing parent folder.");
  }
  if (ancestor.fellBack) {
    void vscode.window.showInformationMessage(
      "Sweet Shelf: parent folder is also missing. Showing the nearest existing ancestor.",
    );
  }
  await vscode.commands.executeCommand(
    "revealFileInOS",
    vscode.Uri.file(ancestor.path),
  );
}

async function copyMissingPath(node: ShelfNode | undefined): Promise<void> {
  const target = brokenTarget(node);
  if (!target) {
    throw new Error("This command needs a file or folder.");
  }
  await vscode.env.clipboard.writeText(target.path);
  vscode.window.setStatusBarMessage("Path copied.", 2000);
}

async function validatePaths(
  store: ShelfStore,
  cache: BrokenLinkCache,
): Promise<void> {
  const paths = collectUniquePaths(store);
  if (paths.length === 0) {
    void vscode.window.showInformationMessage(
      "Sweet Shelf: no files or folders to check.",
    );
    return;
  }
  cache.invalidateAll();
  let broken = 0;
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Sweet Shelf: validating paths…",
    },
    async (progress) => {
      const total = paths.length;
      for (let i = 0; i < paths.length; i += 1) {
        const path = paths[i];
        const exists = await safeStat(vscode.Uri.file(path));
        if (exists === null) {
          broken += 1;
        }
        progress.report({
          increment: 100 / total,
          message: `${i + 1} of ${total}`,
        });
      }
    },
  );
  log(
    `validatePaths: checked ${paths.length}, ${broken} missing (cache size now ${cache.size()}).`,
  );
  // The cache will re-populate lazily as items render, but kick off a
  // refresh now so the UI reflects the fresh state immediately.
  for (const path of paths) {
    cache.scheduleCheck(path);
  }
  if (broken === 0) {
    void vscode.window.showInformationMessage(
      `Sweet Shelf: checked ${paths.length} ${
        paths.length === 1 ? "item" : "items"
      }. All paths look good.`,
    );
  } else {
    void vscode.window.showInformationMessage(
      `Sweet Shelf: checked ${paths.length} ${
        paths.length === 1 ? "item" : "items"
      }. ${broken} ${broken === 1 ? "is" : "are"} missing.`,
    );
  }
}

function showBrokenClickToast(): void {
  void vscode.window.showInformationMessage(
    "Sweet Shelf: this item is missing. Right-click to relocate it or remove it from your shelf.",
  );
}

interface BrokenTarget {
  scope: "library" | "favorite";
  id: string;
  path: string;
  kind: "file" | "folder";
}

function brokenTarget(node: ShelfNode | undefined): BrokenTarget | null {
  if (!node) {
    return null;
  }
  switch (node.kind) {
    case "file":
      return {
        scope: "library",
        id: node.file.id,
        path: node.file.path,
        kind: "file",
      };
    case "folder":
      return {
        scope: "library",
        id: node.folder.id,
        path: node.folder.path,
        kind: "folder",
      };
    case "favoritesEntry":
      return {
        scope: "favorite",
        id: node.favorite.id,
        path: node.favorite.path,
        kind: node.favorite.kind,
      };
    case "recentEntry":
      return {
        scope: "library",
        id: node.ref.id,
        path: node.ref.path,
        kind: node.ref.kind,
      };
    default:
      return null;
  }
}

async function safeStat(
  uri: vscode.Uri,
): Promise<vscode.FileStat | null> {
  try {
    return await vscode.workspace.fs.stat(uri);
  } catch (err) {
    if (err instanceof vscode.FileSystemError) {
      if (err.code === "FileNotFound" || err.code === "EntryNotFound") {
        return null;
      }
    }
    logError(`stat ${uri.fsPath}`, err);
    return null;
  }
}

/**
 * Walk parent directories upward until one resolves on disk. Returns
 * `null` only if every ancestor (up to the filesystem root) is also
 * missing — extremely unlikely on a normal filesystem. `fellBack` is
 * `true` whenever we had to walk past the immediate parent.
 */
async function findExistingAncestor(
  startPath: string,
): Promise<{ path: string; fellBack: boolean } | null> {
  let current = nodePath.dirname(startPath);
  let fellBack = false;
  while (true) {
    const stat = await safeStat(vscode.Uri.file(current));
    if (stat !== null) {
      return { path: current, fellBack };
    }
    fellBack = true;
    const parent = nodePath.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function collectUniquePaths(store: ShelfStore): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const node of walkAll(store.library)) {
    if (node.kind === "category") {
      continue;
    }
    if (seen.has(node.path)) {
      continue;
    }
    seen.add(node.path);
    out.push(node.path);
  }
  return out;
}

async function runCommand(
  label: string,
  fn: () => Promise<void> | void,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    logError(label, err);
    const message = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`Sweet Shelf: ${message}`);
  }
}
