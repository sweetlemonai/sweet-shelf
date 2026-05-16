import type { Favorite } from "./types";

/**
 * Pure helper backing the Favorites view.
 *
 * Favorites is stored directly as an ordered array on
 * `ShelfConfig.favorites` (Task 16). Render is trivially
 * `config.favorites` — no resolution, no drift cleanup, no
 * second-walk against Library. Cascade-on-remove keeps the array
 * coherent at mutation time.
 */
export function buildFavoritesView(
  favorites: readonly Favorite[],
): readonly Favorite[] {
  return favorites;
}
