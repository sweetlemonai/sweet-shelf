import {
  ALL_SECTION_IDS,
  DEFAULT_SHELF_CONFIG,
  MAX_CATEGORY_DEPTH,
  MAX_CATEGORY_LABEL_LENGTH,
  type Category,
  type CategoryChild,
  type FileRef,
  type FolderRef,
  type SectionId,
  type ShelfConfig,
} from "../shelf/types";
import { isColorLabel, type ColorLabel } from "../shelf/color";
import { forestDepth, walkAll } from "../shelf/categories";

/**
 * Result of validating a parsed JSON value against the shelf schema.
 *
 * `value` is always a usable `ShelfConfig`. Invalid inputs return defaults
 * with `ok: false` and an error message. `warnings` carries non-fatal
 * issues — currently just label truncation — that the caller surfaces in
 * the output channel + an aggregated toast.
 */
export type ValidationResult =
  | { ok: true; value: ShelfConfig; warnings: string[] }
  | { ok: false; value: ShelfConfig; error: string; warnings: string[] };

/**
 * Parse and validate a raw JSON string as a `ShelfConfig`. Returns
 * `{ ok: false }` with a human-readable error message if the string is
 * not valid JSON or the parsed shape doesn't match the schema. The
 * `value` field is always populated — invalid inputs fall back to
 * `DEFAULT_SHELF_CONFIG`.
 */
export function parseShelfConfig(raw: string): ValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return failure(`invalid JSON: ${message}`);
  }
  return validateShelfConfig(parsed);
}

/**
 * Validate an already-parsed value against the shelf schema. Exposed
 * separately so tests and migrations can validate in-memory objects
 * without round-tripping through JSON.
 */
export function validateShelfConfig(input: unknown): ValidationResult {
  const warnings: string[] = [];

  if (!isPlainObject(input)) {
    return failure("config root must be an object");
  }
  if (input.version !== 1) {
    return failure(`unsupported version: ${JSON.stringify(input.version)}`);
  }

  const order = input.sectionOrder;
  if (!Array.isArray(order) || !isValidSectionOrder(order)) {
    return failure(
      "sectionOrder must contain exactly the ids: library, favorites, recent",
    );
  }

  // favoritesOrder is optional in the on-disk schema (Task 1/2/3 files
  // predate it). Default to [] when missing; validate when present.
  const favoritesOrderRaw = (input as Record<string, unknown>).favoritesOrder;
  let favoritesOrder: string[] = [];
  if (favoritesOrderRaw !== undefined) {
    if (!Array.isArray(favoritesOrderRaw)) {
      return failure("favoritesOrder must be an array");
    }
    const seen = new Set<string>();
    for (const id of favoritesOrderRaw) {
      if (typeof id !== "string" || id.length === 0) {
        return failure("favoritesOrder entries must be non-empty strings");
      }
      if (seen.has(id)) {
        return failure(`favoritesOrder contains duplicate id: ${id}`);
      }
      seen.add(id);
    }
    favoritesOrder = favoritesOrderRaw as string[];
  }

  // focusedItemId is optional and may be null. When non-null it must
  // be a non-empty string. Resolution against the library happens at
  // render time so an orphaned id can be cleaned up gracefully.
  const focusedRaw = (input as Record<string, unknown>).focusedItemId;
  let focusedItemId: string | null = null;
  if (focusedRaw !== undefined && focusedRaw !== null) {
    if (typeof focusedRaw !== "string" || focusedRaw.length === 0) {
      return failure("focusedItemId must be a non-empty string or null");
    }
    focusedItemId = focusedRaw;
  }

  const libraryRaw = (input as Record<string, unknown>).library;
  if (!Array.isArray(libraryRaw)) {
    return failure("library must be an array");
  }
  const libraryResult = parseCategoryForest(libraryRaw, warnings);
  if (!libraryResult.ok) {
    return failure(libraryResult.error, warnings);
  }
  const library = libraryResult.value;

  // Cross-tree id uniqueness across all kinds.
  const seenIds = new Set<string>();
  for (const node of walkAll(library)) {
    if (seenIds.has(node.id)) {
      return failure(`duplicate id: ${node.id}`, warnings);
    }
    seenIds.add(node.id);
  }

  if (forestDepth(library) > MAX_CATEGORY_DEPTH) {
    return failure(
      `category nesting exceeds max depth (${MAX_CATEGORY_DEPTH})`,
      warnings,
    );
  }

  for (const key of ["favorites", "recent"] as const) {
    const section = (input as Record<string, unknown>)[key];
    if (!Array.isArray(section)) {
      return failure(`${key} must be an array`, warnings);
    }
    if (section.length !== 0) {
      // Task 3 doesn't store items in favorites or recent yet.
      return failure(`${key} must be empty in this version`, warnings);
    }
  }

  return {
    ok: true,
    value: {
      version: 1,
      sectionOrder: order,
      favoritesOrder,
      focusedItemId,
      library,
      favorites: [],
      recent: [],
    },
    warnings,
  };
}

