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

A clean run through all 37 steps with no surprises is the green light to publish.
