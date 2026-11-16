---
name: release-browsercurl
description: Prepare and publish browsercurl releases for Chromium and Firefox, including ZIPs, an unsigned Firefox XPI, a self-signed Chromium CRX, and checksums. Use when a browsercurl release is requested.
---

# Release browsercurl

Run from the repository root. Use the existing cleanup and packaging commands rather than replacing their logic.

## Remote gates

A GitHub ruleset protects `main`. Every change reaches `main` through a pull request with passing `Unit tests`, `Browser tests`, and `E2E tests` checks.
A second ruleset protects `v*` tags. A release tag can be created once, but it cannot be moved or deleted.

Each of these actions needs its own explicit "yes" from the user in this session:

1. Push the release branch and open the release pull request.
2. Merge the release pull request.
3. Publish the GitHub release, which creates the tag on origin.

Before each gate, show the user what will happen: the branch or tag, the commit SHA, and the files or assets.
Then stop and wait for the answer. The release request itself and earlier approvals are not confirmation for a later gate.

## Version and source

- Inspect the working tree, remote branch, tags, and GitHub releases before changing files.
- Use the requested version. If unspecified, choose the next unused patch version after the latest stable release.
- Create the branch `chore/release-v<version>` from the latest `origin/main`. Note the branch the user started on.
- Set the same version in `package.json` and `src/manifest.json`. Commit only these two files on the release branch. Use `v<version>` for the release tag.
- A new version and its built artifacts must belong to the same source commit. Build and test from the committed release branch.
- Preserve unrelated working-tree and staging changes. Keep every published tag where it is. Replace an existing release only on explicit instructions.

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

## Merge the release pull request

Confirm the working tree used for the builds matches the release branch commit.
Ask for gate 1. Then push the branch and open a pull request into `main` with `gh pr create`.

Wait until the three required checks pass. If a check fails, stop and investigate before you continue.
Ask for gate 2. Then merge with `gh pr merge <number> --squash`.

Get the merged commit with `gh pr view <number> --json mergeCommit --jq .mergeCommit.oid`. This commit is the release source commit.
Fetch `origin/main` and compare trees: `git rev-parse <branch-commit>^{tree}` must equal `git rev-parse <source-commit>^{tree}`.
If the trees differ, check out the source commit, then repeat the clean, build, test, and package steps from there.

## Publish and verify

Write release notes to a file. Include user-visible changes, source commit, package meanings, test results, and verification limits.
Label the Firefox XPI as unsigned and the Chromium CRX as self-signed. Neither package has browser-store approval.

Ask for gate 3. Then publish with `gh release create` using the selected tag, the source commit SHA in `--target`, and `--notes-file`.
Attach the four explicit package paths and `SHA256SUMS.txt`. Do not upload a whole directory or use a broad file wildcard.

If publication fails or returns an uncertain result, inspect the remote release and tag before retrying.
Continue only with missing steps. Stop for user input if a remote state conflict would require replacing published content.
A wrong tag stays on origin because of the tag ruleset. Report it to the user and stop.

Verify that the tag resolves to the source commit, the release has the intended visibility, and every asset finished uploading.
Compare GitHub's asset digests with local checksums. If digests are unavailable, download the uploaded assets and verify them locally.
Switch back to the branch the user started on.
Report the release URL, pull request URL, download links, source commit, skill location, and any checks not run.
