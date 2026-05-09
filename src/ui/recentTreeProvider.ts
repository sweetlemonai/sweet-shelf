import * as vscode from "vscode";

import { buildEntryTreeItem } from "./treeItemBuilders";
import { buildRecentView, hasRecentEntries } from "../shelf/recent";
import type { BrokenLinkCache } from "../shelf/brokenLinks";
import type { ShelfNode } from "../shelf/types";
import type { ShelfStore } from "../shelf/store";

const DEFAULT_MAX_RECENT_ITEMS = 20;

const REFRESH_AFFECTING_SETTINGS: readonly string[] = [
  "sweetShelf.showFileExtensions",
  "sweetShelf.maxRecentItems",
];

/**
 * TreeDataProvider for the Recent view.
 *
 * No persisted order — recents are computed from `lastOpenedAt`,
 * sorted descending, capped at `sweetShelf.maxRecentItems`. Recent
 * is auto-managed: no drag, no manual reorder.
 *
 * Empty-state copy is rendered via `TreeView.message` (set externally
 * in `extension.ts`).
 */
export class RecentTreeProvider
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
      if (REFRESH_AFFECTING_SETTINGS.some((key) => e.affectsConfiguration(key))) {
        this._onDidChangeTreeData.fire(undefined);
      }
    });
    this.cacheSubscription = brokenLinks.onDidUpdate(() => {
      this._onDidChangeTreeData.fire(undefined);
    });
  }

  getTreeItem(node: ShelfNode): vscode.TreeItem {
    if (node.kind !== "recentEntry") {
      throw new Error(
        `RecentTreeProvider received unexpected node kind: ${node.kind}`,
      );
    }
    return buildEntryTreeItem(
      node.ref,
      "recentEntry",
      this.store.library,
      this.showFileExtensions(),
      /* includeFavoritedFlag */ true,
      this.brokenStateFor(node.ref.path),
    );
  }

  getChildren(node?: ShelfNode): ShelfNode[] {
    if (!node) {
      const max = this.maxRecentItems();
      const refs = buildRecentView(this.store.library, max);
      return refs.map((ref) => ({ kind: "recentEntry", ref }));
    }
    return [];
  }

  getParent(): ShelfNode | undefined {
    return undefined;
  }

  /** Whether Recent has anything to show right now. */
  isEmpty(): boolean {
    return !hasRecentEntries(this.store.library);
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

  private maxRecentItems(): number {
    const raw = vscode.workspace
      .getConfiguration("sweetShelf")
      .get<number>("maxRecentItems", DEFAULT_MAX_RECENT_ITEMS);
    if (!Number.isFinite(raw) || raw < 1) {
      return DEFAULT_MAX_RECENT_ITEMS;
    }
    return Math.min(100, Math.max(1, Math.floor(raw)));
  }
}
