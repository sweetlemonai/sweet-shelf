import * as vscode from "vscode";

import { createOrShowSettings } from "../settings/panel";
import { logError } from "../util/logger";

/**
 * Registers `sweetShelf.openSettings` — the gear icon's click target
 * in the Library view title bar. Single-instance webview management
 * lives in `settings/panel.ts`; this module is a thin command-
 * registration wrapper so the extension's command graph stays
 * uniform with the rest of `commands/*`.
 */
export function registerSettingsCommands(
  context: vscode.ExtensionContext,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("sweetShelf.openSettings", () => {
      try {
        createOrShowSettings(context.extensionUri);
      } catch (err) {
        logError("openSettings", err);
        const message = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(
          `Sweet Shelf: couldn't open settings (${message}).`,
        );
      }
    }),
  );
}
