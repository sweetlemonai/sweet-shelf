# Sweet Shelf — Manual Smoke Test

Run this sequence before any release. Each step's expected outcome is in italics. Any failure is a release blocker.

## Setup

1. Build the extension fresh: `npm install && npm run compile`
2. If upgrading, first uninstall any prior version and clear extension storage
3. Open VS Code with no workspace folder

## Cross-view sanity (1.1.0)

A. Drag the Favorites view header above Library — *order persists across reloads (VS Code native)*
B. Drag a Library file directly onto the Favorites view body — *the file gets favorited*
C. Right-click on the Recent view header — *"Clear Recent" appears in the title bar*

## 1.2.0 surface — Title-bar icons, scoped search, Settings panel

Run these in order before the rest of the smoke test. They populate the shelf with enough state for later sections to lean on.

### Title-bar icons

D1. Open the Library view — *three icons appear in the title bar in order: + (add), 🔍 (search), ⚙ (settings)*
D2. Hover each icon — *tooltip reads "Add to Sweet Shelf", "Search Shelf", "Sweet Shelf Settings" respectively*
D3. Click the 🔍 icon — *Quick Pick opens identical to "Sweet Shelf: Search Shelf" from the palette*
D4. Click the ⚙ icon — *Settings webview panel opens in the editor area, titled "Sweet Shelf Settings"*

### Scoped search

D5. Right-click any category → *menu shows "Search in this category"*
D6. Right-click a folder ref → *menu does NOT show "Search in this category"* (folder refs have no shelf descendants)
D7. Click "Search in this category" → *Quick Pick opens with placeholder "Searching in '<name>'…"; results limited to the category and its descendants*
D8. Type a query inside the scoped search — *fuzzy matching honors the scope; results outside the category are not shown*
D9. Hit Enter on a result — *reveals and opens (file) or expands (category) just like unscoped search*
D10. Right-click on a category that has no children → "Search in this category" → *Quick Pick shows the friendly "This category is empty." placeholder*

### Settings panel — Preferences

D11. With the panel open, verify all six preferences render:
  - Default folder click action (3 radios)
  - Default file click action (2 radios)
  - Maximum recent items (number input)
  - Show file extensions in labels (checkbox)
  - Show hidden files when browsing folders (checkbox)
  - Confirm before removing non-empty categories (checkbox)
D12. Toggle each preference once — *each change writes through; observe the live shelf update (e.g. extension toggle hides/shows extensions immediately)*
D13. Open VS Code's native Settings (`Cmd+,` / `Ctrl+,`) → search `sweetShelf` → *every value matches what you just set in the panel*
D14. Change a value in the native Settings UI — *the open panel updates within a second to reflect the change*
D15. Set Maximum recent items to a non-numeric / out-of-range value — *the input clamps to 1–100; the value committed is what's persisted*

### Settings panel — Sweet Lemon Apps

D16. Scroll to the "Sweet Lemon Apps" section — *two cards render: Sweet Markdown and Braindump*
D17. Each card shows the app's icon, name, description — *icons load (real marketplace assets, not the Sweet Shelf citrus)*
D18. Each card's actions row shows a muted italic "Coming soon" pill — *no Install / Open buttons while the listing is in coming-soon state*
D19. Click "More from Sweet Lemon →" — *external browser opens the publisher page at marketplace.visualstudio.com/publishers/sweet-lemon*

(Once Sweet Markdown / Braindump publish, edit `src/settings/companionApps.ts` to set `status: "published"` per app — the card flips to Install / Installed+Open without any further code change.)

### Theme adaptation

D20. With the panel open, switch VS Code's theme (Light → Dark or vice versa) via Command Palette → "Preferences: Color Theme" → *panel colors adapt; no hard-coded white/black surfaces; text remains readable in both themes*

### Single-instance lifecycle

D21. With the panel already open, click the ⚙ icon again — *existing panel refocuses; no second tab opens*
D22. Close the panel via its X button — *panel disposes; clicking ⚙ now opens a fresh panel*
D23. With the panel open in one editor group, drag its tab to another group — *panel survives the move; settings still functional*

### Companion apps lifecycle (publish-day spot check)

