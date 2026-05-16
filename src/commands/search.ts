import * as nodePath from "node:path";
import * as vscode from "vscode";

import {
  ancestorCategoryIds,
  applyFilters,
  buildSearchableItems,
  parseQuery,
  type AncestorLookup,
  type SearchableItem,
  type SearchFilters,
} from "../shelf/search";
import { logError } from "../util/logger";
import { pathsEqual } from "../shelf/paths";
import type { BrokenLinkCache } from "../shelf/brokenLinks";
import type { ShelfNode } from "../shelf/types";
import type { ShelfStore } from "../shelf/store";
import type { LibraryTreeProvider } from "../ui/libraryTreeProvider";

/**
 * Search Quick Pick — the keyboard-driven navigation primitive.
 *
 * One library walk per session (when the command is invoked). Filter
 * tokens at the start of the input are parsed, accumulated in
 * `activeFilters`, and stripped from `picker.value` so Quick Pick's
 * native fuzzy match runs cleanly against the freeText that follows.
 *
 * Selection always succeeds in revealing — if the user is in Focus
 * Mode and picks something outside the focused subtree, focus exits
 * silently first. Search is a navigation primitive; it should never
 * fail to take you somewhere.
 */

interface PlaceholderPickItem extends vscode.QuickPickItem {
  isPlaceholder: true;
}

type PickItem = SearchableItem | PlaceholderPickItem;

export function registerSearchCommands(
  context: vscode.ExtensionContext,
  store: ShelfStore,
  treeView: vscode.TreeView<ShelfNode>,
  brokenLinks: BrokenLinkCache,
  provider: LibraryTreeProvider,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("sweetShelf.search", (scopeNodeId?: string) =>
      runCommand("Search Shelf", () =>
        openSearch(store, treeView, brokenLinks, provider, scopeNodeId),
      ),
    ),
    vscode.commands.registerCommand(
      "sweetShelf.searchInCategory",
      (node?: ShelfNode) =>
        runCommand("Search in Category", () => searchInCategory(node)),
    ),
  );
}

/**
 * Right-click "Search in this category" entry. Pulls the id off the
 * right-clicked node and dispatches to `sweetShelf.search` with it as
 * the scope argument. Folder refs don't get this affordance (they
 * have no shelf descendants to scope into); the menu `when` clause
 * already gates on `viewItem == category`.
 */
async function searchInCategory(node: ShelfNode | undefined): Promise<void> {
  if (!node || node.kind !== "category") {
    throw new Error("This command needs to be run on a category.");
  }
  await vscode.commands.executeCommand("sweetShelf.search", node.category.id);
}

async function openSearch(
  store: ShelfStore,
  treeView: vscode.TreeView<ShelfNode>,
  brokenLinks: BrokenLinkCache,
  provider: LibraryTreeProvider,
  scopeNodeId: string | undefined,
): Promise<void> {
  const showExtensions = vscode.workspace
    .getConfiguration("sweetShelf")
    .get<boolean>("showFileExtensions", true);
  const allItems = buildSearchableItems(
    store.library,
    (path) => store.isFavoritedPath(path),
    brokenLinks,
    showExtensions,
    scopeNodeId,
  );

  if (allItems.length === 0) {
    await showEmptyShelfQuickPick(scopeNodeId !== undefined);
    return;
  }

  const picker = vscode.window.createQuickPick<PickItem>();
  picker.placeholder = scopedPlaceholder(scopeNodeId, store);
  picker.matchOnDescription = true;
  picker.matchOnDetail = false;
  picker.items = allItems;

  const activeFilters: SearchFilters = {};
  let isProgrammatic = false;

  const refreshItems = (): void => {
    picker.items = applyFilters(allItems, activeFilters);
  };

  picker.onDidChangeValue((value) => {
    if (isProgrammatic) {
      isProgrammatic = false;
      // The programmatic value-change is the freeText after stripping;
      // items already reflect the new active filters.
      return;
    }
    const parsed = parseQuery(value);
    if (parsed.consumedToken) {
      if (parsed.filters.color !== undefined) {
        activeFilters.color = parsed.filters.color;
      }
      if (parsed.filters.is !== undefined) {
        activeFilters.is = parsed.filters.is;
      }
      refreshItems();
      isProgrammatic = true;
      picker.value = parsed.remainder;
      return;
    }
    // No new token — items reflect the existing activeFilters,
    // Quick Pick's native fuzzy match runs against picker.value.
    refreshItems();
  });

  picker.onDidAccept(() => {
    const sel = picker.selectedItems[0];
    if (sel) {
      void handleSelection(sel, store, treeView, provider).catch((err) => {
        logError("Search dispatch", err);
      });
    }
    picker.hide();
  });

  picker.onDidHide(() => {
    picker.dispose();
  });

  picker.show();
}

