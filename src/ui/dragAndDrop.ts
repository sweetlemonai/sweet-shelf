import * as vscode from "vscode";

import {
  AlreadyOnShelfError,
  type ShelfNode,
} from "../shelf/types";
import type { ShelfStore } from "../shelf/store";
import { logError, logWarn } from "../util/logger";

/** MIME type for in-tree drags of shelf items (categories, files, folders, entries). */
export const SHELF_DRAG_MIME = "application/vnd.code.tree.sweetShelf";
/** MIME type VS Code uses when the OS drags files into the editor. */
export const URI_LIST_MIME = "text/uri-list";

/** Which view a controller instance is bound to. Determines drop semantics. */
export type ViewKind = "library" | "favorites" | "recent";

/** Discriminated union packed into the internal drag payload. */
type DragItem = {
  kind: "category" | "file" | "folder" | "favoritesEntry";
  id: string;
};

/**
 * Drag-and-drop controller. One class, one instance per view.
 *
 * Drag is uniform across views: any draggable shelf node serializes
 * to the internal MIME with its kind + id. Inline-browsed entries
 * (folderEntry) emit `text/uri-list` so the existing OS-drop branch
 * can treat them as "add this URI to wherever you dropped it."
 *
 * Drop semantics depend on the *target* view, which is what
 * `viewKind` captures. VS Code routes a drop to the controller of
 * the view it landed on, so per-view routing is automatic.
 *
 * Library view drops:
 *   - Category onto category   → nest as last child
 *   - Category onto root area  → drop targets a category if present;
 *                                otherwise no-op (Library root is no
 *                                longer a drop target — that was the
 *                                old `section` model)
 *   - File/folder onto category → move to that category
 *   - File/folder onto root    → no-op
 *   - URI-list onto category    → add as file/folder
 *   - URI-list onto file/folder/entry → silent no-op
 *   - URI-list onto root        → friendly toast (drop on a category)
 *
 * Favorites view drops:
 *   - favoritesEntry onto favoritesEntry → reorder via moveFavoriteTo
 *   - file/folder dragged from Library  → favorite that ref
 *   - everything else → silent no-op
 *
 * Recent view: rejects all drops. Recent is auto-managed.
 *
 * Between-node insertion is not supported; users reorder favorites via
 * Move Up / Move Down and category siblings via the same.
 */
