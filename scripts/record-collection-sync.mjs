/** Record a paced walkthrough of real collection backups, draft preservation, and background recovery. */
import assert from 'node:assert/strict'
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {setTimeout as pause} from 'node:timers/promises'
import {chromium, expect} from '@playwright/test'
import {TestHttpServer} from '../e2e/http-server.mjs'

/** The isolated output folder for the recording, screenshots, and timestamped assertions. */
const output = fileURLToPath(new URL('../.playwright/collection-sync-evidence/', import.meta.url))
/** The production extension used by the walkthrough. Build it before running this script. */
const extensionPath = fileURLToPath(new URL('../dist/chromium/', import.meta.url))

/** Build an evidence dashboard around the real sidebar document, without changing product markup or scripts. */
function dashboard(extensionId) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Collection disk sync: test evidence</title>
  <style>
    *{box-sizing:border-box}body{margin:0;background:#eef1f5;color:#162333;font:15px system-ui,sans-serif}
    header{height:120px;padding:18px 24px;background:#142539;color:white}header h1{margin:0 0 7px;font-size:23px}
    header p{margin:0;color:#d1e4f5;font-size:14px}.badge{float:right;padding:6px 10px;background:#30465e;border-radius:6px;font-size:12px}
    main{display:grid;grid-template-columns:620px 1fr;gap:18px;padding:18px;height:840px}
    #sidebar-host{height:100%;border:1px solid #cbd5df;border-radius:9px;background:white;overflow:hidden}
    iframe{width:100%;height:100%;border:0}#closed{padding:70px 32px;line-height:1.8;font-size:21px}
    aside{min-width:0;overflow:hidden}.card{background:white;padding:15px 17px;border:1px solid #cbd5df;border-radius:9px;margin-bottom:12px}
    h2{font-size:16px;margin:0 0 9px}#result{font-weight:700;color:#1a7045;min-height:40px;line-height:1.4}
    dl{margin:0}dt{font-size:12px;color:#526579;margin-top:9px}dd{margin:3px 0 0;overflow-wrap:anywhere;font:13px ui-monospace,monospace}
    #file-json{margin:0;max-height:328px;overflow:auto;font:12px/1.45 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
    #file-name{font-size:11px;color:#526579;overflow-wrap:anywhere;margin:0 0 9px}#checks{font-size:12px;color:#526579;margin:8px 0 0}
  </style></head><body>
    <header><span class="badge">Chromium extension + real file writes</span><h1 id="chapter">Saved-only collection backups</h1>
    <p id="description">Folder selection is simulated with a browser-managed directory. The production sidebar, storage, background, and file streams are real.</p></header>
    <main><section id="sidebar-host"><iframe id="sidebar" title="Production browsercurl sidebar" src="chrome-extension://${extensionId}/sidebar/index.html"></iframe></section>
    <aside><section class="card"><h2>Test observation</h2><div id="result">Starting the walkthrough…</div><p id="checks">0 checkpoints passed</p></section>
    <section class="card"><h2>Current draft versus saved data</h2><dl><dt>Current request editor</dt><dd id="draft-url">Loading…</dd><dt>Saved collection request</dt><dd id="saved-url">No collection yet</dd><dt>Request in the disk file</dt><dd id="disk-url">No file yet</dd><dt>Collection name on disk</dt><dd id="disk-name">No file yet</dd></dl></section>
    <section class="card"><h2>Actual Postman JSON read from disk</h2><p id="file-name">No backup yet</p><pre id="file-json">Choose a folder and enable automatic sync.</pre></section></aside></main>
    </body></html>`
}

/** Wait for the real application to finish restoring the embedded sidebar. */
async function sidebarReady(page) {
  const frame = page.frameLocator('#sidebar')
  await expect(frame.locator('#root')).not.toHaveAttribute('inert', '')
  return frame
}

/** Read a consistent native disk snapshot and the real collection store in the dashboard's extension origin. */
async function observe() {
  /** Keep a background replacement from invalidating this file read halfway through. */
  async function snapshot() {
    const items = await chrome.storage.local.get(null)
    const index = items['browsercurl.collectionIndex'] ?? []
    const collection = index.length ? items['browsercurl.collection.' + index[0].id] : undefined
    const root = await navigator.storage.getDirectory()
    const directory = await root.getDirectoryHandle('browsercurl-backups', {create: true})
    const files = []
    for await (const [name, handle] of directory.entries()) {
      if (!name.endsWith('.postman_collection.json')) continue
      const file = await handle.getFile()
      const text = await file.text()
      files.push({name, text})
    }
    const disk = files.length ? JSON.parse(files[0].text) : undefined
    const iframe = document.querySelector('#sidebar')
    const draftUrl = iframe?.contentDocument?.querySelector('#request-url')?.value
    return {collection, disk, files, draftUrl, settings: items['browsercurl.diskSync']}
  }
  return navigator.locks.request('browsercurl.diskSync.write', {mode: 'shared'}, snapshot)
}

/** Render values read from native file storage beside the actual sidebar UI. */
function renderObservation(data) {
  document.querySelector('#draft-url').textContent = data.draftUrl ?? 'Sidebar closed. The draft remains in browser storage.'
  document.querySelector('#saved-url').textContent = data.collection?.requests[0]?.editor?.url ?? 'No saved request yet'
  document.querySelector('#disk-url').textContent = data.disk?.item[0]?.request?.url?.raw ?? 'No disk export yet'
  document.querySelector('#disk-name').textContent = data.disk?.info?.name ?? 'No disk export yet'
  document.querySelector('#file-name').textContent = data.files[0]?.name ?? 'No disk file yet'
  document.querySelector('#file-json').textContent = data.files[0]?.text ?? 'Waiting for the first backup.'
}

/** Run the captioned recording and close the server, browser, and temporary profile even after failure. */
async function main() {
  await mkdir(output, {recursive: true})
  const profilePrefix = join(tmpdir(), 'browsercurl-sync-recording-')
  const profile = await mkdtemp(profilePrefix)
  const api = new TestHttpServer()
  let context
  let page
  const checkpoints = []
  const startedAt = Date.now()
  try {
    await api.start()
    const viewport = {width: 1280, height: 960}
    const videoDirectory = join(output, 'raw')
    const recordVideo = {dir: videoDirectory, size: viewport}
    const args = [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
    const browserOptions = {channel: 'chromium', headless: true, viewport, recordVideo, args}
    context = await chromium.launchPersistentContext(profile, browserOptions)
    let [worker] = context.serviceWorkers()
    if (!worker) worker = await context.waitForEvent('serviceworker')
    const extensionId = new URL(worker.url()).hostname
    page = await context.newPage()
    await page.goto(`chrome-extension://${extensionId}/options/index.html`)
    await expect(page.locator('#settings-form')).not.toHaveAttribute('inert', '')
    await page.setContent(dashboard(extensionId))
    let frame = await sidebarReady(page)

    /** Show the next test action before operating the real UI. */
    async function caption(title, description) {
      /** Set readable narration text in the test dashboard only. */
      function showCaption({title, description}) {
        document.querySelector('#chapter').textContent = title
        document.querySelector('#description').textContent = description
      }
      await page.evaluate(showCaption, {title, description})
      console.log(title)
    }

    /** Refresh real observations and give a reviewer time to read each confirmed result. */
    async function checkpoint(result, holdMs = 8000) {
      const data = await page.evaluate(observe)
      await page.evaluate(renderObservation, data)
      const elapsedMs = Date.now() - startedAt
      const elapsedSeconds = elapsedMs / 1000
      const seconds = Math.round(elapsedSeconds)
      checkpoints.push({seconds, result})
      /** Mark a checkpoint passed only after its assertions complete. */
      function showResult({result, count}) {
        document.querySelector('#result').textContent = 'PASS — ' + result
        document.querySelector('#checks').textContent = count + ' checkpoints passed. Folder picker simulated; native file writes.'
      }
      await page.evaluate(showResult, {result, count: checkpoints.length})
      await pause(holdMs)
    }

    /** Save review images only inside the Playwright evidence directory. */
    async function screenshot(name) {
      const path = join(output, name)
      await page.screenshot({path})
    }

    /** Poll actual exported JSON rather than trusting a success message. */
    async function diskUrl() {
      const data = await page.evaluate(observe)
      return data.disk?.item[0]?.request?.url?.raw
    }

    /** Poll the collection name inside the actual disk export. */
    async function diskName() {
      const data = await page.evaluate(observe)
      return data.disk?.info?.name
    }

    /** Open the saved collection controls in the current sidebar document. */
    async function openSync() {
      await frame.locator('#show-collections').click()
      await frame.locator('.disk-sync summary').click()
      await expect(frame.locator('#disk-sync-form')).not.toHaveAttribute('inert', '')
    }

    /** Rename a real collection through its normal inline editor. */
    async function rename(name, replacement) {
      const label = frame.locator('[data-collection-name]', {hasText: name})
      const rows = frame.locator('.collection-row')
      const row = rows.filter({has: label})
      await row.getByRole('button', {name: 'Rename', exact: true}).click()
      const input = row.getByRole('textbox', {name: 'Name', exact: true})
      await input.fill(replacement)
      await input.press('Enter')
      await expect(frame.locator('[data-collection-name]', {hasText: replacement})).toBeVisible()
    }

    await caption('01 / Real extension, saved-only backups', 'This continuous recording uses the production extension. Folder selection and later disk failures are explicitly simulated.')
    assert.equal(await frame.locator('#request-url').inputValue(), '')
    await checkpoint('The real sidebar starts with an empty draft.')

    await caption('02 / Save a request into a collection', 'Save creates the collection. Running a request will not replace its saved values.')
    await frame.locator('#request-url').fill(`${api.origin}/echo?version=saved`)
    await frame.locator('#save-request').click()
    await frame.locator('#save-request-name').fill('List widgets')
    await frame.locator('#new-collection-name').fill('Widget API')
    await pause(3000)
    await frame.locator('#confirm-save-as').click()
    await expect(frame.locator('#save-as-dialog')).toBeHidden()
    await checkpoint('A named request now exists in the saved collection.')

    await caption('03 / Choose which collections to back up', 'Automatic sync is off by default. This walkthrough enables all collections in a user-approved test directory.')
    await openSync()
    await expect(frame.locator('#disk-sync-enabled')).not.toBeChecked()
    await checkpoint('Sync is opt-in. No interval controls are present.')

    /** Substitute only the native picker; the returned directory and file streams are real. */
    async function installPicker() {
      /** Return a real browser-managed disk directory for the recorded test. */
      window.showDirectoryPicker = async function chooseTestDirectory() {
        const root = await navigator.storage.getDirectory()
        return root.getDirectoryHandle('browsercurl-backups', {create: true})
      }
    }
    await frame.locator('body').evaluate(installPicker)
    await frame.locator('#choose-sync-folder').click()
    await frame.locator('#disk-sync-enabled').check()
    await checkpoint('The selected test directory is visible. Changes are not enabled until Save sync settings.')

    await caption('04 / Enable automatic disk sync', 'The first backup writes the saved collection as Postman JSON. The right panel reads that actual file.')
    await frame.locator('#save-disk-sync').click()
    await expect.poll(diskUrl).toBe(`${api.origin}/echo?version=saved`)
    const first = await page.evaluate(observe)
    const originalFileName = first.files[0].name
    await checkpoint('The initial disk JSON contains the saved request.')

    await caption('05 / Run an edited draft', 'The HTTP request uses the edited URL. The saved collection and disk backup retain the earlier saved URL.')
    await frame.locator('#close-collections').click()
    await frame.locator('#request-url').fill(`${api.origin}/echo?version=draft`)
    await frame.locator('#send-request').click()
    await expect(frame.locator('#response-stats')).toBeVisible()
    await expect(frame.locator('#send-request')).toHaveText('Send')
    assert.equal(api.requests[0].url, '/echo?version=draft')
    const afterRun = await page.evaluate(observe)
    assert.equal(afterRun.collection.requests[0].editor.url, first.collection.requests[0].editor.url)
    assert.equal(afterRun.files[0].text, first.files[0].text)
    await checkpoint('Run sent the draft. Saved collection and disk JSON are unchanged.', 11000)
    await screenshot('draft-versus-saved.png')

    await caption('06 / Reopen the sidebar without saving the draft', 'Removing the real sidebar document fires its normal close lifecycle. Reopening restores the unsaved draft.')
    /** Tear down the actual sidebar document while leaving the evidence viewer alive. */
    function closeSidebar() {
      document.querySelector('#sidebar').remove()
      const message = document.createElement('div')
      message.id = 'closed'
      message.textContent = 'Sidebar closed. The background remains available and the draft stays in browser storage.'
      document.querySelector('#sidebar-host').append(message)
    }
    await page.evaluate(closeSidebar)
    await checkpoint('Closing the sidebar does not promote draft edits into the collection.', 5000)
    /** Recreate the same production sidebar document with its normal startup and restore behavior. */
    function reopenSidebar(extensionId) {
      const iframe = document.createElement('iframe')
      iframe.id = 'sidebar'
      iframe.title = 'Production browsercurl sidebar'
      iframe.src = `chrome-extension://${extensionId}/sidebar/index.html`
      document.querySelector('#sidebar-host').replaceChildren(iframe)
    }
    await page.evaluate(reopenSidebar, extensionId)
    frame = await sidebarReady(page)
    await expect(frame.locator('#request-url')).toHaveValue(`${api.origin}/echo?version=draft`)
    assert.equal(await diskUrl(), `${api.origin}/echo?version=saved`)
    await checkpoint('The unsaved draft survives reopening. The disk file still contains the saved version.')

    await caption('07 / Save promotes the draft into the collection', 'Only explicit Save changes the collection request and triggers a changed disk export.')
    await frame.locator('#save-request').click()
    await expect.poll(diskUrl).toBe(`${api.origin}/echo?version=draft`)
    await checkpoint('Draft, saved collection, and disk JSON now agree after Save.')

    await caption('08 / Rename while keeping the same disk filename', 'A collection rename changes JSON metadata. The backup continues to replace its original file.')
    await openSync()
    await rename('Widget API', 'Renamed Widget API')
    await expect.poll(diskName).toBe('Renamed Widget API')
    const renamed = await page.evaluate(observe)
    assert.equal(renamed.files[0].name, originalFileName)
    await checkpoint('Rename updated the JSON without creating another file.')

    await caption('09 / An unchanged export is not rewritten', 'Retry checks saved data. A matching completed fingerprint skips the file write.')
    /** Count real successful file commits in the background realm. */
    function countWrites() {
      globalThis.evidenceWrites = 0
      const close = FileSystemWritableFileStream.prototype.close
      /** Retain the native commit and count it only after success. */
      FileSystemWritableFileStream.prototype.close = async function countCommit() {
        await close.call(this)
        globalThis.evidenceWrites++
      }
    }
    await worker.evaluate(countWrites)
    await frame.locator('#retry-disk-sync').click()
    await expect(frame.locator('#disk-sync-status')).toContainText('Last synced:')
    /** Read the native commit counter for the unchanged export check. */
    function writeCount() { return globalThis.evidenceWrites }
    assert.equal(await worker.evaluate(writeCount), 0)
    await checkpoint('Retry checked the saved collection and performed zero file commits.')

    await caption('10 / Disable automatic backups', 'An explicit settings change pauses backups. Collection edits remain safely saved in the browser.')
    await frame.locator('#disk-sync-enabled').uncheck()
    await frame.locator('#save-disk-sync').click()
    await expect(frame.locator('#disk-sync-status')).toHaveText('Automatic disk sync is off.')
    await rename('Renamed Widget API', 'Paused Widget API')
    await pause(1200)
    assert.equal(await diskName(), 'Renamed Widget API')
    await checkpoint('The browser collection changed while the disabled disk backup stayed unchanged.')

    await caption('11 / Re-enable and catch up', 'Re-enabling uses the same approved directory and original filename to back up the saved changes.')
    await frame.locator('#disk-sync-enabled').check()
    await frame.locator('#save-disk-sync').click()
    await expect.poll(diskName).toBe('Paused Widget API')
    await checkpoint('The paused saved changes reached the existing disk file.')

    await caption('12 / Inject a disk-full failure', 'TEST INJECTION: the next native stream write rejects. The previous complete disk file must survive.')
    /** Inject one recoverable disk error without replacing collection data or file handles. */
    function injectFailure() {
      globalThis.evidenceFailWrites = true
      const write = FileSystemWritableFileStream.prototype.write
      /** Reject temporary-file writes until the test restores the native operation. */
      FileSystemWritableFileStream.prototype.write = function failWrite(data) {
        if (globalThis.evidenceFailWrites) {
          const error = new DOMException('Injected disk-full error', 'QuotaExceededError')
          return Promise.reject(error)
        }
        return write.call(this, data)
      }
    }
    await worker.evaluate(injectFailure)
    await rename('Paused Widget API', 'Recovered Widget API')
    await expect(frame.locator('#disk-sync-status')).toContainText('Sync failed.')
    assert.equal(await diskName(), 'Paused Widget API')
    await checkpoint('The failure is visible and the previous complete disk JSON remains intact.', 10000)
    await screenshot('write-failure.png')

    await caption('13 / Retry the unfinished backup', 'TEST INJECTION REMOVED: Retry writes the saved collection revision that previously failed.')
    /** Restore successful writes while retaining the failed revision for the normal retry path. */
    function restoreWrites() { globalThis.evidenceFailWrites = false }
    await worker.evaluate(restoreWrites)
    await frame.locator('#retry-disk-sync').click()
    await expect.poll(diskName).toBe('Recovered Widget API')
    await checkpoint('Retry recovered the latest saved collection using the same disk file.')

    await caption('14 / Close the sidebar during an active export', 'TEST INJECTION: hold one write until the sidebar closes, then let the background finish it.')
    /** Hold one native write to prove the background does not depend on the originating document. */
    function holdNextWrite() {
      globalThis.evidenceHoldWrite = true
      const write = FileSystemWritableFileStream.prototype.write
      /** Pause a real write without changing its content or commit behavior. */
      FileSystemWritableFileStream.prototype.write = async function heldWrite(data) {
        if (globalThis.evidenceHoldWrite) {
          globalThis.evidenceHoldWrite = false
          /** Expose a test-only resolver for the paused native operation. */
          function hold(resolve) { globalThis.evidenceReleaseWrite = resolve }
          await new Promise(hold)
        }
        return write.call(this, data)
      }
    }
    await worker.evaluate(holdNextWrite)
    await rename('Recovered Widget API', 'Background completed API')
    /** Check that a native stream is waiting before closing the sidebar. */
    function writeIsHeld() { return typeof globalThis.evidenceReleaseWrite === 'function' }
    /** Poll the background hold without reading a file whose write is intentionally blocked. */
    async function held() { return worker.evaluate(writeIsHeld) }
    await expect.poll(held).toBe(true)
    await page.evaluate(closeSidebar)
    await pause(2500)
    /** Release the write after its originating sidebar document is gone. */
    function releaseWrite() { globalThis.evidenceReleaseWrite() }
    await worker.evaluate(releaseWrite)
    await expect.poll(diskName).toBe('Background completed API')
    await checkpoint('The background completed the export after the sidebar document closed.', 10000)
    await screenshot('background-completion.png')

    await caption('15 / Final saved-only backup checks', 'Reopening restores the saved request. The backup is current, complete, and still uses its original filename.')
    await page.evaluate(reopenSidebar, extensionId)
    frame = await sidebarReady(page)
    await openSync()
    await expect(frame.locator('#disk-sync-status')).toContainText('Last synced:')
    const final = await page.evaluate(observe)
    assert.equal(final.files.length, 1)
    assert.equal(final.files[0].name, originalFileName)
    assert.equal(final.collection.requests[0].editor.url, final.disk.item[0].request.url.raw)
    await checkpoint('Saved-only backups, draft preservation, unchanged-file skipping, Retry, and background completion passed.', 12000)
    await screenshot('final.png')

    const video = page.video()
    await page.close()
    page = undefined
    const videoPath = join(output, 'collection-disk-sync.webm')
    await video.saveAs(videoPath)
    const elapsedMs = Date.now() - startedAt
    const elapsedSeconds = Math.round(elapsedMs / 1000)
    const manifest = {videoPath, elapsedSeconds,
      limits: ['Native directory picker simulated with OPFS.', 'Production sidebar document hosted in a test iframe.',
        'Disk-full and held-write failures injected explicitly.', 'Native browser sidebar frame and Firefox runtime not covered.'],
      checkpoints}
    const manifestPath = join(output, 'manifest.json')
    const manifestJson = JSON.stringify(manifest, null, 2)
    await writeFile(manifestPath, manifestJson + '\n')
    console.log(JSON.stringify(manifest, null, 2))
  } finally {
    try {
      await context?.close()
    } finally {
      try { await api.close() } finally { await rm(profile, {recursive: true, force: true}) }
    }
  }
}

await main()