D24. (When ready to flip a card to published) Edit `src/settings/companionApps.ts` to set `status: "published"` for one app, rebuild, reopen panel — *card now shows Install button*
D25. Click Install on that card — *VS Code's extension installer runs; panel updates to Installed + Open within a second*
D26. Click Open — *the app's primary command runs (or the marketplace listing opens as fallback if the command isn't registered)*
D27. Uninstall the companion via VS Code's Extensions view while the panel is open — *card flips back to Install*

## Core flow

4. Click the Sweet Shelf icon in the Activity Bar — *sidebar opens with three separate views: Library, Favorites, Recent, each with its own collapsible header*
5. Click **+** → New Category, name it `Books` — *category appears under Library*
6. Right-click `Books` → New Subcategory → `Code Smarter` — *nested under Books*
7. Right-click `Code Smarter` → Add File → pick any markdown file — *appears with file-type icon*
8. Click the file — *opens in editor without changing workspace*
9. Right-click the file → Rename Display Name → `Chapter 3` — *label updates; verify with `ls` that the file on disk is unchanged*

## Browse and disambiguation

10. Add three files from different folders all named `README.md` — *all three appear; each shows a breadcrumb description (` · Books`, etc.)*
11. Add a folder containing markdown files — *appears as folder icon*
12. Click the folder — *expands inline; files browseable*
13. Click a file inside the inline browse — *opens, workspace unchanged*

## Personalization

14. Right-click a shelf file → Add to Favorites — *star decoration appears; file shows in the Favorites view*
15. Right-click a category → Set Color → Blue — *folder icon tints blue*
16. Right-click a shelf file → Set Color → Red — *file row tints red; editor tab gets red dot when opened*
17. Right-click an aliased file → Clear Display Name — *label reverts to basename; disambiguator returns*

## Focus

18. Right-click a category → Focus on this — *Library view's title changes to "Focus: <name>"; the focus header appears at the top of Library; Favorites and Recent views disappear*
19. Click the focus header — *Library returns to normal; Favorites and Recent reappear*
20. Repeat with a folder — *focused folder expands inline*
21. Right-click a folder in Favorites → Focus on this — *focuses cleanly from any section*

## Recovery

22. Move a shelved file to trash via Finder/Explorer — *Sweet Shelf marks it as missing within seconds (⚠ badge, "(missing)" suffix)*
23. Right-click the missing file → Locate Again → restore from trash → pick it — *broken state clears*
24. Run "Sweet Shelf: Validate Paths" from the Command Palette — *progress notification, summary toast*

## Search

(Title-bar icon and "Search in this category" are covered above in the 1.2.0 surface section. These steps cover unscoped query syntax.)

25. `Cmd/Ctrl + Shift + P` → "Sweet Shelf: Search Shelf" — *Quick Pick opens with all items*
26. Type a few characters — *fuzzy match across labels and breadcrumbs*
27. Type `color:red` — *only red items shown (filter token vanishes from the input once recognized)*
28. Type `is:favorited` — *only favorited items*
29. Hit Enter on a result — *reveals + opens the selected item*

## Portability

30. "Sweet Shelf: Export Shelf" → "Shelf structure (recommended)" → save somewhere — *file written; success toast with Reveal button*
31. Edit the live shelf (e.g. add a category) — *change appears immediately*
32. "Sweet Shelf: Import Shelf" → pick the previous export → confirm — *backup created in global storage; shelf reverts to the exported state; "Reveal Backup" button works*
33. "Sweet Shelf: Reveal Config File" — *OS file manager opens with `shelf.json` selected*

## Restart

34. Close VS Code, reopen — *shelf restores fully: categories, files, folders, favorites, focus state if any, colors*

## Cleanup

35. Right-click test items → Remove from Sweet Shelf — *items removed from the shelf*
36. Verify the original files in their original locations are untouched throughout the test

## Output channel

37. Open the "Sweet Shelf" output channel (View → Output → Sweet Shelf) — *no unexpected errors during the run; warnings are limited to actions that triggered them (e.g. import warnings)*

---

A clean run through all numbered steps (and the lettered 1.1.0 / 1.2.0 sanity blocks) with no surprises is the green light to publish.
