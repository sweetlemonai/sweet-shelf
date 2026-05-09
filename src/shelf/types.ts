/**
 * Core types for Sweet Shelf.
 *
 * `ShelfNode` is the discriminated union the tree providers walk. New
 * variants land here as later tasks add features. Always switch on
 * `node.kind` so adding a variant surfaces as a missing case at compile
 * time rather than silently falling through.
 */

import type * as vscode from "vscode";
import type { ColorLabel } from "./color";
export type { ColorLabel };

/** Maximum allowed length for a category label, enforced at input + load time. */
export const MAX_CATEGORY_LABEL_LENGTH = 100;

/** Hard cap on category nesting depth (sanity guard, not a UX limit). */
export const MAX_CATEGORY_DEPTH = 20;

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
 * the data-model level (Task 4 added inline rendering of folder
 * contents but those stay outside the persisted tree).
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
 * Three view-only inline-browse variants (`folderEntry`,
 * `folderEntryError`, `folderEntryOverflow`) plus `focusHeader` are
 * recomputed on every render and never persisted. The schema
 * validator's "unknown child kind" error backstops accidental
 * persistence.
 *
 * Library, Favorites, and Recent are now separate VS Code views (Task
 * 12), so there's no `section` variant — each view's tree is rooted
 * at its content directly. Empty-state copy is rendered via
 * `TreeView.message`, not as a fake leaf node.
 *
 * Provider code switches on `node.kind` so missing cases are flagged
 * by the compiler.
 */
export type ShelfNode =
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
       * Surfaces a Library file or folder ref in the Favorites view.
       * Never persisted — Favorites is a derived view ordered by
       * `ShelfConfig.favoritesOrder`.
       */
      kind: "favoritesEntry";
      ref: FileRef | FolderRef;
    }
  | {
      /**
       * Surfaces a Library file or folder ref in the Recent view.
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
       * The "Focus: <name>" header rendered at root of the Library
       * view in Focus Mode. Click exits focus. Derived from
       * `ShelfConfig.focusedItemId` on every render.
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
 * Favorites and Recent are derived views, not separate storage. The
 * `favorites` and `recent` arrays remain `never[]` to make accidental
 * persistence impossible. `favoritesOrder` carries the user-
 * controllable order of favorited refs (which themselves live in
 * `library`).
 */
export interface ShelfConfig {
  version: 1;
  /**
   * IDs of favorited file/folder refs, in display order. Each ID
   * corresponds to a ref somewhere in `library` whose `favoritedAt`
   * is set. Cleaned at render time if any IDs no longer resolve.
   */
  favoritesOrder: string[];
  /**
   * ID of the currently focused category or folder ref, or `null`
   * for normal mode. When set, the Library view shows a focus header
   * + the focused subtree, and the Favorites and Recent views hide
   * via `when` clauses on the `sweetShelf.focused` context key.
   */
  focusedItemId: string | null;
  library: Category[];
  favorites: never[];
  recent: never[];
}

/** The default shelf state used when no config exists or the file is invalid. */
export const DEFAULT_SHELF_CONFIG: ShelfConfig = {
  version: 1,
  favoritesOrder: [],
  focusedItemId: null,
  library: [],
  favorites: [],
  recent: [],
};

/**
 * Thrown by `ShelfStore.addFile` / `addFolder` / `addAndFavoriteFile`
 * / `addAndFavoriteFolder` when the path is already on the shelf.
 * Carries the existing reference and its parent category's label so
 * the caller (single add, OS-drop loop, "Add to Favorites" flow) can
 * surface a targeted message without re-walking the tree.
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
