import type { ShelfConfig } from "./types";

/**
 * Migration seam for imports.
 *
 * `migrateToCurrentVersion` is the only path through which import
 * data reaches the validator. Today it's a version dispatch + pass-
 * through (we're at v1 and have nothing to migrate from). The
 * shape exists now so that when the schema bumps to v2, v3, etc.,
 * each new version slots in as another case without touching the
 * import command handler.
 *
 * On `ok: true`, the returned config is structurally a `ShelfConfig`
 * but hasn't been validated yet — the caller runs it through
 * `validateShelfConfig` next. Migration is concerned with format
 * dispatch (which version's schema does this file claim?), not
 * content validity.
 */

/** Newest schema version this build understands. */
export const CURRENT_VERSION = 1;

export type MigrationResult =
  | { ok: true; config: ShelfConfig }
  | { ok: false; reason: string };

/**
 * Examine the version field of a parsed import payload, dispatch to
 * the appropriate migration step (or pass-through if already current).
 * Rejects unknown / future versions with a friendly reason string.
 */
export function migrateToCurrentVersion(parsed: unknown): MigrationResult {
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, reason: "This file isn't a Sweet Shelf export." };
  }
  const version = (parsed as { version?: unknown }).version;
  if (typeof version !== "number") {
    return {
      ok: false,
      reason: "This file is missing its version field — it may not be a Sweet Shelf export.",
    };
  }
  if (version > CURRENT_VERSION) {
    return {
      ok: false,
      reason:
        "This export is from a newer version of Sweet Shelf. Please update the extension.",
    };
  }
  if (version === 1) {
    // Already current; pass through to validator.
    return { ok: true, config: parsed as ShelfConfig };
  }
  // Older versions: future migrations slot in here. Until then,
  // any version < 1 is unrecognized.
  return {
    ok: false,
    reason: `Unrecognized shelf format (version ${version}).`,
  };
}