export class SweetShelfDragAndDropController
  implements vscode.TreeDragAndDropController<ShelfNode>
{
  readonly dragMimeTypes = [SHELF_DRAG_MIME, URI_LIST_MIME];
  readonly dropMimeTypes = [SHELF_DRAG_MIME, URI_LIST_MIME];

  constructor(
    private readonly viewKind: ViewKind,
    private readonly store: ShelfStore,
  ) {}

  handleDrag(
    source: readonly ShelfNode[],
    dataTransfer: vscode.DataTransfer,
  ): void {
    const shelfPayload: DragItem[] = [];
    const uris: string[] = [];

    for (const node of source) {
      switch (node.kind) {
        case "category":
          shelfPayload.push({ kind: "category", id: node.category.id });
          break;
        case "file":
          shelfPayload.push({ kind: "file", id: node.file.id });
          break;
        case "folder":
          shelfPayload.push({ kind: "folder", id: node.folder.id });
          break;
        case "favoritesEntry":
          shelfPayload.push({ kind: "favoritesEntry", id: node.favorite.id });
          break;
        case "folderEntry":
          // Inline-browsed entries become URI-list payloads. The
          // OS-drop branch handles "add to category" semantics,
          // including stat-based file-vs-folder dispatch and
          // duplicate detection.
          uris.push(node.uri.toString());
          break;
        case "recentEntry":
        case "folderEntryError":
        case "folderEntryOverflow":
        case "focusHeader":
          // Recent rows aren't user-reorderable; the rest aren't
          // draggable.
          break;
        default:
          assertNever(node);
      }
    }

    if (shelfPayload.length > 0) {
      dataTransfer.set(
        SHELF_DRAG_MIME,
        new vscode.DataTransferItem(JSON.stringify({ items: shelfPayload })),
      );
    }
    if (uris.length > 0) {
      dataTransfer.set(
        URI_LIST_MIME,
        new vscode.DataTransferItem(uris.join("\r\n")),
      );
    }
  }

  async handleDrop(
    target: ShelfNode | undefined,
    dataTransfer: vscode.DataTransfer,
  ): Promise<void> {
    if (this.viewKind === "recent") {
      // Recent accepts no drops.
      return;
    }
    try {
      const internal = dataTransfer.get(SHELF_DRAG_MIME);
      if (internal) {
        const items = decodeInternalPayload(await internal.asString());
        if (items.length > 0) {
          this.handleInternalDrop(target, items);
          return;
        }
      }
      const uriList = dataTransfer.get(URI_LIST_MIME);
      if (uriList) {
        await this.handleOsDrop(target, await uriList.asString());
      }
    } catch (err) {
      logError("handleDrop", err);
    }
  }

  /* ────────────────── Internal drop ────────────────── */

  private handleInternalDrop(
    target: ShelfNode | undefined,
    items: readonly DragItem[],
  ): void {
    if (this.viewKind === "library") {
      this.handleLibraryInternalDrop(target, items);
    } else if (this.viewKind === "favorites") {
      this.handleFavoritesInternalDrop(target, items);
    }
  }

  private handleLibraryInternalDrop(
    target: ShelfNode | undefined,
    items: readonly DragItem[],
  ): void {
    if (!target) {
      // Library root no longer exists as a drop target now that
      // sections are gone. To move a category to the root, drag it
      // out of its parent — VS Code's tree expansion plus drop-onto-
      // category semantics covers that without root drops.
      return;
    }
    for (const item of items) {
      switch (item.kind) {
        case "category": {
          const dest = resolveCategoryDestination(target);
          if (!dest) {
            return;
          }
          this.store.moveCategory(
            item.id,
            dest.parentId,
            Number.MAX_SAFE_INTEGER,
          );
          break;
        }
        case "file":
        case "folder": {
          const dest = resolveRefDestination(target);
          if (!dest) {
            return;
          }
          if (item.kind === "file") {
            this.store.moveFile(
              item.id,
              dest.parentCategoryId,
              Number.MAX_SAFE_INTEGER,
            );
          } else {
            this.store.moveFolder(
              item.id,
              dest.parentCategoryId,
              Number.MAX_SAFE_INTEGER,
            );
          }
          break;
        }
        case "favoritesEntry":
          // Dragging a favorites entry into Library has no clear
          // intent — the underlying ref is already in Library.
          // Reject silently.
          break;
        default:
          assertNever(item.kind);
      }
    }
  }

  private handleFavoritesInternalDrop(
    target: ShelfNode | undefined,
    items: readonly DragItem[],
  ): void {
    for (const item of items) {
      switch (item.kind) {
        case "favoritesEntry": {
          // Reorder within Favorites. Drop on another favorite =
          // insert before; drop on the view's empty area
          // (target undefined) = append.
          if (target && target.kind === "favoritesEntry") {
            const targetIdx = this.store.favorites.findIndex(
              (f) => f.id === target.favorite.id,
            );
            if (targetIdx >= 0) {
              this.store.moveFavoriteTo(item.id, targetIdx);
            }
          } else {
            this.store.moveFavoriteTo(item.id, Number.MAX_SAFE_INTEGER);
          }
          break;
        }
        case "file":
        case "folder": {
          // Dragging a Library file/folder into Favorites adds its
          // path. The store is path-based now and dedupes on path.
          const ref =
            item.kind === "file"
              ? this.store.findFile(item.id)
              : this.store.findFolder(item.id);
          if (ref) {
            this.store.addFavorite(ref.path, item.kind);
          }
          break;
        }
        case "category":
          // Categories aren't favoritable.
          break;
        default:
          assertNever(item.kind);
      }
    }
  }

  /* ────────────────── OS / URI-list drop ────────────────── */

  private async handleOsDrop(
    target: ShelfNode | undefined,
    raw: string,
  ): Promise<void> {
    if (this.viewKind !== "library") {
      // Favorites doesn't accept OS drops — there's no category
      // to add to. Silent reject.
      return;
    }
    const uris = parseUriList(raw);
    if (uris.length === 0) {
      return;
    }
    if (!target) {
      void vscode.window.showInformationMessage(
        "Drop files onto a category to add them to your shelf.",
      );
      return;
    }
    if (
      target.kind === "file" ||
      target.kind === "folder" ||
      target.kind === "favoritesEntry" ||
      target.kind === "recentEntry" ||
      target.kind === "folderEntry" ||
      target.kind === "folderEntryError" ||
      target.kind === "folderEntryOverflow" ||
      target.kind === "focusHeader"
    ) {
      // Files/folders/entries/inline-browsed/focus-header don't accept drops.
      return;
    }
    if (target.kind !== "category") {
      return;
    }

    const categoryId = target.category.id;
    let added = 0;
    let alreadyOnShelf = 0;
    let missing = 0;
    let errors = 0;

    for (const uri of uris) {
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if ((stat.type & vscode.FileType.Directory) !== 0) {
          this.store.addFolder(categoryId, uri.fsPath);
          added += 1;
        } else if ((stat.type & vscode.FileType.File) !== 0) {
          this.store.addFile(categoryId, uri.fsPath);
          added += 1;
        } else {
          missing += 1;
          logWarn(`OS drop: skipping unsupported file type at ${uri.fsPath}`);
        }
      } catch (err) {
        if (err instanceof AlreadyOnShelfError) {
          alreadyOnShelf += 1;
          continue;
        }
        if (isNotFoundError(err)) {
          missing += 1;
          logWarn(`OS drop: path no longer exists: ${uri.fsPath}`);
          continue;
        }
        errors += 1;
        logError(`OS drop: ${uri.fsPath}`, err);
      }
    }

    surfaceOsDropSummary({ added, alreadyOnShelf, missing, errors });
  }
}

