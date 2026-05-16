# Changelog

All notable changes to Sweet Shelf are documented here.

## 1.0.3 — Show hidden files toggle now refreshes immediately

- Toggling **Show hidden files** in the Settings panel (or VS Code Settings) now refreshes the Library view immediately. Previously the new value was written to config correctly but the tree didn't re-render until you reloaded the window.

## 1.0.2 — Drop subtree color cascade

- 1.0.1 tried to cascade a colored folder's tint onto every file and sub-folder beneath it. VS Code tree labels expose a single foreground color for the whole row, so any "section" indicator either left filenames unchanged at the cost of a large emoji square, or kept the marker small at the cost of tinting filenames too. Neither read well; the cascade is removed in 1.0.2. Colors now apply only to the category, file, or folder you set them on.

## 1.0.1 — Color fidelity, cross-window sync

- **Sweet Shelf now ships its own color palette** so orange shows orange, purple shows purple, etc. Themes that reassign VS Code's `charts.*` tokens for chart aesthetics no longer scramble shelf colors.
- **Folder colors survive selection.** Tinting moved from the row's foreground (which VS Code overrides when a row is selected) to the folder icon itself, so the color stays visible while the row is highlighted.
- **Cross-window sync.** Adding a category or favorite in one VS Code window now shows up in other windows on the same machine automatically — `shelf.json` is watched for external changes and reloaded.
- **Companion apps are live.** Sweet Markdown and Braindump now render as installable cards in the Settings panel instead of "Coming soon" placeholders.

## 1.0.0 — Initial release

Sweet Shelf is a personal workspace map for VS Code. The first release ships with:

- **Three sidebar views** — Library, Favorites, Recent — each with its own collapsible header. Drag headers to reorder.
- **Library** — your organized shelf. Nest categories as deep as you want; add files and folders from any path on disk; rename items with display-name aliases (the file on disk stays untouched). Inline-browse folders without changing your workspace.
- **Favorites** — flag any Library file or folder. Click a favorited file to open it. Click a favorited folder to jump to it in Library and expand its contents inline. Reorder via Move Up / Move Down or drag.
- **Recent** — files and folders you've opened from your shelf, newest first. Auto-managed.
- **Focus Mode** — hide everything except one category or folder for deep-work sessions.
- **Color labels** — tint files, folders, and categories with one of seven theme-aware colors.
- **Broken-link recovery** — paths that disappear render with a ⚠ badge and a one-click "Locate Again" flow.
- **Rename on disk** — rename real files and folders from the shelf; descendant paths stay in sync.
- **Search** — Command Palette → "Sweet Shelf: Search Shelf", or click the 🔍 icon. Fuzzy-find with `color:` and `is:` filters; right-click a category for "Search in this category".
- **Custom Settings panel** — every preference in one place, plus a Sweet Lemon Apps section for companion extensions.
- **Export / import** — JSON portability with automatic backups before any replace.
- **Drag and drop** — categories, files, folders, OS files into the shelf; Library files and folders onto Favorites to flag them.

Sweet Shelf never deletes your real files. "Remove from Sweet Shelf" removes the reference, not the file.
