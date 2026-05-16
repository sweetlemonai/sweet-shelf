import * as vscode from "vscode";

import { buildFavoriteTreeItem } from "./treeItemBuilders";
import type { BrokenLinkCache } from "../shelf/brokenLinks";
import type { Favorite, ShelfNode } from "../shelf/types";
import type { ShelfStore } from "../shelf/store";

/**
 * TreeDataProvider for the Favorites view.
 *
 * Favorites is a flat, user-orderable list of paths
 * (`ShelfConfig.favorites`). The provider just maps the array to
 * `favoritesEntry` nodes — no resolution, no Library cross-walk.
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
  private readonly cacheSubscription: vscode.Disposable;

  constructor(
    private readonly store: ShelfStore,
    private readonly brokenLinks: BrokenLinkCache,
  ) {
    this.storeSubscription = store.onDidChange(() => {
      this._onDidChangeTreeData.fire(undefined);
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
    return buildFavoriteTreeItem(
      node.favorite,
      this.brokenStateFor(node.favorite.path),
    );
  }

  getChildren(node?: ShelfNode): ShelfNode[] {
    if (node) {
      return [];
    }
    return this.store.favorites.map((favorite: Favorite) => ({
      kind: "favoritesEntry",
      favorite,
    }));
  }

  getParent(): ShelfNode | undefined {
    return undefined;
  }

  /** Convenience for the empty-state message. */
  isEmpty(): boolean {
    return this.store.favorites.length === 0;
  }

  dispose(): void {
    this.storeSubscription.dispose();
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
}
