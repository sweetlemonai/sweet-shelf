import * as vscode from "vscode";

import { COMPANION_APPS, type CompanionApp } from "./companionApps";

/**
 * State the webview needs to render. The extension reads this on
 * `ready`, on `onDidChangeConfiguration`, and on
 * `vscode.extensions.onDidChange`, then posts it to the webview as a
 * single `state` message.
 */
export interface SettingsState {
  defaultFolderClickAction: "browse" | "openInCurrentWindow" | "openInNewWindow";
  defaultFileClickAction: "open" | "openToSide";
  maxRecentItems: number;
  showFileExtensions: boolean;
  showHiddenFiles: boolean;
  confirmRemoveCategory: boolean;
}

export interface AppCardState {
  extensionId: string;
  displayName: string;
  description: string;
  /** Webview-loadable URI string, or `undefined` when the asset is missing. */
  iconWebviewUri?: string;
  installed: boolean;
  /**
   * Lifecycle from the registry. `"published"` (default) → the card
   * renders Install / Installed+Open. `"coming-soon"` → the card
   * shows a muted pill and no action buttons.
   */
  status: "published" | "coming-soon";
}

/**
 * Snapshot of every Sweet Shelf setting the custom panel renders.
 * Mirrors the `package.json` `contributes.configuration` block;
 * defaults must stay in sync with the package.json defaults.
 */
export function readSettings(): SettingsState {
  const cfg = vscode.workspace.getConfiguration("sweetShelf");
  return {
    defaultFolderClickAction: cfg.get<SettingsState["defaultFolderClickAction"]>(
      "defaultFolderClickAction",
      "browse",
    ),
    defaultFileClickAction: cfg.get<SettingsState["defaultFileClickAction"]>(
      "defaultFileClickAction",
      "open",
    ),
    maxRecentItems: cfg.get<number>("maxRecentItems", 20),
    showFileExtensions: cfg.get<boolean>("showFileExtensions", true),
    showHiddenFiles: cfg.get<boolean>("showHiddenFiles", false),
    confirmRemoveCategory: cfg.get<boolean>("confirmRemoveCategory", true),
  };
}

/**
 * Build the apps section state. Each entry is the registry's static
 * data plus a live `installed` flag and a webview-resolved icon URI.
 *
 * The webview can't load extension-relative URIs directly — they
 * have to go through `webview.asWebviewUri()`. We resolve them here
 * so the webview's renderer just consumes a string.
 */
export function readApps(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
): AppCardState[] {
  return COMPANION_APPS.map((app) => buildAppCard(app, webview, extensionUri));
}

function buildAppCard(
  app: CompanionApp,
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
): AppCardState {
  const out: AppCardState = {
    extensionId: app.extensionId,
    displayName: app.displayName,
    description: app.description,
    installed: vscode.extensions.getExtension(app.extensionId) !== undefined,
    status: app.status ?? "published",
  };
  if (app.iconPath !== undefined) {
    const onDisk = vscode.Uri.joinPath(extensionUri, "media", app.iconPath);
    out.iconWebviewUri = webview.asWebviewUri(onDisk).toString();
  }
  return out;
}
