/**
 * Color labels for shelf items.
 *
 * Pure — no VS Code imports beyond the theme-color string identifiers
 * (which are just well-known strings, not types). The decoration
 * provider and tree provider both consume this module: files/folders
 * route through `FileDecorationProvider`, categories through
 * `ThemeIcon`'s color parameter.
 *
 * Eight values total; the type carries seven (the named colors), and
 * "clear" is implemented by *deleting* the optional `colorLabel`
 * field on a ref or category. We never store `"none"` — absence is
 * the single source of truth for "no color."
 */

export type ColorLabel =
  | "red"
  | "orange"
  | "yellow"
  | "green"
  | "blue"
  | "purple"
  | "gray";

/** All valid color label values. Useful for picker UI and validation. */
export const ALL_COLOR_LABELS: readonly ColorLabel[] = [
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "gray",
] as const;

/** Type guard for runtime values from JSON. */
export function isColorLabel(value: unknown): value is ColorLabel {
  return (
    typeof value === "string" &&
    (ALL_COLOR_LABELS as readonly string[]).includes(value)
  );
}

/**
 * Map a `ColorLabel` to the Sweet Shelf theme-color id used everywhere
 * it surfaces (decoration provider, ThemeIcon for categories and
 * folders). The ids are *contributed* by this extension in package.json
 * with explicit hex defaults — we avoid VS Code's `charts.*` palette
 * because popular themes reassign those tokens for charting
 * aesthetics, which made "orange" render as purple in real-world use.
 */
export function themeColorIdFor(label: ColorLabel): string {
  return `sweetShelf.color.${label}`;
}

/**
 * Muted variant used when a color is *inherited* from an ancestor
 * shelved folder rather than set directly on the item. Cascading the
 * primary color verbatim makes children indistinguishable from the
 * folder itself; the muted token gives them a softer tint.
 */
export function mutedThemeColorIdFor(label: ColorLabel): string {
  return `sweetShelf.color.${label}.muted`;
}

/** Display label for the picker submenu, with a unicode color square. */
export function colorMenuLabel(label: ColorLabel): string {
  switch (label) {
    case "red":
      return "🟥 Red";
    case "orange":
      return "🟧 Orange";
    case "yellow":
      return "🟨 Yellow";
    case "green":
      return "🟩 Green";
    case "blue":
      return "🟦 Blue";
    case "purple":
      return "🟪 Purple";
    case "gray":
      return "⬜ Gray";
    default:
      return assertNever(label);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unexpected color label: ${JSON.stringify(value)}`);
}
