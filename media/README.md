# Sweet Shelf — Media Assets

Inventory of the visual assets shipped with the extension.

## Files in this directory

### `icon.svg` — Activity Bar icon

Monochrome citrus-slice glyph rendered at 24×24. Uses `currentColor` for stroke so VS Code can recolor it for the active theme. Loaded by VS Code from `package.json` → `viewsContainers.activitybar.icon`.

**Don't add color or fills here.** The Activity Bar recolors monochrome SVGs; a colored SVG would be tinted unevenly across themes.

### `icon-marketplace.png` — Marketplace listing icon

Full-color brand icon shown on the VS Code Marketplace listing page. Loaded from `package.json` → `icon`.

**Required spec:** 128×128 or larger PNG, RGBA, with the brand visible at small sizes.

The current file is a transparent **placeholder**. Replace it with a real brand asset — ideally a colored citrus-slice on a warm background that complements `galleryBanner.color` (`#FFF8E7`) — before publishing.

### `screenshot-hero.png` — README hero image

The first thing a new user sees on the README and the Marketplace listing. Should show a populated, real-looking shelf:

- 3–4 categories, at least one nested
- A few favorited items with the ★ decoration visible
- One category color-coded (blue or green reads best)
- One folder expanded inline showing real files
- The Activity Bar with Sweet Shelf selected, sidebar open

Capture at 2x retina, then export at the natural 1x size (so it looks crisp on high-DPI displays without being huge). Suggested final size: ~960×600.

The current file is a placeholder. Replace before publishing.

## Future screenshots

The README mentions specific features. If you want per-feature screenshots, add them as `screenshot-<feature>.png` and reference them inline:

- `screenshot-search.png` — the search Quick Pick with results
- `screenshot-focus.png` — Focus Mode in action
- `screenshot-broken.png` — a missing ref with the recovery menu open
- `screenshot-color.png` — a colored-up shelf

Per-feature screenshots are optional for v1; the hero image plus the feature copy carries the README on its own.
