<a href="https://extension.js.org" target="_blank" rel="noopener noreferrer"><img src="https://img.shields.io/badge/Powered%20by%20%7C%20Extension.js-0971fe" alt="Powered by Extension.js" align="right" /></a>

# browser-curl

> Adds a sidebar panel to the browser with a simple page.

## How requests work

- The background script sends each request. The extension has access to all `http` and `https` sites, so the browser does not apply CORS checks. The browser asks for this access when you install the extension.
- Cookie, Origin, Referer, User-Agent, and `Sec-*` headers are sent as you enter them. Chromium sets them with `declarativeNetRequest` session rules. Firefox sets them with a blocking `webRequest` listener. The browser always sets Host, Content-Length, and Connection itself.
- If you do not enter an Origin header, the extension removes the browser's own Origin header, as curl does.
- Paste a cURL command into the URL field to fill in the method, URL, query parameters, headers, body, and authorization. Select **Undo** to restore the previous values. [curlconverter](https://github.com/curlconverter/curlconverter) parses the command.

## Drafts and request history

- The panel saves your draft as you edit it, including unfinished text, disabled rows, and authorization fields. Closing and reopening the panel restores it.
- Select **Send** to save a separate history entry with the complete editor values, the sent request, and its response or failure. Requests without a custom name use the URL hostname.
- Requests continue after you close the panel. Reopen the panel or select **History** to see a running request and its result. Select **Cancel** to stop the displayed request.
- Select **History** in the header to open a sent request. Select **Back to draft** to return to your earlier draft. Browsing history does not overwrite that draft.
- Select the trash button beside a history entry to delete its request and response. A response arriving after deletion does not restore the entry.
- Select **Clear** to empty the editor and visible response. Saved history remains available, and running background requests continue.

Drafts and history stay in local extension storage, including credentials and response bodies. They are not synced to another device. History stays until you delete it or remove the extension. The extension requests `storage` and `unlimitedStorage` permissions to keep complete responses without a fixed history limit. The browser stopping or restarting interrupts running requests.

## Commands

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

The production sidebar document runs as an extension tab so the tests can close its real page and port. The suite does not automate the browser's native side-panel frame or toolbar. It does not test Firefox, external services, or HTTPS certificate handling. The local server supplies controlled responses and does not replace `fetch`, extension messaging, or storage. The real timeout case takes about 30 seconds.

## Learn more

[Extension.js docs](https://extension.js.org).
