# How to verify a change

browser-curl is a browser extension. Its sidebar sends HTTP requests and imports cURL commands. You verify a change through tests that load the built extension in a browser. You cannot open a real browser window.

## Run tools in the sandbox

Call the tools in `node_modules/.bin` directly, as the checks below do. The `pnpm` command on this machine does not work in the sandbox. If you must change dependencies, run `npx --yes pnpm@12.4.1 install` and commit `pnpm-lock.yaml`.

The e2e global setup installs Playwright's pinned full Chromium when it is missing from the current user's cache. A fresh sandbox therefore needs network access on its first e2e run. To install it ahead of time as the same user that runs the checks:

```sh
node_modules/.bin/playwright install chromium --no-shell
```

Playwright keeps browser executables in a user cache outside `node_modules`. Copying installed dependencies into a worktree does not copy that cache. The global setup also handles a missing cache after updating Playwright or changing the sandbox user; installation failures fail the check before any tests run. The e2e fixture uses full Chromium (`channel: 'chromium'`), so it needs that browser even when Google Chrome is installed for the simulated browser test.

## Checks

Run these commands in this order. Each must exit with code 0.

1. `node --test tests/` runs the unit tests in `tests/*.test.mjs`.
2. `node_modules/.bin/extension build` builds the Chromium extension into `dist/chromium/`.
3. `node_modules/.bin/tsc --noEmit` checks the types. It needs `extension-env.d.ts`, which the build creates.
4. `node tests/browser/run.mjs` runs the built sidebar in headless Chrome with simulated extension APIs and network responses.
5. `node_modules/.bin/playwright test` loads the built extension in Playwright's Chromium. The tests send real requests to a local test server.

The simulated browser test and the e2e tests use the build in `dist/chromium/`. Run the build again after you change code in `src/`.

## Exercise the extension as a user does

Use the e2e tests in `e2e/`. They act as a user in the real sidebar.

- `e2e/fixtures.mjs` gives two test fixtures. `extension.openPanel()` opens the sidebar page. `api` is a local HTTP server, and `api.origin` is its address.
- `e2e/panel-helpers.mjs` has helpers to fill fields, click, send a request, and read saved history and settings.
- For a user-visible change, add or update a test in `e2e/` that fills the form, sends the request, and checks the result on the page.

Run one file with `node_modules/.bin/playwright test e2e/<name>.spec.mjs`.

## Proof to capture

- The summary lines of each check, such as `ℹ pass 66` and `27 passed`.
- The name of each new or changed test, and what it checks.
- For a visible change, a screenshot from a Playwright test: `await panel.screenshot({path: '.playwright/results/<name>.png'})`. Git ignores `.playwright/`, so do not commit the screenshot. Describe it in your report.
