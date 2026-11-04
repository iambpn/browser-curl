/** Run the built panel and background in Chrome with simulated extension APIs and network responses. No server is needed. */
import assert from 'node:assert/strict'
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'

/** Encode script data without allowing an HTML closing tag to end the enclosing script. */
function scriptValue(value) {
  return JSON.stringify(value).replaceAll('<', '\\u003c')
}

const project = fileURLToPath(new URL('../../', import.meta.url))
const output = join(project, 'dist/chromium')
const originalHtml = readFileSync(join(output, 'sidebar/index.html'), 'utf8')
const htmlWithoutScripts = originalHtml.replace(/<script\b[^>]*src=[^>]*><\/script>/g, '')
const panelHtml = htmlWithoutScripts.replace(/<link\b[^>]*>/g, '')
const panelScriptPaths = []
for (const match of originalHtml.matchAll(/<script\b[^>]*src="\/?([^"]+)"/g)) panelScriptPaths.push(match[1])
/** Read one of the panel's built scripts, such as the shared chunk or the panel entry. */
function readPanelScript(path) { return readFileSync(join(output, path), 'utf8') }
const panelCode = panelScriptPaths.map(readPanelScript).join('\n;\n')
const panelCss = readFileSync(join(output, 'sidebar/index.css'), 'utf8')
const backgroundCode = readFileSync(join(output, 'background/service_worker.js'), 'utf8')
const scenario = readFileSync(new URL('./scenario.js', import.meta.url), 'utf8')
const directory = mkdtempSync(join(tmpdir(), 'browsercurl-history-'))

try {
  const html = `<!doctype html><html><body><pre id="result">Running</pre><script>
    const panelHtml = ${scriptValue(panelHtml)};
    const panelCode = ${scriptValue(panelCode)};
    const panelCss = ${scriptValue(panelCss)};
    const backgroundCode = ${scriptValue(backgroundCode)};
    ${scenario}
  </script></body></html>`
  const path = join(directory, 'check.html')
  writeFileSync(path, html)
  const result = spawnSync(process.env.CHROME_BINARY || 'google-chrome', [
    '--headless', '--no-sandbox', '--disable-gpu', '--disable-extensions',
    '--no-first-run', '--no-default-browser-check', '--allow-file-access-from-files',
    `--user-data-dir=${join(directory, 'profile')}`, '--dump-dom', '--virtual-time-budget=15000',
    `file://${path}`
  ], {encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024})
  if (result.error) throw result.error
  const report = result.stdout.match(/<pre id="result"[^>]*>([\s\S]*?)<\/pre>/)?.[1]
  assert.equal(result.status, 0, result.stderr)
  assert.match(report || '', /^PASS:/, report || result.stderr)
  console.log(report)
} finally {
  rmSync(directory, {recursive: true, force: true})
}
