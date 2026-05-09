import * as nodePath from "node:path";
import * as os from "node:os";
import * as vscode from "vscode";

import {
  buildExport,
  summarizeImport,
  type ExportMode,
  type ImportSummary,
} from "../shelf/exportImport";
import { log, logError } from "../util/logger";
import { migrateToCurrentVersion } from "../shelf/migrate";
import { validateShelfConfig } from "../config/schema";
import type { BrokenLinkCache } from "../shelf/brokenLinks";
import type { ShelfStore } from "../shelf/store";

/**
 * Export and import command handlers.
 *
 * Architectural rule: the store is replaced wholesale on import via
 * `store.replaceConfig`, which awaits an immediate flush so the
 * success toast can't race the persist. A `.pre-import-<ts>.bak`
 * backup is always written first; if anything from there onwards
 * throws, we log + toast and leave the prior state intact in memory
 * (the backup sits on disk regardless).
 *
 * Export uses the same JSON shape as `shelf.json`. There is no
 * separate "export schema" — round-trip fidelity comes from using
 * the persisted format directly.
 */

export function registerExportImportCommands(
  context: vscode.ExtensionContext,
  store: ShelfStore,
  brokenLinks: BrokenLinkCache,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("sweetShelf.exportShelf", () =>
      runCommand("Export Shelf", () => exportShelf(store)),
    ),
    vscode.commands.registerCommand("sweetShelf.importShelf", () =>
      runCommand("Import Shelf", () => importShelf(store, brokenLinks)),
    ),
  );
}

/* ─────────────────────── Export ─────────────────────── */

async function exportShelf(store: ShelfStore): Promise<void> {
  const mode = await pickExportMode();
  if (!mode) {
    return;
  }
  const dest = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(defaultExportFilename()),
    filters: { JSON: ["json"] },
    saveLabel: "Export",
  });
  if (!dest) {
    return;
  }
  const data = buildExport(store.config, mode, new Date().toISOString());
  const json = JSON.stringify(data, null, 2) + "\n";
  try {
    await vscode.workspace.fs.writeFile(dest, new TextEncoder().encode(json));
  } catch (err) {
    logError("export write", err);
    void vscode.window.showWarningMessage(
      "Sweet Shelf: couldn't write the export file.",
    );
    return;
  }
  log(`Exported shelf (mode=${mode}) to ${dest.fsPath}.`);
  const action = await vscode.window.showInformationMessage(
    `Sweet Shelf: exported to ${nodePath.basename(dest.fsPath)}.`,
    "Reveal",
  );
  if (action === "Reveal") {
    void vscode.commands.executeCommand("revealFileInOS", dest);
  }
}

interface ModePick extends vscode.QuickPickItem {
  mode: ExportMode;
}

async function pickExportMode(): Promise<ExportMode | undefined> {
  const items: ModePick[] = [
    {
      label: "Shelf structure (recommended)",
      description: "Categories, files, aliases, colors, favorites — no usage history.",
      mode: "structure",
    },
    {
      label: "Everything (including usage history)",
      description: "Full state: timestamps, last-opened times, the works.",
      mode: "everything",
    },
  ];
  const choice = await vscode.window.showQuickPick(items, {
    placeHolder: "What would you like to export?",
  });
  return choice?.mode;
}

function defaultExportFilename(): string {
  const date = new Date().toISOString().slice(0, 10);
  return nodePath.join(os.homedir(), `sweet-shelf-export-${date}.json`);
}

/* ─────────────────────── Import ─────────────────────── */

async function importShelf(
  store: ShelfStore,
  brokenLinks: BrokenLinkCache,
): Promise<void> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters: { JSON: ["json"] },
    openLabel: "Import",
  });
  if (!picked || picked.length === 0) {
    return;
  }
  const sourceUri = picked[0];

  let raw: string;
  try {
    const bytes = await vscode.workspace.fs.readFile(sourceUri);
    raw = new TextDecoder("utf-8").decode(bytes);
  } catch (err) {
    logError("import read", err);
    void vscode.window.showWarningMessage(
      "Sweet Shelf: couldn't read that file.",
    );
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    void vscode.window.showWarningMessage(
      "Sweet Shelf: this file isn't valid JSON.",
    );
    return;
  }

  const migrated = migrateToCurrentVersion(parsed);
  if (!migrated.ok) {
    log(`Import rejected at migration step: ${migrated.reason}`);
    void vscode.window.showWarningMessage(`Sweet Shelf: ${migrated.reason}`);
    return;
  }

  const validation = validateShelfConfig(migrated.config);
  if (!validation.ok) {
    log(`Import rejected at validation step: ${validation.error}`);
    void vscode.window.showWarningMessage(
      `Sweet Shelf: this export contains invalid data — ${validation.error}`,
    );
    return;
  }

  const summary = summarizeImport(validation.value);
  const choice = await vscode.window.showWarningMessage(
    composeImportConfirmation(summary),
    { modal: true },
    "Import",
  );
  if (choice !== "Import") {
    return;
  }

  let backupUri: vscode.Uri;
  try {
    backupUri = await store.backupCurrentTo();
  } catch (err) {
    logError("import backup", err);
    void vscode.window.showWarningMessage(
      "Sweet Shelf: couldn't create backup. Import canceled.",
    );
    return;
  }

  try {
    await store.replaceConfig(validation.value);
  } catch (err) {
    logError("import replaceConfig", err);
    void vscode.window.showWarningMessage(
      "Sweet Shelf: couldn't complete import. Your shelf is unchanged.",
    );
    return;
  }

  // Paths almost certainly changed; old cache entries are no longer
  // meaningful. The decoration provider will lazily re-stat as items
  // render in the refreshed tree.
  brokenLinks.invalidateAll();

  log(
    `Imported shelf from ${sourceUri.fsPath} (${summary.categories} categories, ${summary.files} files, ${summary.folders} folders, ${summary.favorites} favorites). Backup at ${backupUri.fsPath}.`,
  );

  if (validation.warnings.length > 0) {
    for (const w of validation.warnings) {
      log(`Import warning: ${w}`);
    }
  }

  const action = await vscode.window.showInformationMessage(
    composeImportSuccess(summary),
    "Reveal Backup",
  );
  if (action === "Reveal Backup") {
    void vscode.commands.executeCommand("revealFileInOS", backupUri);
  }
}

function composeImportConfirmation(summary: ImportSummary): string {
  const itemsLine = formatSummaryLine(summary);
  return `Import will replace your current shelf.\n\nImporting ${itemsLine}.\n\nYour current shelf will be backed up before the replace.`;
}

function composeImportSuccess(summary: ImportSummary): string {
  return `Sweet Shelf: imported ${formatSummaryLine(summary)}. Previous shelf backed up.`;
}

function formatSummaryLine(s: ImportSummary): string {
  const parts: string[] = [];
  parts.push(`${s.categories} ${s.categories === 1 ? "category" : "categories"}`);
  parts.push(`${s.files} ${s.files === 1 ? "file" : "files"}`);
  parts.push(`${s.folders} ${s.folders === 1 ? "folder" : "folders"}`);
  parts.push(`${s.favorites} ${s.favorites === 1 ? "favorite" : "favorites"}`);
  return parts.join(", ");
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
