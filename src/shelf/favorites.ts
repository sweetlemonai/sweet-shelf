import type { Category, FileRef, FolderRef } from "./types";
import { walkAll } from "./categories";

/**
 * Pure helpers backing the Favorites view.
 *
 * Architectural rule for Favorites: refs are *referenced* by id from
 * `favoritesOrder`, never copied. The single source of truth for the
 * existence of a favorited ref is `library`; the only thing
 * `favoritesOrder` adds is the user-controllable display order.
 *
 * `buildFavoritesView` is responsible for two things at render time:
 *
 *   1. Resolve each id in `favoritesOrder` to an actual ref. Drop any
 *      that no longer exist or have lost their `favoritedAt` flag.
 *   2. Catch the inverse drift — refs whose `favoritedAt` is set but
 *      that aren't in `favoritesOrder` (e.g. the user hand-edited
 *      shelf.json) — and append them so they still show up.
 *
 * When either drift is detected, `cleanedOrder` is non-null and the
 * caller should persist it via `store.replaceFavoritesOrder` so the
 * file matches reality.
 */
export interface FavoritesView {
  /** Refs to render, in display order. */
  refs: Array<FileRef | FolderRef>;
  /**
   * Cleaned `favoritesOrder` if drift was detected; `null` when the
   * persisted order already matches reality (no save needed).
   */
  cleanedOrder: string[] | null;
}

export function buildFavoritesView(
  library: readonly Category[],
  favoritesOrder: readonly string[],
): FavoritesView {
  const favoritedById = new Map<string, FileRef | FolderRef>();
  for (const node of walkAll(library)) {
    if (node.kind === "category") {
      continue;
    }
    if (node.favoritedAt !== undefined) {
      favoritedById.set(node.id, node);
    }
  }

  const refs: Array<FileRef | FolderRef> = [];
  const cleaned: string[] = [];
  let drifted = false;

  for (const id of favoritesOrder) {
    const ref = favoritedById.get(id);
    if (ref) {
      refs.push(ref);
      cleaned.push(id);
      favoritedById.delete(id);
    } else {
      // ID names a missing ref or one that lost favoritedAt — drop it.
      drifted = true;
    }
  }

  // Refs favorited but not in favoritesOrder — append (preserve them).
  for (const [id, ref] of favoritedById) {
    refs.push(ref);
    cleaned.push(id);
    drifted = true;
  }

  return { refs, cleanedOrder: drifted ? cleaned : null };
}
