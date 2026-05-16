# Changelog

All notable changes to Sweet Shelf are documented here.

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