/* ────────────────── Destination resolution ────────────────── */

interface CategoryDestination {
  /** `null` means top-level (Library root). */
  parentId: string | null;
}

function resolveCategoryDestination(
  target: ShelfNode,
): CategoryDestination | null {
  switch (target.kind) {
    case "category":
      return { parentId: target.category.id };
    case "focusHeader":
      // Drop a category onto the focus header → put it inside the
      // focused item if that's a category. (If focused on a folder,
      // categories can't go inside; reject.)
      return target.itemKind === "category"
        ? { parentId: target.itemId }
        : null;
    case "file":
    case "folder":
    case "favoritesEntry":
    case "recentEntry":
    case "folderEntry":
    case "folderEntryError":
    case "folderEntryOverflow":
      return null;
    default:
      return assertNever(target);
  }
}

interface RefDestination {
  parentCategoryId: string;
}

function resolveRefDestination(target: ShelfNode): RefDestination | null {
  if (target.kind === "category") {
    return { parentCategoryId: target.category.id };
  }
  if (target.kind === "focusHeader" && target.itemKind === "category") {
    return { parentCategoryId: target.itemId };
  }
  return null;
}

/* ────────────────── Decoding helpers ────────────────── */

function decodeInternalPayload(raw: string): DragItem[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      Array.isArray((parsed as { items?: unknown }).items)
    ) {
      const arr = (parsed as { items: unknown[] }).items;
      return arr.flatMap((v): DragItem[] => {
        if (typeof v !== "object" || v === null) {
          return [];
        }
        const obj = v as Record<string, unknown>;
        if (typeof obj.id !== "string") {
          return [];
        }
        switch (obj.kind) {
          case "category":
          case "file":
          case "folder":
          case "favoritesEntry":
            return [{ kind: obj.kind, id: obj.id }];
          default:
            return [];
        }
      });
    }
  } catch {
    // Fall through.
  }
  return [];
}

function parseUriList(raw: string): vscode.Uri[] {
  const out: vscode.Uri[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    try {
      out.push(vscode.Uri.parse(trimmed, true));
    } catch {
      // Ignore unparseable lines.
    }
  }
  return out;
}

function isNotFoundError(err: unknown): boolean {
  if (err instanceof vscode.FileSystemError) {
    return err.code === "FileNotFound" || err.code === "EntryNotFound";
  }
  return false;
}

interface OsDropSummary {
  added: number;
  alreadyOnShelf: number;
  missing: number;
  errors: number;
}

function surfaceOsDropSummary(s: OsDropSummary): void {
  if (s.added === 0 && s.alreadyOnShelf === 0 && s.missing === 0 && s.errors === 0) {
    return;
  }
  const parts: string[] = [];
  if (s.added > 0) {
    parts.push(`Added ${s.added} ${s.added === 1 ? "item" : "items"}.`);
  }
  if (s.alreadyOnShelf > 0) {
    parts.push(`Skipped ${s.alreadyOnShelf} already on your shelf.`);
  }
  if (s.missing > 0) {
    parts.push(
      `Skipped ${s.missing} that ${s.missing === 1 ? "isn't" : "aren't"} accessible.`,
    );
  }
  if (s.errors > 0) {
    parts.push(
      `Hit ${s.errors} error${s.errors === 1 ? "" : "s"} (see Sweet Shelf output).`,
    );
  }
  void vscode.window.showInformationMessage(`Sweet Shelf: ${parts.join(" ")}`);
}

function assertNever(value: never): never {
  throw new Error(`Unexpected variant: ${JSON.stringify(value)}`);
}
