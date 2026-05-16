import * as vscode from "vscode";

import {
  mutedThemeColorIdFor,
  themeColorIdFor,
  type ColorLabel,
} from "../shelf/color";
import { walkAll } from "../shelf/categories";
import { isDescendantPath, pathsEqual } from "../shelf/paths";
import type { BrokenLinkCache } from "../shelf/brokenLinks";
import type { ShelfStore } from "../shelf/store";

/**
 * Decoration provider for shelf-managed URIs.
 *
 * Composes three signals per URI in a single pass over the library:
 *   - `broken` (from the broken-link cache)
 *   - `colorLabel` (from the matching ref)
 *   - `favorited` (from `store.isFavoritedPath`)
 *
 * Priority per the Task 7 carry-forward: broken wins. A broken ref
 * shows a muted ⚠ and suppresses the star and the color. A non-broken
 * ref shows the favorite star (if favorited) tinted by the color
 * label (or `charts.yellow` as the default favorite color when no
 * label is set, preserving Task 6 behavior).
 *
 * Categories don't have URIs, so they don't reach this provider —
 * their color tint is applied via `ThemeIcon` in the tree provider.
 */
export class SweetShelfDecorationProvider
  implements vscode.FileDecorationProvider, vscode.Disposable
{
  private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<
    vscode.Uri | vscode.Uri[] | undefined
  >();
  readonly onDidChangeFileDecorations: vscode.Event<
    vscode.Uri | vscode.Uri[] | undefined
  > = this._onDidChangeFileDecorations.event;

  private readonly storeSubscription: vscode.Disposable;
  private readonly cacheSubscription: vscode.Disposable;

  constructor(
    private readonly store: ShelfStore,
    private readonly brokenLinks: BrokenLinkCache,
  ) {
    // Refresh-all on shelf mutations: any of favorited, color, or
    // path could have changed. Visible-item set is small in practice.
    this.storeSubscription = store.onDidChange(() => {
      this._onDidChangeFileDecorations.fire(undefined);
    });
    // Per-URI refresh when a stat resolves — minimal flicker.
    this.cacheSubscription = brokenLinks.onDidUpdate((uri) => {
      this._onDidChangeFileDecorations.fire(uri);
    });
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== "file") {
      return undefined;
    }
    const signals = this.gatherSignals(uri.fsPath);
    if (!signals) {
      return undefined;
    }
    if (signals.broken) {
      return {
        badge: "⚠",
        tooltip: "This item is missing.",
        color: new vscode.ThemeColor("disabledForeground"),
      };
    }
    if (
      !signals.favorited &&
      signals.colorLabel === undefined &&
      signals.inheritedColorLabel === undefined
    ) {
      return undefined;
    }
    const decoration: vscode.FileDecoration = {};
    if (signals.favorited) {
      decoration.badge = "★";
      decoration.tooltip = "Favorite";
    }
    const colorId = colorIdFor(signals);
    if (colorId !== null) {
      decoration.color = new vscode.ThemeColor(colorId);
    }
    return decoration;
  }

  /**
   * Single library walk per URI: collects the matching ref's
   * favorited / color signals plus the cached broken state. Schedules
   * a stat when the cache hasn't seen this path yet so the decoration
   * gets a follow-up render once the result is known.
   *
   * Returns `undefined` when the URI doesn't match any shelf ref —
   * the decoration provider sees URIs from across the workbench, so
   * the unmatched case is the common one.
   */
  private gatherSignals(path: string): Signals | undefined {
    const favorited = this.store.isFavoritedPath(path);
    let colorLabel: ColorLabel | undefined;
    let matched = favorited;
    let inheritedColorLabel: ColorLabel | undefined;
    let inheritedAncestorLen = -1;
    for (const node of walkAll(this.store.library)) {
      if (node.kind === "category") {
        continue;
      }
      if (pathsEqual(node.path, path)) {
        matched = true;
        if (node.colorLabel !== undefined) {
          colorLabel = node.colorLabel;
        }
        continue;
      }
      // Cascade: a folder ref higher up the tree colors its
      // descendants with a muted variant so the whole subtree reads
      // as belonging to that bucket. Closest (longest path) wins so
      // nested colored folders override their ancestors.
      if (
        node.kind === "folder" &&
        node.colorLabel !== undefined &&
        isDescendantPath(path, node.path) &&
        node.path.length > inheritedAncestorLen
      ) {
        inheritedColorLabel = node.colorLabel;
        inheritedAncestorLen = node.path.length;
      }
    }
    if (!matched && inheritedColorLabel === undefined) {
      return undefined;
    }

    const cached = this.brokenLinks.isBroken(path);
    if (cached === undefined) {
      this.brokenLinks.scheduleCheck(path);
    }
    const signals: Signals = {
      broken: cached === true,
      favorited,
    };
    if (colorLabel !== undefined) {
      signals.colorLabel = colorLabel;
    }
    if (inheritedColorLabel !== undefined) {
      signals.inheritedColorLabel = inheritedColorLabel;
    }
    return signals;
  }

  dispose(): void {
    this.storeSubscription.dispose();
    this.cacheSubscription.dispose();
    this._onDidChangeFileDecorations.dispose();
  }
}

interface Signals {
  broken: boolean;
  favorited: boolean;
  colorLabel?: ColorLabel;
  /** Color inherited from an ancestor shelved folder, if any. */
  inheritedColorLabel?: ColorLabel;
}

/**
 * Resolve the theme color id for the composed decoration. Priority:
 * own color label > inherited (muted) ancestor color > favorited
 * fallback. Plain unfavorited and uncolored refs return `null`.
 */
function colorIdFor(signals: Signals): string | null {
  if (signals.colorLabel !== undefined) {
    return themeColorIdFor(signals.colorLabel);
  }
  if (signals.inheritedColorLabel !== undefined) {
    return mutedThemeColorIdFor(signals.inheritedColorLabel);
  }
  if (signals.favorited) {
    return "sweetShelf.color.yellow";
  }
  return null;
}