async function showEmptyShelfQuickPick(scoped: boolean): Promise<void> {
  if (scoped) {
    await vscode.window.showQuickPick(
      [
        {
          label: "This category is empty.",
          description: "Nothing to search in here yet.",
        },
      ],
      { placeHolder: "Nothing to search yet" },
    );
    return;
  }
  await vscode.window.showQuickPick(
    [
      {
        label: "Your shelf is empty.",
        description: "Add files, folders, or categories to start.",
      },
    ],
    { placeHolder: "Nothing to search yet" },
  );
}

/**
 * Quick Pick placeholder copy. Unscoped search hints the filter
 * syntax; scoped search names the category instead so the user
 * remembers what context they're searching in.
 */
function scopedPlaceholder(
  scopeNodeId: string | undefined,
  store: ShelfStore,
): string {
  if (scopeNodeId === undefined) {
    return "Search your shelf — try color:red or is:favorited";
  }
  const cat = store.findCategory(scopeNodeId);
  if (!cat) {
    return "Search your shelf — try color:red or is:favorited";
  }
  return `Searching in "${cat.label}"…`;
}

async function handleSelection(
  item: PickItem,
  store: ShelfStore,
  treeView: vscode.TreeView<ShelfNode>,
  provider: LibraryTreeProvider,
): Promise<void> {
  if ("isPlaceholder" in item) {
    return;
  }

  // If we're focused and the selection lives outside the focused
  // subtree, exit focus silently — search is a navigation primitive,
  // and a user who picked a result is signaling "take me there."
  if (store.isFocused()) {
    const focused = store.getFocusedItem();
    if (focused && !isInFocusSubtree(item, focused, store)) {
      store.exitFocus();
    }
  }

  const node = provider.nodeForId(item.ref.id);
  if (!node) {
    return;
  }

  try {
    await treeView.reveal(node, { select: true, focus: false, expand: true });
  } catch (err) {
    logError("Search reveal", err);
  }

  if (item.isBroken) {
    void vscode.commands.executeCommand("sweetShelf._brokenClick", node);
    return;
  }

  switch (item.nodeKind) {
    case "category":
      // Reveal already expanded it — nothing further to do.
      return;
    case "file":
      await vscode.commands.executeCommand(
        "sweetShelf._openFileDefault",
        node,
      );
      return;
    case "folder":
      await vscode.commands.executeCommand(
        "sweetShelf._openFolderDefault",
        node,
      );
      return;
  }
}

/**
 * True iff `item`'s ref lives inside the focused subtree. For category
 * focus we walk up the category ancestor chain. For folder focus we
 * compare paths — only file/folder refs whose path is a descendant of
 * the focused folder count (categories are never "inside" a folder
 * structurally).
 */
function isInFocusSubtree(
  item: SearchableItem,
  focused: ReturnType<ShelfStore["getFocusedItem"]>,
  store: ShelfStore,
): boolean {
  if (!focused) {
    return false;
  }
  if (focused.kind === "folder") {
    if (item.nodeKind === "category") {
      return false;
    }
    if (item.ref.id === focused.folder.id) {
      return true;
    }
    const itemPath = (item.ref as { path: string }).path;
    return isPathInsideFolder(itemPath, focused.folder.path);
  }
  // Category focus
  if (item.ref.id === focused.category.id) {
    return true;
  }
  const lookup: AncestorLookup = {
    firstParent: (id) => {
      const cat = store.findCategory(id);
      if (cat) {
        return store.getCategoryParent(id)?.parent?.id ?? null;
      }
      return store.getRefParent(id)?.parent.id ?? null;
    },
    parentOf: (categoryId) =>
      store.getCategoryParent(categoryId)?.parent?.id ?? null,
  };
  return ancestorCategoryIds(item.ref.id, lookup).includes(focused.category.id);
}

/**
 * True when `child` is a path under `parent` (not equal). Uses
 * `pathsEqual`-style case folding on macOS / Windows; case-sensitive
 * on Linux.
 */
function isPathInsideFolder(child: string, parent: string): boolean {
  if (pathsEqual(child, parent)) {
    return false;
  }
  // Reuse pathsEqual on the path-prefix manually: walk up child's
  // dirs until we either match parent or hit root.
  let current = child;
  while (true) {
    const parentDir = nodePath.dirname(current);
    if (parentDir === current) {
      return false;
    }
    if (pathsEqual(parentDir, parent)) {
      return true;
    }
    current = parentDir;
  }
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
