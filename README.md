# browsercurl

A REST API client in the browser sidebar for Chromium and Firefox. Send HTTP requests, import cURL commands, and inspect responses without leaving your browser.

## Features

- **Request editor:** Set the HTTP method, URL, query parameters, headers, and JSON or text body. Keep disabled rows for later use.
- **Authorization:** Use Bearer tokens, Basic auth, API keys in headers or query parameters, or a custom Authorization header.
- **cURL import:** Paste a command into the URL field to fill the editor. Review import warnings and select **Undo** to restore the earlier values.
- **Background requests:** Keep requests running after the panel closes. Reopen the panel to view the result or cancel a running request.
- **Drafts and history:** Restore unfinished drafts and browse the latest 100 sent requests, including their responses or failures.
- **Response viewer:** Inspect status, headers, size, and duration. Switch between raw text and formatted JSON, then copy the result.
- **Panel controls:** Resize the response area and send requests with **Ctrl+Enter** or **Command+Enter**.
- **Size settings:** Limit response downloads and choose which response bodies history saves.

## Usage

1. Select the extension toolbar icon to open the sidebar.
2. Enter a URL or paste a cURL command into the URL field.
3. Set the method, parameters, headers, body, and authorization as needed.
4. Select **Send** to make the request and inspect its response.
5. Select **History** to reopen a saved request. Select **Back to draft** to return to the earlier draft.

Select the gear button to change response limits. Select **Clear** to empty the editor and visible response. Saved history and running requests remain available.

### Response limits

- **Maximum response size:** Defaults to 10 MB. The permitted range is 1 to 100 MB. Larger responses stop at this limit and show a cutoff notice.
- **History body limit:** Defaults to 2 MB. The permitted range is 0 to 100 MB. Enter 0 to prevent history from saving response bodies.

For bodies above the history limit, history keeps the request, status, headers, and size. The sending panel still shows the live body up to the maximum response size.
Binary bodies, such as images and PDFs, are not displayed or saved in history.

### Storage and permissions

Drafts and history stay in local extension storage, including entered credentials and saved response bodies. They are not synced to another device.
History keeps the newest 100 requests. Delete an entry to remove its request and response. Removing the extension also removes its local data.

The extension requests access to HTTP and HTTPS sites so the background script can send requests without web page CORS restrictions.
The `storage` and `unlimitedStorage` permissions support saved drafts and response history. The extension does not inject content scripts into web pages.

Chromium uses network rules to set headers such as Cookie, Origin, Referer, User-Agent, and `Sec-*`. Firefox uses a blocking `webRequest` listener.
The browser controls Host, Content-Length, and Connection. If the editor has no Origin header, the extension removes the browser's own Origin header.

## Development

### Requirements

- Node.js 22.12 or later, as required by the installed Extension.js version.
- pnpm 12.4.1, as specified in `package.json`.
- The browser you want to use for local development.

### Setup

Install the project package manager if needed:

```bash
npm install --global pnpm@12.4.1
```

Clone the repository and install the locked dependencies:

```bash
git clone https://github.com/iambpn/browser-curl.git
cd browser-curl
pnpm install --frozen-lockfile
```

### Run locally

Start development mode with automatic reloads:

```bash
pnpm dev
```

The default browser is Chromium. To use Firefox, run:

```bash
pnpm dev --browser=firefox
```

Browser profiles and parser assets are configured in `extension.config.js`. Stop the development command with **Ctrl+C** when finished.

### Build and preview

Build production files for each browser:

```bash
pnpm build           # Chromium: dist/chromium/
pnpm build:firefox   # Firefox: dist/firefox/
```

The package also defines `build:chrome` and `build:edge` scripts for those browser targets.
A local Firefox build is unsigned. See the signing reference below before distributing it for normal installation.

Preview an existing production build:

```bash
pnpm preview
pnpm preview --browser=firefox
```

The build compresses the Bash grammar as `tree-sitter-bash.wasm.gz`.
The sidebar loads and decompresses this asset only during cURL import. The parser JavaScript and WebAssembly files ship inside the extension.

### Checks and tests

Run the TypeScript check and unit tests:

```bash
pnpm exec tsc --noEmit
pnpm test
```

Unit tests cover request building, cURL parsing, header handling, storage, response formatting, and size settings.

Run the simulated browser workflows with Google Chrome installed:

```bash
pnpm test:browser
```

Set `CHROME_BINARY` if Chrome uses a different executable name or path.
This suite runs the production bundles with simulated extension APIs and network responses. It does not test real header rewriting or service worker lifetimes.

Install Playwright's full Chromium browser and run the real extension end-to-end tests:

```bash
pnpm exec playwright install chromium --no-shell
pnpm test:e2e
```

The e2e suite builds and loads the unpacked extension in temporary browser profiles.
It tests real extension APIs, storage, background workers, clipboard access, and HTTP requests to a local server.
Coverage includes drafts, history, cancellation, timeouts, header rules, response limits, keyboard controls, resizing, and cURL import.
Parser tests also check loading on demand, grammar size, reuse, and preserved drafts when the grammar is missing or corrupt.

Each test closes its browser and server and removes its temporary profile. Failure reports stay in the ignored `.playwright/` directory.
The suite opens the sidebar document as an extension tab. It does not automate the browser's native sidebar frame or toolbar.
It does not cover Firefox runtime behavior, external services, HTTPS certificates, or store signing. The real timeout test takes about 30 seconds.

### Source layout

```text
src/
  background.ts  Browser events and background startup
  history/       Saved requests, editor snapshots, and workspace storage
  images/        Extension icons
  manifest.json  Browser entry points and permissions
  options/       Settings page markup, styles, and form events
  requests/      Request building, cURL parsing, messaging, and HTTP execution
  responses/     Response formatting and saved panel height
  settings/      Response size settings and validation
  shared/        Browser storage helpers
  sidebar/       Sidebar markup, styles, startup, and feature coordination
```

Feature modules do not import page modules from `sidebar/` or `options/`.
The cURL parser adapter in `src/requests/curl-parser.ts` passes the decompressed grammar bytes to `web-tree-sitter`.

## References

- [Extension.js](https://extension.js.org/): Extension development, browser targets, and production builds.
- [curlconverter](https://github.com/curlconverter/curlconverter): Parses cURL commands into request data. This project uses version 4.12.0.
- [web-tree-sitter 0.24.7](https://github.com/tree-sitter/tree-sitter/tree/v0.24.7/lib/binding_web): The WebAssembly runtime used by the Bash parser.
- [Playwright extension testing](https://playwright.dev/docs/chrome-extensions): Loading extensions in Chromium for browser tests.
