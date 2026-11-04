<a href="https://extension.js.org" target="_blank" rel="noopener noreferrer"><img src="https://img.shields.io/badge/Powered%20by%20%7C%20Extension.js-0971fe" alt="Powered by Extension.js" align="right" /></a>

# browser-curl

> Send HTTP requests and import cURL commands from the browser sidebar.

## How requests work

- The background script sends each request. The extension has access to all `http` and `https` sites, so the browser does not apply CORS checks. The browser asks for this access when you install the extension.
- Cookie, Origin, Referer, User-Agent, and `Sec-*` headers are sent as you enter them. Chromium sets them with `declarativeNetRequest` session rules. Firefox sets them with a blocking `webRequest` listener. The browser always sets Host, Content-Length, and Connection itself.
- If you do not enter an Origin header, the extension removes the browser's own Origin header, as curl does.
- Paste a cURL command into the URL field to fill in the method, URL, query parameters, headers, body, and authorization. Select **Undo** to restore the previous values. [curlconverter](https://github.com/curlconverter/curlconverter) parses the command.
- Select the toolbar icon to open the panel. The extension does not add anything to web pages.

## Response size limits

Select the gear button in the panel header, or open the extension's options in the browser, to change these limits. New requests use the saved values.

- **Maximum response size** (default 10 MB, 1 to 100 MB): The extension stops reading a response body at this size. The panel shows only the first part and marks the size as cut off.
- **History body limit** (default 2 MB, 0 to 100 MB): History saves a response body only if the body is this size or smaller. For a larger body, history keeps the request, status, headers, and size, and the panel shows a note in place of the body. The panel that sent the request still shows the full body until you close it. Enter 0 to never save response bodies.

The panel does not show binary bodies, such as images or PDF files, and history does not save them. A missing Content-Type counts as text.

## Drafts and request history

- The panel saves your draft as you edit it, including unfinished text, disabled rows, and authorization fields. While you type, it saves 0.3 seconds after the last keystroke. It also saves when a field loses focus and when the panel closes. Closing and reopening the panel restores it.
- Select **Send** to save a separate history entry with the complete editor values, the sent request, and its response or failure. Requests without a custom name use the URL hostname. History keeps the newest 100 requests and deletes older ones.
- Requests continue after you close the panel. Reopen the panel or select **History** to see a running request and its result. Select **Cancel** to stop the displayed request.
- Select **History** in the header to open a sent request. Select **Back to draft** to return to your earlier draft. Browsing history does not overwrite that draft.
- Select the trash button beside a history entry to delete its request and response. A response arriving after deletion does not restore the entry.
- Select **Clear** to empty the editor and visible response. Saved history remains available, and running background requests continue.

Drafts and history stay in local extension storage, including credentials and response bodies. They are not synced to another device. History stays until you delete it, it becomes one of more than 100 requests, or you remove the extension. The history list reads only a small index, so it does not load response bodies. The extension requests `storage` and `unlimitedStorage` permissions, because 100 responses of up to the history body limit can be larger than the default extension storage quota. The browser stopping or restarting interrupts running requests.

## Source layout

Code under `src` is grouped by feature:

- `requests/`: Request types, validation, authorization, cURL import, background messaging, HTTP execution, and header rules.
- `history/`: Editor snapshots, saved requests, history summaries, and workspace storage.
- `responses/`: Response text formatting, byte counts, and the saved panel height.
- `settings/`: Response size limits, validation, and saved preferences.
- `shared/`: Browser storage helpers used by multiple features.
- `sidebar/`: Sidebar markup, styles, startup, and coordination of the feature modules.
- `options/`: Settings page markup, styles, and form events.
- `images/`: Extension icons.

`background.ts` connects browser events to the request and history features. `manifest.json` defines the extension entry points and permissions.
Feature modules do not import page modules from `sidebar/` or `options/`.

## Development Commands

### dev

Run the extension in development mode. Target a browser with `--browser`:

```bash
pnpm dev
pnpm dev -- --browser=firefox
pnpm dev -- --browser=edge
```

### build

Build for production. Convenience scripts target each browser:

```bash
pnpm build           # Chromium (default)
pnpm build:firefox
pnpm build:edge
```

### preview

Preview the production build in the browser:

```bash
pnpm preview
```

### test

Run the unit tests:

```bash
pnpm test
```

Run the browser workflows with Chrome installed:

```bash
pnpm test:browser
```

Set `CHROME_BINARY` if Chrome uses a different executable name or path. The test uses temporary files and a temporary browser profile. It runs the production panel and background bundles with simulated extension APIs and network responses. It does not test live services, real header rewriting, or the browser's service worker lifecycle.

Run the real extension end-to-end tests with Playwright's Chromium browser:

```bash
pnpm exec playwright install chromium --no-shell
pnpm test:e2e
```

The e2e suite builds and loads the unpacked extension in a temporary persistent browser profile. It uses real extension APIs, disk storage, background workers, clipboard access, and HTTP requests to a local server. Each test closes its browser and server and removes its profile. Reports stay in the ignored `.playwright/` directory.

The suite covers:

- Unsent drafts, disabled rows, inactive credentials, saved requests, and complete responses across browser restarts.
- Running indicators, completion after page closure, cancellation after reopening, the real request timeout, and recovery after browser or worker termination.
- Actual methods, bodies, repeated URL parameters and headers, all authorization types, locked header rewriting, and cleanup of temporary rules.
- HTTP error responses, connection failures, redirects, compressed bodies, and invalid input that must not send a request.
- History previews, preserved drafts, resending, clearing, deletion, and responses arriving after deletion.
- Native clipboard copying, raw and pretty responses, keyboard shortcuts, tab navigation, pointer and keyboard resizing, and cURL typing, clipboard paste, and Undo.
- The options page defaults, saving and validation, the panel's Settings button, cut-off large responses, bodies kept out of history, and binary bodies.

The unit tests cover the 100-request history limit. The e2e suite does not send 100 requests. The production sidebar document runs as an extension tab so the tests can close its real page and port. The suite does not automate the browser's native side-panel frame or toolbar. It does not test Firefox, external services, or HTTPS certificate handling. The local server supplies controlled responses and does not replace `fetch`, extension messaging, or storage. The real timeout case takes about 30 seconds.

## Learn more

[Extension.js docs](https://extension.js.org).
