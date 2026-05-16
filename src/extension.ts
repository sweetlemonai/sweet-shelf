import * as vscode from "vscode";

import { BrokenLinkCache } from "./shelf/brokenLinks";
import { FavoritesTreeProvider } from "./ui/favoritesTreeProvider";
import { LibraryTreeProvider } from "./ui/libraryTreeProvider";
import { RecentTreeProvider } from "./ui/recentTreeProvider";
import { ShelfStore, type LoadOutcome } from "./shelf/store";
import { SweetShelfDecorationProvider } from "./ui/decorations";
import { SweetShelfDragAndDropController } from "./ui/dragAndDrop";
import { initLogger, log, logWarn } from "./util/logger";
import { registerCommands } from "./commands";
import type { ShelfNode } from "./shelf/types";

let storeRef: ShelfStore | undefined;

const FAVORITES_EMPTY_MESSAGE =
  "No favorites yet. Right-click any file or folder to add one.";
const RECENT_EMPTY_MESSAGE =
  "Nothing recent. Files you open from your shelf will appear here.";
const LIBRARY_EMPTY_MESSAGE =
  "No categories yet. Click + above to create one.";
const LIBRARY_EMPTY_FOCUSED_CATEGORY_MESSAGE =
  "This category is empty. Click 'Show All' to see your full shelf.";

/**
 * Extension entrypoint. Builds the store, loads persisted state, wires
 * up three tree views (Library / Favorites / Recent), and registers
 * every command. Heavy work is kept out of activation — we only run
 * when the sidebar is opened.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const channel = vscode.window.createOutputChannel("Sweet Shelf");
  context.subscriptions.push(channel);
  initLogger(channel);
  log("Sweet Shelf activating.");

  const store = new ShelfStore(context.globalStorageUri);
  storeRef = store;
  context.subscriptions.push(store);

  // The broken-link cache backs the broken-decoration + ⚠ row
  // treatment. Construct early and inject so add/rename/locate flows
  // can mark known-good or invalidate entries without re-statting.
  const brokenLinks = new BrokenLinkCache();
  context.subscriptions.push(brokenLinks);
  store.setBrokenLinkCache(brokenLinks);

  const outcome = await store.load();
  reportLoadOutcome(outcome);
  // Watch shelf.json so a second VS Code window mutating it shows
  // up here without a reload. Internal writes from this process are
  // filtered out inside the store.
  store.startWatching();

  // Activation-time orphan check: if shelf.json says we're focused on
  // something that no longer exists (hand-edited file, weird state),
  // exit silently with a log entry — toasting on launch is intrusive.
  // The Library provider's defensive path covers mid-session orphans.
  if (store.isFocused() && !store.getFocusedItem()) {
    logWarn(
      "Activation: focused item couldn't be found; exited focus silently.",
    );
    store.exitFocus();
  }

  // Sync the `sweetShelf.focused` context key. The first call runs
  // *before* views register so the initial render already sees the
  // right mode (Favorites/Recent hide via `when` clauses, no flicker).
  const syncFocusContext = (): void => {
    void vscode.commands.executeCommand(
      "setContext",
      "sweetShelf.focused",
      store.isFocused(),
    );
  };
  syncFocusContext();
  context.subscriptions.push(store.onDidChange(syncFocusContext));

  const libraryProvider = new LibraryTreeProvider(store, brokenLinks);
  const favoritesProvider = new FavoritesTreeProvider(store, brokenLinks);
  const recentProvider = new RecentTreeProvider(store, brokenLinks);
  context.subscriptions.push(libraryProvider, favoritesProvider, recentProvider);

  const libraryView = vscode.window.createTreeView<ShelfNode>(
    "sweetShelf.libraryView",
    {
      treeDataProvider: libraryProvider,
      showCollapseAll: true,
      canSelectMany: false,
      dragAndDropController: new SweetShelfDragAndDropController(
        "library",
        store,
      ),
    },
  );
  const favoritesView = vscode.window.createTreeView<ShelfNode>(
    "sweetShelf.favoritesView",
    {
      treeDataProvider: favoritesProvider,
      showCollapseAll: false,
      canSelectMany: false,
      dragAndDropController: new SweetShelfDragAndDropController(
        "favorites",
        store,
      ),
    },
  );
  const recentView = vscode.window.createTreeView<ShelfNode>(
    "sweetShelf.recentView",
    {
      treeDataProvider: recentProvider,
      showCollapseAll: false,
      canSelectMany: false,
      dragAndDropController: new SweetShelfDragAndDropController(
        "recent",
        store,
      ),
    },
  );
  context.subscriptions.push(libraryView, favoritesView, recentView);

  // Library view title: "Focus: <name>" while focused, "Library"
  // otherwise. Refreshed on every store change so it tracks the
  // focused item's display name (alias-aware).
  const syncLibraryTitle = (): void => {
    if (store.isFocused()) {
      const focused = store.getFocusedItem();
      if (focused) {
        const name =
          focused.kind === "category"
            ? focused.category.label
            : focused.folder.alias ?? focused.folder.label;
        libraryView.title = `Focus: ${name}`;
        return;
      }
    }
    libraryView.title = "Library";
  };
  syncLibraryTitle();
  context.subscriptions.push(store.onDidChange(syncLibraryTitle));

  // Empty-state messages via `TreeView.message` (the built-in banner
  // above an empty tree). Refreshed on every store change.
  const syncMessages = (): void => {
    if (store.isFocused()) {
      // Library in focus mode: when the focused category has no
      // children, show the friendly empty-category message above the
      // focus header.
      const focused = store.getFocusedItem();
      if (
        focused &&
        focused.kind === "category" &&
        focused.category.children.length === 0
      ) {
        libraryView.message = LIBRARY_EMPTY_FOCUSED_CATEGORY_MESSAGE;
      } else {
        libraryView.message = "";
      }
    } else {
      libraryView.message =
        store.library.length === 0 ? LIBRARY_EMPTY_MESSAGE : "";
    }
    favoritesView.message = favoritesProvider.isEmpty()
      ? FAVORITES_EMPTY_MESSAGE
      : "";
    recentView.message = recentProvider.isEmpty()
      ? RECENT_EMPTY_MESSAGE
      : "";
  };
  syncMessages();
  context.subscriptions.push(store.onDidChange(syncMessages));

  const decorationProvider = new SweetShelfDecorationProvider(
    store,
    brokenLinks,
  );
  context.subscriptions.push(decorationProvider);
  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(decorationProvider),
  );

  registerCommands(context, store, libraryView, brokenLinks, libraryProvider);
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
