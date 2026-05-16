import { walkAll } from "./categories";
import type {
  Category,
  CategoryChild,
  FileRef,
  FolderRef,
  ShelfConfig,
} from "./types";

/**
 * Pure helpers for export and import.
 *
 * `buildExport` produces a fresh `ShelfConfig` deep-cloned from the
 * live state, with optional scrubbing for the structure-only mode.
 * `summarizeImport` counts what's in an imported config so the
 * confirmation modal can show "X categories, Y files, Z folders."
 *
 * "Structure" mode keeps the user's organization (categories, refs,
 * aliases, colors, favorited status, focus, ordering) but resets all
 * timestamps to the export time and strips `lastOpenedAt` entirely.
 * The fact that someone favorited a file is structural; the fact
 * that they opened it on a particular Tuesday is not.
 *
 * "Everything" mode is a faithful deep clone — useful for true
 * machine-to-machine migration where the user wants their full state.
 */

export type ExportMode = "structure" | "everything";

export function buildExport(
  config: ShelfConfig,
  mode: ExportMode,
  exportTimestamp: string,
): ShelfConfig {
  if (mode === "everything") {
    // JSON round-trip is a sufficient deep-clone for our types
    // (no Dates, no functions, optional fields drop cleanly).
    return JSON.parse(JSON.stringify(config)) as ShelfConfig;
  }
  return {
    version: config.version,
    favorites: config.favorites.map((fav) => ({
      ...fav,
      favoritedAt: exportTimestamp,
    })),
    focusedItemId: config.focusedItemId,
    library: config.library.map((c) => scrubCategory(c, exportTimestamp)),
    recent: [],
  };
}

function scrubCategory(category: Category, ts: string): Category {
  const out: Category = {
    id: category.id,
    kind: "category",
    label: category.label,
    children: category.children.map((child) => scrubChild(child, ts)),
    createdAt: ts,
    updatedAt: ts,
  };
  if (category.colorLabel !== undefined) {
    out.colorLabel = category.colorLabel;
  }
  return out;
}

function scrubChild(child: CategoryChild, ts: string): CategoryChild {
  if (child.kind === "category") {
    return scrubCategory(child, ts);
  }
  return scrubRef(child, ts);
}

function scrubRef(ref: FileRef | FolderRef, ts: string): FileRef | FolderRef {
  // Build the common base. `lastOpenedAt` is intentionally never
  // copied — it's pure usage telemetry.
  const base = {
    id: ref.id,
    path: ref.path,
    label: ref.label,
    createdAt: ts,
    updatedAt: ts,
  };
  if (ref.kind === "file") {
    const out: FileRef = { ...base, kind: "file" };
    if (ref.alias !== undefined) {
      out.alias = ref.alias;
    }
    if (ref.colorLabel !== undefined) {
      out.colorLabel = ref.colorLabel;
    }
    return out;
  }
  const out: FolderRef = { ...base, kind: "folder" };
  if (ref.alias !== undefined) {
    out.alias = ref.alias;
  }
  if (ref.colorLabel !== undefined) {
    out.colorLabel = ref.colorLabel;
  }
  return out;
}

/** Per-kind counts shown in the import-confirmation modal. */
export interface ImportSummary {
  categories: number;
  files: number;
  folders: number;
  /** Favorites resolvable against the imported library (orphans excluded). */
  favorites: number;
}

export function summarizeImport(config: ShelfConfig): ImportSummary {
  const counts: ImportSummary = {
    categories: 0,
    files: 0,
    folders: 0,
    favorites: config.favorites.length,
  };
  for (const node of walkAll(config.library)) {
    switch (node.kind) {
      case "category":
        counts.categories += 1;
        break;
      case "file":
        counts.files += 1;
        break;
      case "folder":
        counts.folders += 1;
        break;
    }
  }
  return counts;
}
