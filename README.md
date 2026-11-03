<a href="https://extension.js.org" target="_blank" rel="noopener noreferrer"><img src="https://img.shields.io/badge/Powered%20by%20%7C%20Extension.js-0971fe" alt="Powered by Extension.js" align="right" /></a>

# browser-curl

> Adds a sidebar panel to the browser with a simple page.

## How requests work

- The background script sends each request. The extension has access to all `http` and `https` sites, so the browser does not apply CORS checks. The browser asks for this access when you install the extension.
- Cookie, Origin, Referer, User-Agent, and `Sec-*` headers are sent as you enter them. Chromium sets them with `declarativeNetRequest` session rules. Firefox sets them with a blocking `webRequest` listener. The browser always sets Host, Content-Length, and Connection itself.
- If you do not enter an Origin header, the extension removes the browser's own Origin header, as curl does.
- Paste a cURL command into the URL field to fill in the method, URL, query parameters, headers, body, and authorization. Select **Undo** to restore the previous values. [curlconverter](https://github.com/curlconverter/curlconverter) parses the command.

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

## Learn more

[Extension.js docs](https://extension.js.org).
