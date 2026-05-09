# Changelog

All notable changes to Sweet Shelf are documented here.

## 1.1.0 — Separate sidebar views

- **Library, Favorites, and Recent are now three separate sidebar views**, each with its own collapsible header — same UX pattern as Outline and Timeline under Explorer
- Drag a view header to reorder views (handled natively by VS Code)
- Library view's header switches to "Focus: \<name\>" when in Focus Mode
- "Add to Sweet Shelf" on inline-browsed files and folders renamed to **Add to Category…** for clarity
- New **Add to Favorites…** action on inline-browsed files and folders — adds and favorites in one step
- Internal cleanup: section-reorder code removed (replaced by VS Code's native view ordering); the `sectionOrder` field in `shelf.json` is now ignored if present in older configs

## 1.0.0 — Initial release

The first release of Sweet Shelf brings a complete personal workspace map to VS Code:

- **Sidebar with three sections** — Library, Favorites, Recent — all drag-reorderable
- **Pin from anywhere** — add files and folders from any location on disk into nested categories
- **Inline folder browsing** — click a folder to expand its contents without changing your VS Code workspace
- **Display name aliases** — rename how items show on the shelf without renaming on disk; automatic disambiguation when items share basenames
- **Favorites and Recent** — star important items, see what you've opened lately
- **Focus Mode** — hide everything except one category or folder for deep-work sessions
- **Color labels** — tint files, folders, and categories with one of seven theme-aware colors
- **Broken-link recovery** — items whose paths disappeared render as missing with one-click "Locate Again" recovery
- **Rename on disk** — rename real files and folders from the shelf, atomically, with descendant paths kept in sync
- **Keyboard search** — Command Palette → "Sweet Shelf: Search Shelf" → fuzzy-find anywhere on the shelf, with `color:` and `is:` filters
- **Export and import** — JSON portability with automatic backups before any replace
- **Drag and drop everywhere** — categories, files, folders, sections, OS files into the shelf

Sweet Shelf never deletes your real files. The only removal is "Remove from Sweet Shelf," which removes the reference, not the file.
