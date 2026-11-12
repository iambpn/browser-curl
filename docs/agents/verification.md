# How to verify a change

browser-curl is a browser extension. Its sidebar sends HTTP requests and imports cURL commands. You verify a change through tests that load the built extension in a browser. You cannot open a real browser window.

## Run tools in the sandbox

Call the tools in `node_modules/.bin` directly, as the checks below do. The `pnpm` command on this machine does not work in the sandbox. If you must change dependencies, run `npx --yes pnpm@12.4.1 install` and commit `pnpm-lock.yaml`.

## Checks

Run these commands in this order. Each must exit with code 0.

1. `node --test tests/` runs the unit tests in `tests/*.test.mjs`.
2. `node_modules/.bin/extension build` builds the Chromium extension into `dist/chromium/`.
3. `node_modules/.bin/tsc --noEmit` checks the types. It needs `extension-env.d.ts`, which the build creates.
4. `node tests/browser/run.mjs` runs the built sidebar in headless Chrome with simulated extension APIs and network responses.
5. `PLAYWRIGHT_BROWSERS_PATH=0 node_modules/.bin/playwright test` loads the built extension in Playwright's Chromium. The tests send real requests to a local test server.

`PLAYWRIGHT_BROWSERS_PATH=0` makes Playwright use the Chromium inside `node_modules`. The sandbox copies `node_modules` into each checkout, but it starts every session with an empty home folder. Set this variable for every Playwright command.

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
- For a visible change, a screenshot and a video. Save both in `.factory-evidence/`, and describe them in `.factory-evidence/evidence.md`. The factory runner keeps this folder out of Git.

### Take a screenshot

Add a screenshot line to the e2e test that shows the change, after the page reaches the state to prove:

```js
await panel.screenshot({path: '.factory-evidence/<name>.png'})
```

Give each screenshot a name that says what it shows, such as `collection-saved.png`.

### Record a video

Run the e2e test file that shows the change with `FACTORY_EVIDENCE=1`:

```sh
FACTORY_EVIDENCE=1 PLAYWRIGHT_BROWSERS_PATH=0 node_modules/.bin/playwright test e2e/<name>.spec.mjs
```

The e2e fixture then records one `.webm` video for each browser page in `.factory-evidence/videos/`. Without `FACTORY_EVIDENCE=1`, the tests record nothing.

1. Run only the test file that shows the change. Each test of the file makes its own videos.
2. Find the video of the sidebar page in the test that shows the change. Files of about 2 KB show an empty page, so skip them.
3. Rename that video to say what it shows, such as `videos/save-request-flow.webm`.
4. Delete the other videos in `.factory-evidence/videos/`.
5. Link the video in `evidence.md` alone in its own paragraph, such as `![](videos/save-request-flow.webm)`.