/** Serialize a `ShelfConfig` to a stable, human-readable JSON string. */
export function serializeShelfConfig(config: ShelfConfig): string {
  return JSON.stringify(config, null, 2) + "\n";
}

/** Deep copy of the default shelf so callers can mutate freely. */
export function cloneDefault(): ShelfConfig {
  return {
    version: DEFAULT_SHELF_CONFIG.version,
    sectionOrder: [...DEFAULT_SHELF_CONFIG.sectionOrder],
    favoritesOrder: [...DEFAULT_SHELF_CONFIG.favoritesOrder],
    focusedItemId: DEFAULT_SHELF_CONFIG.focusedItemId,
    library: [],
    favorites: [],
    recent: [],
  };
}

/* ───────────────────────── Per-kind parsing ───────────────────────── */

type ForestParseResult =
  | { ok: true; value: Category[] }
  | { ok: false; error: string };

function parseCategoryForest(
  raw: unknown[],
  warnings: string[],
): ForestParseResult {
  const out: Category[] = [];
  for (const item of raw) {
    if (!isPlainObject(item) || item.kind !== "category") {
      return {
        ok: false,
        error: "library may only contain categories at the root",
      };
    }
    const result = parseCategory(item, warnings);
    if (!result.ok) {
      return result;
    }
    out.push(result.value);
  }
  return { ok: true, value: out };
}

type CategoryParseResult =
  | { ok: true; value: Category }
  | { ok: false; error: string };

function parseCategory(
  raw: Record<string, unknown>,
  warnings: string[],
): CategoryParseResult {
  if (typeof raw.id !== "string" || raw.id.length === 0) {
    return { ok: false, error: "category.id must be a non-empty string" };
  }
  const labelResult = parseLabel(raw.label, `category(${raw.id})`, warnings);
  if (!labelResult.ok) {
    return labelResult;
  }
  const timestamps = parseTimestamps(raw, `category(${raw.id})`);
  if (!timestamps.ok) {
    return timestamps;
  }

  const childrenRaw = raw.children;
  if (!Array.isArray(childrenRaw)) {
    return {
      ok: false,
      error: `category(${raw.id}).children must be an array`,
    };
  }
  const childrenResult = parseChildren(childrenRaw, warnings);
  if (!childrenResult.ok) {
    return childrenResult;
  }

  const cat: Category = {
    id: raw.id,
    kind: "category",
    label: labelResult.value,
    children: childrenResult.value,
    createdAt: timestamps.value.createdAt,
    updatedAt: timestamps.value.updatedAt,
  };
  attachColorLabel(cat, raw.colorLabel, `category(${raw.id})`, warnings);
  return { ok: true, value: cat };
}

type ChildrenParseResult =
  | { ok: true; value: CategoryChild[] }
  | { ok: false; error: string };

function parseChildren(
  raw: unknown[],
  warnings: string[],
): ChildrenParseResult {
  const out: CategoryChild[] = [];
  for (const item of raw) {
    if (!isPlainObject(item)) {
      return { ok: false, error: "category child must be an object" };
    }
    switch (item.kind) {
      case "category": {
        const result = parseCategory(item, warnings);
        if (!result.ok) {
          return result;
        }
        out.push(result.value);
        break;
      }
      case "file": {
        const result = parseFileRef(item, warnings);
        if (!result.ok) {
          return result;
        }
        out.push(result.value);
        break;
      }
      case "folder": {
        const result = parseFolderRef(item, warnings);
        if (!result.ok) {
          return result;
        }
        out.push(result.value);
        break;
      }
      default:
        return {
          ok: false,
          error: `unknown child kind: ${JSON.stringify(item.kind)}`,
        };
    }
  }
  return { ok: true, value: out };
}

type FileParseResult =
  | { ok: true; value: FileRef }
  | { ok: false; error: string };

function parseFileRef(
  raw: Record<string, unknown>,
  warnings: string[],
): FileParseResult {
  if (typeof raw.id !== "string" || raw.id.length === 0) {
    return { ok: false, error: "file.id must be a non-empty string" };
  }
  if (typeof raw.path !== "string" || raw.path.length === 0) {
    return {
      ok: false,
      error: `file(${raw.id}).path must be a non-empty string`,
    };
  }
  const labelResult = parseLabel(raw.label, `file(${raw.id})`, warnings);
  if (!labelResult.ok) {
    return labelResult;
  }
  const timestamps = parseTimestamps(raw, `file(${raw.id})`);
  if (!timestamps.ok) {
    return timestamps;
  }

  const ref: FileRef = {
    id: raw.id,
    kind: "file",
    path: raw.path,
    label: labelResult.value,
    createdAt: timestamps.value.createdAt,
    updatedAt: timestamps.value.updatedAt,
  };
  if (raw.alias !== undefined) {
    const aliasResult = parseLabel(raw.alias, `file(${raw.id}).alias`, warnings);
    if (!aliasResult.ok) {
      return aliasResult;
    }
    ref.alias = aliasResult.value;
  }
  if (typeof raw.lastOpenedAt === "string" && raw.lastOpenedAt.length > 0) {
    ref.lastOpenedAt = raw.lastOpenedAt;
  }
  if (typeof raw.favoritedAt === "string" && raw.favoritedAt.length > 0) {
    ref.favoritedAt = raw.favoritedAt;
  }
  attachColorLabel(ref, raw.colorLabel, `file(${raw.id})`, warnings);
  return { ok: true, value: ref };
}

