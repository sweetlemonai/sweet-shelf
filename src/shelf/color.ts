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
 * Map a `ColorLabel` to the VS Code theme-color id used everywhere it
 * surfaces (decoration provider, ThemeIcon for categories). Picking
 * `charts.*` keeps the palette theme-adaptive (light/dark/contrast)
 * without us having to ship hex values.
 */
export function themeColorIdFor(label: ColorLabel): string {
  switch (label) {
    case "red":
      return "charts.red";
    case "orange":
      return "charts.orange";
    case "yellow":
      return "charts.yellow";
    case "green":
      return "charts.green";
    case "blue":
      return "charts.blue";
    case "purple":
      return "charts.purple";
    case "gray":
      return "charts.foreground";
    default:
      return assertNever(label);
  }
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
