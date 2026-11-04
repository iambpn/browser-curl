---
name: release-browsercurl
description: Prepare and publish browsercurl releases for Chromium and Firefox, including ZIPs, an unsigned Firefox XPI, a self-signed Chromium CRX, and checksums. Use when a browsercurl release is requested.
---

# Release browsercurl

Run from the repository root. Use the existing cleanup and packaging commands rather than replacing their logic.

## Version and source

- Inspect the working tree, remote branch, tags, and GitHub releases before changing files.
- Use the requested version. If unspecified, choose the next unused patch version after the latest stable release.
- Set the same version in `package.json` and `src/manifest.json`. Use `v<version>` for the release tag.
- Follow the repository's Git-state rules and existing session authorization when recording the release source.
- A new version and its built artifacts must belong to the same source commit. Do not tag an older commit to publish uncommitted changes.
- If a needed source commit or push is not authorized, finish the local artifacts and checks before requesting that authorization.
- Preserve unrelated working-tree and staging changes. Never force a tag update or replace an existing release without explicit instructions.

## Clean and build

Use the package manager version in `package.json`. Check that Chrome and authenticated GitHub CLI access are available.

1. Stop development or test processes started for this release before cleaning.
2. Check `pnpm clean:dry-run`, then run `pnpm clean` when cleanup is authorized by the release request.
3. Preserve `.keys/chromium.pem` and any configured `CRX_KEY_PATH`. A custom key must stay outside generated folders.
4. Build both browsers with ZIP output. Set `release_version` to the version selected above:

```bash
pnpm build --zip --zip-filename "browsercurl-${release_version}"
pnpm build:firefox --zip --zip-filename "browsercurl-${release_version}"
```

Extension.js appends the browser name and writes ZIPs under `dist/`. Inspect the reported output paths.
The archives must contain `manifest.json` at their root and match the freshly built `dist/chromium/` and `dist/firefox/` files.

## Tests and packages

Run the unit/CLI tests and TypeScript check. Use the fresh Chromium build for both browser suites:

```bash
pnpm test
pnpm exec tsc --noEmit
node tests/browser/run.mjs
pnpm exec playwright test
```

The simulated browser suite requires Chrome. The e2e suite requires Playwright's full Chromium browser and uses local HTTP servers.
Report Firefox runtime and add-on lint coverage separately. A successful Firefox build does not prove either check ran.
Stop and investigate a failed check before publishing.

Move the two new ZIPs into `dist/releases/` using these names:

- `browsercurl-<version>-chromium.zip`
- `browsercurl-<version>-firefox.zip`

Run `pnpm package:extensions`. It creates:

- `browsercurl-<version>-firefox-unsigned.xpi`: unchanged Firefox ZIP bytes, without Mozilla signing.
- `browsercurl-<version>-chromium-self-signed.crx`: a CRX3 package signed with the retained local key.

Use `CHROME_BINARY` when Chrome's executable is not named `google-chrome`.
Never upload a PEM file or include private keys in build inputs, release folders, notes, or logs.

Verify the ZIPs, root manifests, browser entry points, and version fields. Confirm the XPI equals its Firefox ZIP.
Check the CRX3 signature and embedded build files. Confirm the signing key and extension ID remain unchanged across packaging.
Write `dist/releases/SHA256SUMS.txt` with SHA-256 hashes of the four packages, using their filenames without directory prefixes.
Verify the checksum file from inside `dist/releases/`.

## Publish and verify

Record only authorized source changes in the release commit and push that commit before creating the release tag.
Confirm the working tree used for the builds matches that commit.

Write release notes to a file. Include user-visible changes, source commit, package meanings, test results, and verification limits.
Label the Firefox XPI as unsigned and the Chromium CRX as self-signed. Neither package has browser-store approval.

Publish with `gh release create` using the selected tag, the exact source SHA in `--target`, and `--notes-file`.
Attach the four explicit package paths and `SHA256SUMS.txt`. Do not upload a whole directory or use a broad file wildcard.

If publication fails or returns an uncertain result, inspect the remote release and tag before retrying.
Continue only with missing steps. Stop for user input if a remote state conflict would require replacing published content.

Verify that the tag resolves to the source commit, the release has the intended visibility, and every asset finished uploading.
Compare GitHub's asset digests with local checksums. If digests are unavailable, download the uploaded assets and verify them locally.
Report the release URL, download links, source commit, skill location, and any checks not run.
