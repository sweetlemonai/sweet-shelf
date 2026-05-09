import * as vscode from "vscode";

/**
 * Resolves on-disk locations for shelf persistence. Centralized so future
 * tasks (export/import, migrations) have a single place to look.
 */
export interface ShelfPaths {
  /** Directory holding all Sweet Shelf state. */
  readonly storageDir: vscode.Uri;
  /** Primary config file. */
  readonly configFile: vscode.Uri;
  /** Backup file written when the primary config fails to parse. */
  readonly backupFile: vscode.Uri;
}

/**
 * Build the set of paths used by the store, rooted at the extension's
 * `globalStorageUri`. Caller is responsible for ensuring the directory
 * exists before reading/writing.
 */
export function resolveShelfPaths(globalStorageUri: vscode.Uri): ShelfPaths {
  return {
    storageDir: globalStorageUri,
    configFile: vscode.Uri.joinPath(globalStorageUri, "shelf.json"),
    backupFile: vscode.Uri.joinPath(globalStorageUri, "shelf.json.bak"),
  };
}
