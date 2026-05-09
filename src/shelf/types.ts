/**
 * Core types for Sweet Shelf.
 *
 * `ShelfNode` is the discriminated union the tree provider walks. New
 * variants land here as later tasks add features. Always switch on
 * `node.kind` so adding a variant surfaces as a missing case at compile
 * time rather than silently falling through.
 */

/** Identifier for a top-level section in the sidebar. */
export type SectionId = "library" | "favorites" | "recent";

/** All section ids in their canonical default order. */
export const ALL_SECTION_IDS: readonly SectionId[] = [
  "library",
  "favorites",
  "recent",
] as const;

/** Human-readable labels for each section. */
export const SECTION_LABELS: Readonly<Record<SectionId, string>> = {
  library: "Library",
  favorites: "Favorites",
  recent: "Recent",
};

/** Maximum allowed length for a category label, enforced at input + load time. */
export const MAX_CATEGORY_LABEL_LENGTH = 100;

/** Hard cap on category nesting depth (sanity guard, not a UX limit). */
export const MAX_CATEGORY_DEPTH = 20;

import type { ColorLabel } from "./color";
export type { ColorLabel };

/**
 * A reference to a file on disk. Sweet Shelf never owns the file —
 * `path` is the absolute on-disk path; `label` is the basename
 * (kept in sync if the path changes); `alias` is an optional user-
 * provided display name that takes priority when present.
 *
 * Display name resolution: `alias ?? label`. Aliases suppress the
 * automatic context disambiguator — once the user has chosen a name,
 * we don't re-disambiguate it.
 */
export interface FileRef {
  id: string;
  kind: "file";
  /** Absolute, normalized on-disk path. */
  path: string;
  /** Basename of `path`. Kept in sync with the file on disk via rename-on-disk. */
  label: string;
  /** User-provided display name. When set, wins over `label`. */
  alias?: string;
  /** Optional color tint; absence means "no color." */
  colorLabel?: ColorLabel;
  createdAt: string;
  updatedAt: string;
  /** ISO timestamp of the most recent open via the shelf, if any. */
  lastOpenedAt?: string;
  /** ISO timestamp set when the user adds the ref to Favorites; presence === favorited. */
  favoritedAt?: string;
}

/**
 * A reference to a folder on disk. Same alias semantics as `FileRef`.
 */
export interface FolderRef {
  id: string;
  kind: "folder";
  /** Absolute, normalized on-disk path. */
  path: string;
  /** Basename of `path`. */
  label: string;
  /** User-provided display name. When set, wins over `label`. */
  alias?: string;
  /** Optional color tint; absence means "no color." */
  colorLabel?: ColorLabel;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt?: string;
  /** ISO timestamp set when the user adds the ref to Favorites; presence === favorited. */
  favoritedAt?: string;
}

/**
 * Anything that can live inside a category. The order of children in
 * `Category.children` is preserved as-is — sorting is the user's job
 * via reorder commands and drag-and-drop.
 */
export type CategoryChild = Category | FileRef | FolderRef;

/**
 * A user-named container for organizing items on the shelf. Categories
 * are the only kind that nests; files and folders are always leaves at
 * the data-model level (Task 4 adds inline rendering of folder contents
 * but those stay outside the persisted tree).
 */
export interface Category {
  id: string;
  kind: "category";
  label: string;
  children: CategoryChild[];
  /** Optional color tint applied to the folder icon in the tree. */
  colorLabel?: ColorLabel;
  createdAt: string;
  updatedAt: string;
}

/**
 * A node in the Sweet Shelf tree.
 *
 * Files and folders always have a parent category — they cannot live at
 * a section root. `parentId` is required and is the category id.
 *
 * `folderEntry`, `folderEntryError`, and `folderEntryOverflow` are
 * purely view state for inline folder browsing (Task 4). They are
 * recomputed from disk on every expansion, never persisted, never
 * carry an ID, and never enter the store. The schema validator's
 * "unknown child kind" error backstops accidental persistence.
 *
 * Provider code switches on `node.kind` so missing cases are flagged by
 * the compiler.
 */
import type * as vscode from "vscode";

