# Publishing Sweet Shelf

A short, practical guide for shipping a release to the VS Code Marketplace.

## Pre-publish checklist

- [ ] All steps in [TESTING.md](./TESTING.md) pass
- [ ] [CHANGELOG.md](./CHANGELOG.md) has an entry for the new version
- [ ] `version` in `package.json` matches the new release
- [ ] Hero screenshot in `media/` reflects current UI
- [ ] `media/icon-marketplace.png` is the real 256×256 brand asset (not the placeholder)
- [ ] `npm run package` succeeds with no warnings or errors

## Versioning

- Patch (`1.0.x`): bug fixes only, no behavior change
- Minor (`1.x.0`): non-breaking new features
- Major (`x.0.0`): breaking schema changes, removed commands, or changed defaults

The shelf-config schema has its own `version` field (currently `1`). Bumping that requires a migration step in [`src/shelf/migrate.ts`](./src/shelf/migrate.ts) — the seam exists for exactly this reason.

## Build the package

```bash
npm install
npm run package          # produces production build in dist/
npx vsce package         # produces sweet-shelf-<version>.vsix
```

Inspect the `.vsix`: `unzip -l sweet-shelf-1.0.0.vsix`. Confirm `dist/extension.js`, `package.json`, `media/`, and the markdown files are present, and that `node_modules/` and `src/` are excluded (they should be, via [.vscodeignore](./.vscodeignore)).

## Publish

```bash
npx vsce publish         # uses your stored personal access token
```

If publishing for the first time, create a publisher at <https://marketplace.visualstudio.com/manage> and a personal access token at <https://dev.azure.com/>. The token is scoped to "Marketplace (Publish)".

The publisher id in `package.json` (`sweet-lemon`) must match the publisher you registered.

## Post-publish

- Tag the release in git: `git tag v1.0.0 && git push --tags`
- Verify the listing at `https://marketplace.visualstudio.com/items?itemName=sweet-lemon.sweet-shelf`
- Install from a fresh VS Code instance and run through TESTING.md once more against the published build

## Hotfix flow

1. Branch from `main`, fix, PR, merge
2. Bump patch version: `npm version patch` updates `package.json`
3. Add a CHANGELOG entry
4. Run TESTING.md
5. `npx vsce publish` ships it
