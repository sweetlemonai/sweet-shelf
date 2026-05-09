import * as vscode from "vscode";

import { BrokenLinkCache } from "./shelf/brokenLinks";
import { ShelfStore, type LoadOutcome } from "./shelf/store";
import { SweetShelfTreeProvider } from "./shelf/treeProvider";
import { SweetShelfDecorationProvider } from "./ui/decorations";
import { SweetShelfDragAndDropController } from "./ui/dragAndDrop";
import { initLogger, log, logWarn } from "./util/logger";
import { registerCommands } from "./commands";
import type { ShelfNode } from "./shelf/types";

let storeRef: ShelfStore | undefined;

/**
 * Extension entrypoint. Builds the store, loads persisted state, wires up
 * the tree view (with drag-and-drop), and registers every command. Heavy
 * work is intentionally kept out of activation — we only run when the
 * sidebar view is opened.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const channel = vscode.window.createOutputChannel("Sweet Shelf");
  context.subscriptions.push(channel);
  initLogger(channel);
  log("Sweet Shelf activating.");

  const store = new ShelfStore(context.globalStorageUri);
  storeRef = store;
  context.subscriptions.push(store);

  // The broken-link cache backs Task 7's broken decoration + the
  // ⚠ tree-row treatment. Construct early and inject into the store
  // so add/rename/locate flows can mark known-good or invalidate
  // entries without re-statting on every render.
  const brokenLinks = new BrokenLinkCache();
  context.subscriptions.push(brokenLinks);
  store.setBrokenLinkCache(brokenLinks);

  const outcome = await store.load();
  reportLoadOutcome(outcome);

  // Activation-time orphan check: if shelf.json says we're focused on
  // something that no longer exists (hand-edited file, weird state),
  // exit silently with a log entry — toasting on launch is intrusive.
  // The tree provider's defensive path covers mid-session orphans.
  if (store.isFocused() && !store.getFocusedItem()) {
    logWarn(
      "Activation: focused item couldn't be found; exited focus silently.",
    );
    store.exitFocus();
  }

  // Sync the `sweetShelf.focused` context key with store state. The
  // first call runs *before* the tree provider registers so the
  // initial getChildren already sees the right mode (no flicker
  // between normal and focused on activation). Subsequent store
  // changes re-sync via the subscription.
  const syncFocusContext = (): void => {
    void vscode.commands.executeCommand(
      "setContext",
      "sweetShelf.focused",
      store.isFocused(),
    );
  };
  syncFocusContext();
  context.subscriptions.push(store.onDidChange(syncFocusContext));

  const provider = new SweetShelfTreeProvider(store, brokenLinks);
  context.subscriptions.push(provider);

  const dndController = new SweetShelfDragAndDropController(store);
  const treeView = vscode.window.createTreeView<ShelfNode>(
    "sweetShelf.mainView",
    {
      treeDataProvider: provider,
      showCollapseAll: true,
      canSelectMany: false,
      dragAndDropController: dndController,
    },
  );
  context.subscriptions.push(treeView);

  const decorationProvider = new SweetShelfDecorationProvider(
    store,
    brokenLinks,
  );
  context.subscriptions.push(decorationProvider);
  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(decorationProvider),
  );

  registerCommands(context, store, treeView, brokenLinks, provider);
  log("Sweet Shelf ready.");
}

/**
 * Called by VS Code on shutdown. Flushes any pending debounced writes
 * so we don't lose the last 200ms of state changes.
 */
export async function deactivate(): Promise<void> {
  await storeRef?.flushPendingWrites();
  storeRef = undefined;
}

function reportLoadOutcome(outcome: LoadOutcome): void {
  switch (outcome.kind) {
    case "loaded":
      if (outcome.warnings.length > 0) {
        for (const w of outcome.warnings) {
          logWarn(w);
        }
        void vscode.window.showInformationMessage(
          `Sweet Shelf: tidied up ${outcome.warnings.length} entr${
            outcome.warnings.length === 1 ? "y" : "ies"
          } in your shelf (see the Sweet Shelf output channel for details).`,
        );
      }
      return;
    case "created-default":
      log("No shelf.json found; wrote defaults.");
      return;
    case "recovered-from-invalid":
      logWarn(`shelf.json invalid: ${outcome.error}`);
      void vscode.window.showWarningMessage(
        "Sweet Shelf: couldn't read your shelf, starting fresh. The previous file was saved as shelf.json.bak.",
      );
      return;
    case "storage-unavailable":
      logWarn(`storage unavailable: ${outcome.error}`);
      void vscode.window.showWarningMessage(
        `Sweet Shelf: storage is unavailable (${outcome.error}). Running with in-memory state only — changes won't persist.`,
      );
      return;
    default:
      return assertNever(outcome);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unexpected variant: ${JSON.stringify(value)}`);
}