type FolderParseResult =
  | { ok: true; value: FolderRef }
  | { ok: false; error: string };

function parseFolderRef(
  raw: Record<string, unknown>,
  warnings: string[],
): FolderParseResult {
  if (typeof raw.id !== "string" || raw.id.length === 0) {
    return { ok: false, error: "folder.id must be a non-empty string" };
  }
  if (typeof raw.path !== "string" || raw.path.length === 0) {
    return {
      ok: false,
      error: `folder(${raw.id}).path must be a non-empty string`,
    };
  }
  const labelResult = parseLabel(raw.label, `folder(${raw.id})`, warnings);
  if (!labelResult.ok) {
    return labelResult;
  }
  const timestamps = parseTimestamps(raw, `folder(${raw.id})`);
  if (!timestamps.ok) {
    return timestamps;
  }

  const ref: FolderRef = {
    id: raw.id,
    kind: "folder",
    path: raw.path,
    label: labelResult.value,
    createdAt: timestamps.value.createdAt,
    updatedAt: timestamps.value.updatedAt,
  };
  if (raw.alias !== undefined) {
    const aliasResult = parseLabel(raw.alias, `folder(${raw.id}).alias`, warnings);
    if (!aliasResult.ok) {
      return aliasResult;
    }
    ref.alias = aliasResult.value;
  }
  if (typeof raw.lastOpenedAt === "string" && raw.lastOpenedAt.length > 0) {
    ref.lastOpenedAt = raw.lastOpenedAt;
  }
  if (typeof raw.favoritedAt === "string" && raw.favoritedAt.length > 0) {
    ref.favoritedAt = raw.favoritedAt;
  }
  attachColorLabel(ref, raw.colorLabel, `folder(${raw.id})`, warnings);
  return { ok: true, value: ref };
}

/* ─────────────────────── Field-level helpers ─────────────────────── */

/**
 * Attach `colorLabel` if present and valid; drop with a warning if
 * the value is junk. Color is cosmetic — a malformed value should
 * not nuke the user's whole shelf via the recovery flow.
 */
function attachColorLabel(
  target: { colorLabel?: ColorLabel },
  raw: unknown,
  context: string,
  warnings: string[],
): void {
  if (raw === undefined) {
    return;
  }
  if (isColorLabel(raw)) {
    target.colorLabel = raw;
    return;
  }
  warnings.push(
    `${context}.colorLabel was invalid (${JSON.stringify(raw)}); dropped.`,
  );
}

type LabelParseResult =
  | { ok: true; value: string }
  | { ok: false; error: string };

function parseLabel(
  raw: unknown,
  context: string,
  warnings: string[],
): LabelParseResult {
  if (typeof raw !== "string") {
    return { ok: false, error: `${context}.label must be a string` };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return {
      ok: false,
      error: `${context}.label is empty or whitespace`,
    };
  }
  if (trimmed.length > MAX_CATEGORY_LABEL_LENGTH) {
    warnings.push(
      `${context} label was ${trimmed.length} chars; truncated to ${MAX_CATEGORY_LABEL_LENGTH}.`,
    );
    return { ok: true, value: trimmed.slice(0, MAX_CATEGORY_LABEL_LENGTH) };
  }
  return { ok: true, value: trimmed };
}

type TimestampsResult =
  | { ok: true; value: { createdAt: string; updatedAt: string } }
  | { ok: false; error: string };

function parseTimestamps(
  raw: Record<string, unknown>,
  context: string,
): TimestampsResult {
  const createdAt = typeof raw.createdAt === "string" ? raw.createdAt : "";
  const updatedAt = typeof raw.updatedAt === "string" ? raw.updatedAt : "";
  if (createdAt.length === 0) {
    return { ok: false, error: `${context}.createdAt must be a string` };
  }
  if (updatedAt.length === 0) {
    return { ok: false, error: `${context}.updatedAt must be a string` };
  }
  return { ok: true, value: { createdAt, updatedAt } };
}

function failure(error: string, warnings: string[] = []): ValidationResult {
  return { ok: false, value: cloneDefault(), error, warnings };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidSectionOrder(order: unknown[]): order is SectionId[] {
  if (order.length !== ALL_SECTION_IDS.length) {
    return false;
  }
  const seen = new Set<string>();
  for (const id of order) {
    if (typeof id !== "string" || !isSectionId(id) || seen.has(id)) {
      return false;
    }
    seen.add(id);
  }
  return seen.size === ALL_SECTION_IDS.length;
}

function isSectionId(value: string): value is SectionId {
  return (ALL_SECTION_IDS as readonly string[]).includes(value);
}
