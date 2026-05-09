# Changelog

All notable changes to Sweet Shelf are documented here.

## 1.0.0 — Initial release

The first release of Sweet Shelf brings a complete personal workspace map to VS Code:

- **Sidebar with three sections** — Library, Favorites, Recent — all drag-reorderable
- **Pin from anywhere** — add files and folders from any location on disk into nested categories
- **Inline folder browsing** — click a folder to expand its contents without changing your VS Code workspace
- **Display name aliases** — rename how items show on the shelf without renaming on disk; automatic disambiguation when items share basenames
- **Favorites and Recent** — star important items, see what you've opened lately
- **Focus Mode** — hide everything except one category or folder for deep-work sessions
- **Color labels** — tint files, folders, and categories with one of seven theme-aware colors
- **Broken-link recovery** — refs whose paths disappeared render as missing with one-click "Locate Again" recovery
- **Rename on disk** — rename real files and folders from the shelf, atomically, with descendant paths kept in sync
- **Keyboard search** — Command Palette → "Sweet Shelf: Search Shelf" → fuzzy-find anywhere on the shelf, with `color:` and `is:` filters
- **Export and import** — JSON portability with automatic backups before any replace
- **Drag and drop everywhere** — categories, files, folders, sections, OS files into the shelf

Sweet Shelf never deletes your real files. The only removal is "Remove from Sweet Shelf," which removes the reference, not the file.
