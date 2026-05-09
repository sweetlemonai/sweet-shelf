import * as vscode from "vscode";

import {
  COMPANION_APPS,
  SWEET_LEMON_PUBLISHER_URL,
} from "./companionApps";
import { logError, logWarn } from "../util/logger";
import { readApps, readSettings } from "./state";
import { renderSettingsHtml } from "./html";

/**
 * Single-instance webview panel for "Sweet Shelf Settings".
 *
 * `createOrShow` is the single entrypoint:
 *   - If the panel is already open, focus it (the user clicked the
 *     gear icon a second time).
 *   - Otherwise create the panel, install the message handler, and
 *     subscribe to settings + extension changes for the lifetime of
 *     the panel.
 *
 * The panel is the only place in the codebase that imports the
 * webview HTML; the rest of the extension talks to it exclusively
 * via `postMessage`. This isolation means future styling changes
 * stay confined to `html.ts`.
 */

const VIEW_TYPE = "sweetShelfSettings";
const TITLE = "Sweet Shelf Settings";

let currentPanel: vscode.WebviewPanel | undefined;
let panelDisposables: vscode.Disposable[] = [];

interface UpdateSettingMessage {
  type: "updateSetting";
  key: string;
  value: unknown;
}

interface InstallAppMessage {
  type: "installApp";
  extensionId: string;
}

interface OpenAppMessage {
  type: "openApp";
  extensionId: string;
}

type WebviewMessage =
  | { type: "ready" }
  | UpdateSettingMessage
  | InstallAppMessage
  | OpenAppMessage
  | { type: "openMore" };

/** Settings keys writable from the custom panel. Anything else is rejected. */
const ALLOWED_SETTING_KEYS = new Set([
  "defaultFolderClickAction",
  "defaultFileClickAction",
  "maxRecentItems",
  "showFileExtensions",
  "showHiddenFiles",
  "confirmRemoveCategory",
]);

/**
 * Create a new Settings panel or focus the existing one.
 * `extensionUri` is the extension's installed location, used to
 * resolve companion-app icon paths via `webview.asWebviewUri`.
 */
export function createOrShowSettings(extensionUri: vscode.Uri): void {
  if (currentPanel) {
    currentPanel.reveal(vscode.ViewColumn.Active);
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    VIEW_TYPE,
    TITLE,
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: false,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
    },
  );
  currentPanel = panel;

  panel.webview.html = renderSettingsHtml(panel.webview);

  // Wire the message handler. The webview's first action on load is
  // to post `ready`; we respond with the initial state.
  const messageSub = panel.webview.onDidReceiveMessage(
    async (msg: WebviewMessage) => {
      try {
        await handleMessage(msg, panel, extensionUri);
      } catch (err) {
        logError("settings webview message", err);
      }
    },
  );
  panelDisposables.push(messageSub);

  // Settings changes (made anywhere) push fresh state to the webview.
  const configSub = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("sweetShelf")) {
      sendState(panel, extensionUri);
    }
  });
  panelDisposables.push(configSub);

  // Extension installs / uninstalls flip the "Installed" pill.
  const extensionsSub = vscode.extensions.onDidChange(() => {
    sendState(panel, extensionUri);
  });
  panelDisposables.push(extensionsSub);

  panel.onDidDispose(() => {
    currentPanel = undefined;
    for (const d of panelDisposables) {
      try {
        d.dispose();
      } catch (err) {
        logError("settings panel disposable", err);
      }
    }
    panelDisposables = [];
  });
}

async function handleMessage(
  msg: WebviewMessage,
  panel: vscode.WebviewPanel,
  extensionUri: vscode.Uri,
): Promise<void> {
  switch (msg.type) {
    case "ready":
      sendState(panel, extensionUri);
      return;
    case "updateSetting":
      await applyUpdate(msg);
      return;
    case "installApp":
      await installApp(msg.extensionId);
      return;
    case "openApp":
      await openApp(msg.extensionId);
      return;
    case "openMore":
      await vscode.env.openExternal(vscode.Uri.parse(SWEET_LEMON_PUBLISHER_URL));
      return;
    default:
      logWarn(`Unknown settings webview message: ${JSON.stringify(msg)}`);
  }
}

function sendState(
  panel: vscode.WebviewPanel,
  extensionUri: vscode.Uri,
): void {
  void panel.webview.postMessage({
    type: "state",
    settings: readSettings(),
    apps: readApps(panel.webview, extensionUri),
  });
}

async function applyUpdate(msg: UpdateSettingMessage): Promise<void> {
  if (!ALLOWED_SETTING_KEYS.has(msg.key)) {
    logWarn(`Rejected settings update for unknown key: ${msg.key}`);
    return;
  }
  const cfg = vscode.workspace.getConfiguration("sweetShelf");
  await cfg.update(msg.key, msg.value, vscode.ConfigurationTarget.Global);
  // The onDidChangeConfiguration listener will repaint the panel.
}

async function installApp(extensionId: string): Promise<void> {
  try {
    await vscode.commands.executeCommand(
      "workbench.extensions.installExtension",
      extensionId,
    );
    // The extensions.onDidChange listener will repaint the panel
    // when the install completes.
  } catch (err) {
    logError(`installing ${extensionId}`, err);
    void vscode.window.showWarningMessage(
      `Sweet Shelf: couldn't install ${extensionId}. The marketplace listing will open instead.`,
    );
    await vscode.env.openExternal(
      vscode.Uri.parse(
        `https://marketplace.visualstudio.com/items?itemName=${extensionId}`,
      ),
    );
  }
}

async function openApp(extensionId: string): Promise<void> {
  const app = COMPANION_APPS.find((a) => a.extensionId === extensionId);
  const fallbackToMarketplace = (): Thenable<boolean> =>
    vscode.env.openExternal(
      vscode.Uri.parse(
        `https://marketplace.visualstudio.com/items?itemName=${extensionId}`,
      ),
    );
  if (!app || !app.openCommand) {
    await fallbackToMarketplace();
    return;
  }
  try {
    await vscode.commands.executeCommand(app.openCommand);
  } catch (err) {
    logError(`opening ${extensionId} via ${app.openCommand}`, err);
    await fallbackToMarketplace();
  }
}

/**
 * Module-level helper used by tests / future deactivate hooks to
 * force-close the panel without going through `panel.dispose()`.
 */
export function forceCloseForTesting(): void {
  if (currentPanel) {
    currentPanel.dispose();
  }
}
