import * as vscode from "vscode";

import { canonicalizePath, pathsEqual } from "./paths";
import { logError, logWarn } from "../util/logger";

/**
 * Lazy-stat cache for broken-link detection.
 *
 * The decoration provider and the tree provider both query
 * `isBroken(path)` on every render. If the path isn't in the cache
 * yet, they call `scheduleCheck(path)` (fire-and-forget) and render
 * "not broken" by default. When the stat resolves, the cache fires
 * `onDidUpdate(uri)` and listeners refresh.
 *
 * No background timer; no full pre-warm at activation. The
 * `validatePaths` command is the explicit revalidation path.
 *
 * Path keys are canonicalized to dedupe the "two ways to spell the
 * same on-disk path" cases that Windows/macOS pose. We treat the
 * cache key as opaque — callers pass either canonical or raw paths,
 * we canonicalize internally.
 */
export class BrokenLinkCache implements vscode.Disposable {
  private readonly entries = new Map<string, boolean>();
  private readonly inFlight = new Set<string>();

  private readonly _onDidUpdate = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidUpdate: vscode.Event<vscode.Uri> = this._onDidUpdate.event;

  /**
   * Returns whether a path is known broken. `undefined` means the
   * stat hasn't run (or completed) yet — caller should schedule.
   */
  isBroken(path: string): boolean | undefined {
    return this.entries.get(this.key(path));
  }

  /**
   * Mark a path as known-good without statting. Used by `addFile` /
   * `addFolder` / rename / locateAgain, where the caller has just
   * touched the disk and knows the path resolves.
   */
  markAsExisting(path: string): void {
    const key = this.key(path);
    if (this.entries.get(key) === false) {
      return;
    }
    this.entries.set(key, false);
    this._onDidUpdate.fire(vscode.Uri.file(path));
  }

  /**
   * Schedule an async stat. Dedupes against in-flight checks for the
   * same path. Fires `onDidUpdate` on completion.
   */
  scheduleCheck(path: string): void {
    const key = this.key(path);
    if (this.inFlight.has(key)) {
      return;
    }
    this.inFlight.add(key);
    void this.runCheck(key, path);
  }

  /** Drop a path's entry (next ask will re-stat). */
  invalidate(path: string): void {
    this.entries.delete(this.key(path));
  }

  /** Clear the entire cache. Used by Validate Paths. */
  invalidateAll(): void {
    this.entries.clear();
  }

  /** Cached entry count, for output-channel diagnostics. */
  size(): number {
    return this.entries.size;
  }

  /**
   * Run a stat, populate the cache, fire the update. Errors that
   * aren't FileNotFound are *not* treated as "broken" — they could
   * be transient (offline drive, permission flicker), and marking
   * them broken would surface false positives. Logged for ops.
   */
  private async runCheck(key: string, path: string): Promise<void> {
    let broken: boolean;
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(path));
      broken = false;
    } catch (err) {
      if (err instanceof vscode.FileSystemError) {
        if (err.code === "FileNotFound" || err.code === "EntryNotFound") {
          broken = true;
        } else {
          logWarn(`Path stat returned ${err.code} for ${path}; not marked broken.`);
          this.inFlight.delete(key);
          return;
        }
      } else {
        logError(`stat ${path}`, err);
        this.inFlight.delete(key);
        return;
      }
    }
    this.entries.set(key, broken);
    this.inFlight.delete(key);
    this._onDidUpdate.fire(vscode.Uri.file(path));
  }

  private key(path: string): string {
    const canonical = canonicalizePath(path);
    if (process.platform === "win32" || process.platform === "darwin") {
      return canonical.toLowerCase();
    }
    return canonical;
  }

  dispose(): void {
    this._onDidUpdate.dispose();
  }
}

/** True iff `a` and `b` resolve to the same path on this filesystem. */
export function isSamePath(a: string, b: string): boolean {
  return pathsEqual(a, b);
}
