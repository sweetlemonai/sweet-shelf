import * as vscode from "vscode";

import { buildEntryTreeItem } from "./treeItemBuilders";
import { buildFavoritesView } from "../shelf/favorites";
import type { BrokenLinkCache } from "../shelf/brokenLinks";
import type { ShelfNode } from "../shelf/types";
import type { ShelfStore } from "../shelf/store";

const LABEL_AFFECTING_SETTINGS: readonly string[] = [
  "sweetShelf.showFileExtensions",
];

/**
 * TreeDataProvider for the Favorites view.
 *
 * Renders one `favoritesEntry` row per id in `favoritesOrder`,
 * resolved against the live library. Drift cleanup happens here
 * (orphaned ids dropped, unlisted-but-favorited refs appended) via
 * `buildFavoritesView`; the resulting cleaned order is persisted
 * back through `store.replaceFavoritesOrder` and the second render
 * is a no-op.
 *
 * Empty-state copy is rendered via `TreeView.message` (set externally
 * in `extension.ts`); this provider just returns an empty array when
 * there are no favorites.
 */
export class FavoritesTreeProvider
  implements vscode.TreeDataProvider<ShelfNode>, vscode.Disposable
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    ShelfNode | undefined
  >();
  readonly onDidChangeTreeData: vscode.Event<ShelfNode | undefined> =
    this._onDidChangeTreeData.event;

  private readonly storeSubscription: vscode.Disposable;
  private readonly configSubscription: vscode.Disposable;
  private readonly cacheSubscription: vscode.Disposable;

  constructor(
    private readonly store: ShelfStore,
    private readonly brokenLinks: BrokenLinkCache,
  ) {
    this.storeSubscription = store.onDidChange(() => {
      this._onDidChangeTreeData.fire(undefined);
    });
    this.configSubscription = vscode.workspace.onDidChangeConfiguration((e) => {
      if (LABEL_AFFECTING_SETTINGS.some((key) => e.affectsConfiguration(key))) {
        this._onDidChangeTreeData.fire(undefined);
      }
    });
    this.cacheSubscription = brokenLinks.onDidUpdate(() => {
      this._onDidChangeTreeData.fire(undefined);
    });
  }

  getTreeItem(node: ShelfNode): vscode.TreeItem {
    if (node.kind !== "favoritesEntry") {
      throw new Error(
        `FavoritesTreeProvider received unexpected node kind: ${node.kind}`,
      );
    }
    return buildEntryTreeItem(
      node.ref,
      "favoritesEntry",
      this.store.library,
      this.showFileExtensions(),
      /* includeFavoritedFlag */ false,
      this.brokenStateFor(node.ref.path),
    );
  }

  getChildren(node?: ShelfNode): ShelfNode[] {
    if (!node) {
      const view = buildFavoritesView(
        this.store.library,
        this.store.favoritesOrder,
      );
      if (view.cleanedOrder !== null) {
        // Persist the cleaned order. The resulting onDidChange fires
        // a re-render; the second pass finds drift === false and is
        // a no-op, so the recursion terminates in one bounce.
        this.store.replaceFavoritesOrder(view.cleanedOrder);
      }
      return view.refs.map((ref) => ({ kind: "favoritesEntry", ref }));
    }
    return [];
  }

  getParent(): ShelfNode | undefined {
    // All favorites entries live at the view's root — there's no
    // parent chain to walk.
    return undefined;
  }

  /**
   * Convenience for the Clear Favorites context-key sync (and any
   * future view-title affordances): is the user's favorites list
   * empty right now?
   */
  isEmpty(): boolean {
    return buildFavoritesView(this.store.library, this.store.favoritesOrder)
      .refs.length === 0;
  }

  dispose(): void {
    this.storeSubscription.dispose();
    this.configSubscription.dispose();
    this.cacheSubscription.dispose();
    this._onDidChangeTreeData.dispose();
  }

  private brokenStateFor(path: string): boolean {
    const cached = this.brokenLinks.isBroken(path);
    if (cached === undefined) {
      this.brokenLinks.scheduleCheck(path);
      return false;
    }
    return cached;
  }

  private showFileExtensions(): boolean {
    return vscode.workspace
      .getConfiguration("sweetShelf")
      .get<boolean>("showFileExtensions", true);
  }
}