export type ShelfNode =
  | { kind: "section"; id: SectionId; label: string }
  | { kind: "empty"; parentSectionId: SectionId; message: string }
  | {
      kind: "category";
      category: Category;
      /** `null` means this category lives at the Library root. */
      parentId: string | null;
    }
  | { kind: "file"; file: FileRef; parentId: string }
  | { kind: "folder"; folder: FolderRef; parentId: string }
  | {
      /**
       * Surfaces a Library file or folder ref in the Favorites
       * section. Never persisted — the Favorites section is a
       * derived view ordered by `ShelfConfig.favoritesOrder`.
       */
      kind: "favoritesEntry";
      ref: FileRef | FolderRef;
    }
  | {
      /**
       * Surfaces a Library file or folder ref in the Recent section.
       * Never persisted — Recent is computed by sorting refs that
       * have `lastOpenedAt` set, descending.
       */
      kind: "recentEntry";
      ref: FileRef | FolderRef;
    }
  | {
      /**
       * A live entry inside an inline-browsed folder. Symlinks are
       * always rendered with `isDirectory: false` regardless of their
       * target type; this sidesteps loops and presents symlinks as
       * opaque leaves.
       */
      kind: "folderEntry";
      uri: vscode.Uri;
      isDirectory: boolean;
      isSymlink: boolean;
      /** Directory containing this entry. */
      parentUri: vscode.Uri;
    }
  | {
      /** Placeholder shown when readDirectory fails (permissions, missing). */
      kind: "folderEntryError";
      parentUri: vscode.Uri;
      message: string;
    }
  | {
      /** Placeholder shown when a directory exceeds the soft render cap. */
      kind: "folderEntryOverflow";
      parentUri: vscode.Uri;
      hiddenCount: number;
    }
  | {
      /**
       * The "Focus: <name>" header rendered at root in Focus Mode.
       * Click exits focus. Never persisted — derived from
       * `ShelfConfig.focusedItemId` and resolved against the current
       * library state on every render.
       */
      kind: "focusHeader";
      label: string;
      itemKind: "category" | "folder";
      itemId: string;
    };

/**
 * The persisted shape of the shelf. Bumped via `version` whenever the
 * schema changes incompatibly so future migrations can branch on it.
 *
 * Tasks 3 and 6 stayed at `version: 1`: each added optional fields
 * and one new array (`favoritesOrder` in Task 6), all additive — Task
 * 1 and 2 files remain valid.
 *
 * Favorites and Recent are derived views, not separate storage. The
 * `favorites` and `recent` arrays remain `never[]` to make accidental
 * persistence impossible. `favoritesOrder` carries only the user-
 * controllable order of favorited refs (which themselves live in
 * `library`).
 */
export interface ShelfConfig {
  version: 1;
  sectionOrder: SectionId[];
  /**
   * IDs of favorited file/folder refs, in display order. Each ID
   * corresponds to a ref somewhere in `library` whose `favoritedAt`
   * is set. Cleaned at render time if any IDs no longer resolve.
   */
  favoritesOrder: string[];
  /**
   * ID of the currently focused category or folder ref, or `null`
   * for normal mode. When set, the sidebar transforms into Focus
   * Mode: sections disappear, only the focused item's contents
   * render, and a "Focus: <name>" header is shown at root. Files
   * are not focusable. Persists across reloads.
   */
  focusedItemId: string | null;
  library: Category[];
  favorites: never[];
  recent: never[];
}

/** The default shelf state used when no config exists or the file is invalid. */
export const DEFAULT_SHELF_CONFIG: ShelfConfig = {
  version: 1,
  sectionOrder: ["library", "favorites", "recent"],
  favoritesOrder: [],
  focusedItemId: null,
  library: [],
  favorites: [],
  recent: [],
};

/**
 * Thrown by `ShelfStore.addFile`/`addFolder` when the path is already on
 * the shelf. Carries the existing reference and its parent category's
 * label so the caller (single add or OS-drop loop) can surface a
 * targeted toast without re-walking the tree.
 */
export class AlreadyOnShelfError extends Error {
  readonly ref: FileRef | FolderRef;
  readonly parentLabel: string;

  constructor(ref: FileRef | FolderRef, parentLabel: string) {
    super(
      `This ${ref.kind} is already on your shelf in "${parentLabel}".`,
    );
    this.name = "AlreadyOnShelfError";
    this.ref = ref;
    this.parentLabel = parentLabel;
  }
}
