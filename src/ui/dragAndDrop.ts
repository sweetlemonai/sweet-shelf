import * as vscode from "vscode";

import {
  ALL_SECTION_IDS,
  AlreadyOnShelfError,
  type SectionId,
  type ShelfNode,
} from "../shelf/types";
import type { ShelfStore } from "../shelf/store";
import { logError, logWarn } from "../util/logger";

/** MIME type for in-tree drags of shelf items (categories, files, folders). */
export const SHELF_DRAG_MIME = "application/vnd.code.tree.sweetShelf";
/** MIME type VS Code uses when the OS drags files into the editor. */
export const URI_LIST_MIME = "text/uri-list";

/** Discriminated union packed into the internal drag payload. */
type DragItem =
  | { kind: "category" | "file" | "folder" | "favoritesEntry"; id: string }
  | { kind: "section"; id: SectionId };

/**
 * Drag-and-drop controller for the Sweet Shelf tree.
 *
 * Source kinds:
 *   - shelf items (category/file/folder): packed into the internal
 *     `SHELF_DRAG_MIME` for moves between categories
 *   - inline-browsed folderEntry items: emitted as `text/uri-list` so
 *     the existing OS-drop branch handles them as "add to category"
 *
 * Drop semantics:
 *   - Category onto category   → nest as last child
 *   - Category onto Library    → move to Library root
 *   - Category onto Favorites/Recent → rejected
 *   - File/folder onto category → move there (last position)
 *   - File/folder onto section/file/folder → silently rejected
 *   - URI-list onto category → add each (skipping duplicates)
 *   - URI-list onto section → friendly toast
 *   - URI-list onto file/folder/folderEntry → silently rejected
 *   - Cycles → silently no-op
 *
 * Between-node insertion is not supported; users reorder shelf items
 * via Move Up / Move Down commands. (Decision recorded in Task 2.)
 */
export class SweetShelfDragAndDropController
  implements vscode.TreeDragAndDropController<ShelfNode>
{
  readonly dragMimeTypes = [SHELF_DRAG_MIME, URI_LIST_MIME];
  readonly dropMimeTypes = [SHELF_DRAG_MIME, URI_LIST_MIME];

  constructor(private readonly store: ShelfStore) {}

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
          shelfPayload.push({ kind: "favoritesEntry", id: node.ref.id });
          break;
        case "section":
          shelfPayload.push({ kind: "section", id: node.id });
          break;
        case "folderEntry":
          // Inline-browsed entries become URI-list payloads. The
          // existing OS-drop branch handles "add to category"
          // semantics, including stat-based file-vs-folder dispatch
          // and duplicate detection.
          uris.push(node.uri.toString());
          break;
        case "recentEntry":
        case "empty":
        case "folderEntryError":
        case "folderEntryOverflow":
        case "focusHeader":
          // Recent is auto-managed; the rest aren't draggable.
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
    if (!target) {
      return;
    }
    for (const item of items) {
      switch (item.kind) {
        case "category": {
          const dest = resolveCategoryDestination(target);
          if (!dest) {
            return;
          }
          this.store.moveCategory(item.id, dest.parentId, Number.MAX_SAFE_INTEGER);
          break;
        }
        case "file":
        case "folder": {
          const dest = resolveRefDestination(target);
          if (!dest) {
            return;
          }
          if (item.kind === "file") {
            this.store.moveFile(item.id, dest.parentCategoryId, Number.MAX_SAFE_INTEGER);
          } else {
            this.store.moveFolder(item.id, dest.parentCategoryId, Number.MAX_SAFE_INTEGER);
          }
          break;
        }
        case "favoritesEntry": {
          // Reorder within Favorites only. Drop on another favorite
          // ⇒ insert before; drop on the Favorites section ⇒ append.
          // Anything else is silently rejected.
          if (target.kind === "favoritesEntry") {
            const targetIdx = this.store.favoritesOrder.indexOf(target.ref.id);
            if (targetIdx >= 0) {
              this.store.moveFavoriteTo(item.id, targetIdx);
            }
          } else if (target.kind === "section" && target.id === "favorites") {
            this.store.moveFavoriteTo(item.id, Number.MAX_SAFE_INTEGER);
          }
          break;
        }
        case "section": {
          // Section drag is meaningless in Focus Mode — sections
          // aren't visible. Defensive against programmatic invocations
          // even though the UI can't trigger one.
          if (this.store.isFocused()) {
            break;
          }
          if (target.kind === "section") {
            this.reorderSections(item.id, target.id);
          }
          break;
        }
        default:
          assertNever(item);
      }
    }
  }

  /**
   * Apply "drop A onto B = A appears immediately before B" semantics
   * to the section order array. With three sections this rule is the
   * least surprising for adjacent moves and matches the brief's only
   * concrete example ("drag Favorites above Library").
   */
  private reorderSections(sourceId: SectionId, targetId: SectionId): void {
    if (sourceId === targetId) {
      return;
    }
    const order = [...this.store.sectionOrder];
    const sourceIdx = order.indexOf(sourceId);
    const targetIdx = order.indexOf(targetId);
    if (sourceIdx === -1 || targetIdx === -1) {
      return;
    }
    order.splice(sourceIdx, 1);
    const adjusted = sourceIdx < targetIdx ? targetIdx - 1 : targetIdx;
    order.splice(adjusted, 0, sourceId);
    // Sanity: only commit a permutation of the canonical set.
    if (
      order.length !== ALL_SECTION_IDS.length ||
      !ALL_SECTION_IDS.every((id) => order.includes(id))
    ) {
      return;
    }
    this.store.setSectionOrder(order);
  }

  /* ────────────────── OS / URI-list drop ────────────────── */

  private async handleOsDrop(
    target: ShelfNode | undefined,
    raw: string,
  ): Promise<void> {
    const uris = parseUriList(raw);
    if (uris.length === 0 || !target) {
      return;
    }
    if (target.kind === "section" || target.kind === "empty") {
      void vscode.window.showInformationMessage(
        "Drop files into a category to add them to your shelf.",
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
  /** `null` means Library root. */
  parentId: string | null;
}

function resolveCategoryDestination(
  target: ShelfNode,
): CategoryDestination | null {
  switch (target.kind) {
    case "section":
      return target.id === "library" ? { parentId: null } : null;
    case "empty":
      return target.parentSectionId === "library" ? { parentId: null } : null;
    case "category":
      return { parentId: target.category.id };
    case "file":
    case "folder":
    case "favoritesEntry":
    case "recentEntry":
    case "folderEntry":
    case "folderEntryError":
    case "folderEntryOverflow":
    case "focusHeader":
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
          case "section":
            if ((ALL_SECTION_IDS as readonly string[]).includes(obj.id)) {
              return [{ kind: "section", id: obj.id as SectionId }];
            }
            return [];
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
