/** Real extension backup workflows with a simulated picker, real disk streams, and the production background worker. */
import {readFile} from 'node:fs/promises'
import {test, expect} from './fixtures.mjs'
import {click, fill, send, storedCollections, storedWorkspace} from './panel-helpers.mjs'

/** Return a real persistent directory instead of opening the native operating system picker. */
async function installDirectoryPicker(panel) {
  /** Install a picker substitute inside the extension's own origin. */
  function installPicker() {
    /** Select a browser-managed directory whose handles and writable streams are real. */
    window.showDirectoryPicker = async function selectDirectory(options) {
      window.pickerOptions = options
      const root = await navigator.storage.getDirectory()
      return root.getDirectoryHandle('exports', {create: true})
    }
  }
  await panel.evaluate(installPicker)
}

/** Read complete exports while background writers wait, avoiding invalidated file snapshots. */
async function diskFiles(panel) {
  /** Read disk data independently of the production worker's success status. */
  async function readFiles() {
    /** Hold a shared lock until every file in this committed snapshot is read. */
    async function readSnapshot() {
      const root = await navigator.storage.getDirectory()
      const directory = await root.getDirectoryHandle('exports', {create: true})
      const files = {}
      for await (const [name, handle] of directory.entries()) {
        if (!name.endsWith('.postman_collection.json')) continue
        const file = await handle.getFile()
        files[name] = await file.text()
      }
      return files
    }
    return navigator.locks.request('browsercurl.diskSync.write', {mode: 'shared'}, readSnapshot)
  }
  return panel.evaluate(readFiles)
}

/** Read shared configuration and completed fingerprints through real extension storage. */
async function syncSettings(panel) {
  /** Return the production backup state without importing any page modules. */
  async function readSettings() {
    const items = await chrome.storage.local.get('browsercurl.diskSync')
    return items['browsercurl.diskSync']
  }
  return panel.evaluate(readSettings)
}

/** Return names inside actual disk JSON for polling across sidebar and worker lifetimes. */
async function diskNames(panel) {
  const files = await diskFiles(panel)
  const names = []
  for (const text of Object.values(files)) names.push(JSON.parse(text).info.name)
  return names.sort()
}

/** Ask the real background listener to drain saved changes from any extension page. */
async function flushBackups(panel) {
  /** Await a normal extension message, including the worker's async completion reply. */
  async function request() {
    const result = await chrome.runtime.sendMessage({type: 'sync-collections-to-disk'})
    if (result.error) throw new Error(result.error)
  }
  await panel.evaluate(request)
}

/** Open collection browsing and a separate Settings page with ready sync controls. */
async function openSync(panel) {
  if (!await panel.locator('#collections-dialog').isVisible()) await click(panel, '#show-collections')
  const settingsPage = await panel.context().newPage()
  const settingsUrl = new URL('/options/index.html#disk-sync-settings', panel.url())
  await settingsPage.goto(settingsUrl.href)
  await expect(settingsPage.locator('#disk-sync-form')).not.toHaveAttribute('inert', '')
  return settingsPage
}

/** Create a saved collection through normal controls. */
async function createCollection(panel, name) {
  await click(panel, '#new-collection')
  await fill(panel, '#collection-item-name', name)
  await click(panel, '#confirm-collection-item')
  await expect(panel.locator('[data-collection-name]', {hasText: name})).toBeVisible()
}

/** Enable an initial backup using a real directory handle stored in IndexedDB. */
async function enableSync(panel) {
  await installDirectoryPicker(panel)
  await click(panel, '#choose-sync-folder')
  await expect(panel.locator('#disk-sync-folder')).toHaveText('exports')
  await panel.locator('#disk-sync-enabled').check()
  await click(panel, '#save-disk-sync')
  await expect(panel.locator('#disk-sync-status')).toContainText('Last synced:')
}

/** Rename a collection through its inline editor and wait for the storage-driven tree refresh. */
async function renameCollection(panel, name, replacement) {
  const label = panel.locator('[data-collection-name]', {hasText: name})
  const rows = panel.locator('.collection-row')
  const row = rows.filter({has: label})
  await row.getByRole('button', {name: 'Rename', exact: true}).click()
  const input = row.getByRole('textbox', {name: 'Name', exact: true})
  await input.fill(replacement)
  await input.press('Enter')
  await expect(panel.locator('[data-collection-name]', {hasText: replacement})).toBeVisible()
}

/** Count real background file commits without changing stream behavior. */
async function countWorkerWrites(extension) {
  const [worker] = extension.context.serviceWorkers()
  /** Instrument the worker realm, where the production writes now run. */
  function countWrites() {
    globalThis.syncWrites = 0
    const close = FileSystemWritableFileStream.prototype.close
    /** Count successful close attempts while retaining the browser's commit operation. */
    FileSystemWritableFileStream.prototype.close = function countCommit() {
      globalThis.syncWrites++
      return close.call(this)
    }
  }
  await worker.evaluate(countWrites)
  return worker
}

/** Observe the background instrumentation count. */
function workerWriteCount() { return globalThis.syncWrites }

/** Selected changes trigger writes, unrelated changes do not, and names remain stable after reconfiguration. */
async function selectedCollectionChanges({extension}) {
  const panel = await extension.openPanel()
  const settingsPage = await openSync(panel)
  await createCollection(panel, 'First API')
  await createCollection(panel, 'Second API')
  await settingsPage.locator('#disk-sync-scope').selectOption('selected')
  await settingsPage.locator('#disk-sync-collections').getByLabel('First API', {exact: true}).check()
  await enableSync(settingsPage)
  const initial = await diskFiles(panel)
  const [fileName] = Object.keys(initial)
  expect(Object.keys(initial)).toHaveLength(1)
  const worker = await countWorkerWrites(extension)
  await renameCollection(panel, 'First API', 'Renamed API')
  /** Observe an event-triggered export without forcing the worker to run. */
  async function selectedNames() { return diskNames(panel) }
  await expect.poll(selectedNames).toEqual(['Renamed API'])
  expect(await worker.evaluate(workerWriteCount)).toBe(1)
  await renameCollection(panel, 'Second API', 'Unselected changes')
  await flushBackups(panel)
  expect(await worker.evaluate(workerWriteCount)).toBe(1)
  await click(settingsPage, '#choose-sync-folder')
  await click(settingsPage, '#save-disk-sync')
  await flushBackups(panel)
  const afterReselection = await diskFiles(panel)
  expect(Object.keys(afterReselection)).toEqual([fileName])
  expect(await worker.evaluate(workerWriteCount)).toBe(1)
  await settingsPage.locator('#disk-sync-enabled').uncheck()
  await click(settingsPage, '#save-disk-sync')
  await expect(settingsPage.locator('#disk-sync-status')).toHaveText('Automatic disk sync is off.')
  await renameCollection(panel, 'Renamed API', 'Disabled edits')
  await flushBackups(panel)
  expect(await diskFiles(panel)).toEqual(afterReselection)
}
test('backs up selected changes, skips unchanged exports, and preserves filenames', selectedCollectionChanges)

/** All collections includes later creations and nested imports, and deletion keeps the disk copy. */
async function allCollectionChanges({extension}) {
  const panel = await extension.openPanel()
  const settingsPage = await openSync(panel)
  await createCollection(panel, 'Original')
  await enableSync(settingsPage)
  await createCollection(panel, 'Added later')
  const source = await readFile(new URL('./data/postman-v2.1.json', import.meta.url), 'utf8')
  const buffer = Buffer.from(source)
  const input = panel.locator('#collection-file')
  await input.setInputFiles({name: 'widgets.json', mimeType: 'application/json', buffer})
  /** Observe imported and newly created collections without an explicit sync command. */
  async function names() { return diskNames(panel) }
  await expect.poll(names).toEqual(['Added later', 'Imported Widget API', 'Original'])
  const files = await diskFiles(panel)
  const importedText = Object.values(files).find(isImportedCollection)
  const imported = JSON.parse(importedText)
  expect(imported.item[0].item[0].item[0].name).toBe('Create widget')
  const label = panel.locator('[data-collection-name]', {hasText: 'Added later'})
  const rows = panel.locator('.collection-row')
  await rows.filter({has: label}).getByRole('button', {name: 'Delete', exact: true}).click()
  await flushBackups(panel)
  expect(await diskFiles(panel)).toEqual(files)
}
/** Locate the imported fixture by its collection metadata. */
function isImportedCollection(text) { return JSON.parse(text).info.name === 'Imported Widget API' }
test('backs up new and imported collections while retaining deleted collections on disk', allCollectionChanges)

/** Changes arriving during a write must still reach disk after the last sidebar closes. */
async function finishAfterSidebarClose({extension}) {
  const panel = await extension.openPanel()
  const settingsPage = await openSync(panel)
  await createCollection(panel, 'Before close')
  await enableSync(settingsPage)
  const observer = await extension.openOptions()
  const [worker] = extension.context.serviceWorkers()
  /** Pause the next native write until the test closes the sidebar and explicitly releases it. */
  function holdNextWrite() {
    const write = FileSystemWritableFileStream.prototype.write
    globalThis.holdNextWrite = true
    /** Hold one write so another collection revision arrives while a batch is active. */
    FileSystemWritableFileStream.prototype.write = async function heldWrite(data) {
      if (globalThis.holdNextWrite) {
        globalThis.holdNextWrite = false
        /** Expose a resolver only to this isolated test's background realm. */
        function hold(resolve) { globalThis.releaseSyncWrite = resolve }
        await new Promise(hold)
      }
      return write.call(this, data)
    }
  }
  await worker.evaluate(holdNextWrite)
  await renameCollection(panel, 'Before close', 'First pending edit')
  /** Wait until a real writable stream is held before creating a newer saved revision. */
  function writeIsHeld() { return typeof globalThis.releaseSyncWrite === 'function' }
  /** Observe the worker hold without importing production modules. */
  async function held() { return worker.evaluate(writeIsHeld) }
  await expect.poll(held).toBe(true)
  await renameCollection(panel, 'First pending edit', 'Latest edit before close')
  await panel.close()
  /** Release the background write after the originating document is gone. */
  function releaseWrite() { globalThis.releaseSyncWrite() }
  await worker.evaluate(releaseWrite)
  /** Read committed data from an options page that owns no sync scheduler. */
  async function names() { return diskNames(observer) }
  await expect.poll(names).toEqual(['Latest edit before close'])
  const settings = await syncSettings(observer)
  expect(settings.syncing).toBe(false)
  expect(settings.error).toBeUndefined()
}
test('finishes pending and newer saved changes after the sidebar closes', finishAfterSidebarClose)

/** Fail disk writes in the background, where real directory and stream operations are performed. */
async function failWorkerWrites(extension) {
  const [worker] = extension.context.serviceWorkers()
  /** Install a recoverable failure before a native stream can commit its temporary file. */
  function failWrites() {
    globalThis.failSyncWrites = true
    const write = FileSystemWritableFileStream.prototype.write
    /** Keep the previous disk file intact while simulating a full disk. */
    FileSystemWritableFileStream.prototype.write = function failedWrite(data) {
      if (globalThis.failSyncWrites) {
        const error = new DOMException('Disk full', 'QuotaExceededError')
        return Promise.reject(error)
      }
      return write.call(this, data)
    }
  }
  await worker.evaluate(failWrites)
  return worker
}

/** Failed commits keep their earlier fingerprint, then recover through an explicit retry. */
async function retryFailedWrite({extension}) {
  const panel = await extension.openPanel()
  const settingsPage = await openSync(panel)
  await createCollection(panel, 'Safe copy')
  await enableSync(settingsPage)
  const before = await diskFiles(panel)
  const completed = await syncSettings(panel)
  const worker = await failWorkerWrites(extension)
  await renameCollection(panel, 'Safe copy', 'Edited after backup')
  await expect(settingsPage.locator('#disk-sync-status')).toContainText('Sync failed.')
  expect(await diskFiles(panel)).toEqual(before)
  expect((await syncSettings(panel)).fingerprints).toEqual(completed.fingerprints)
  /** Restore native writes without replacing the worker or its source data. */
  function restoreWrites() { globalThis.failSyncWrites = false }
  await worker.evaluate(restoreWrites)
  await click(settingsPage, '#retry-disk-sync')
  await expect(settingsPage.locator('#disk-sync-status')).toContainText('Last synced:')
  expect(await diskNames(panel)).toEqual(['Edited after backup'])
}
test('keeps previous files on write failure and retries unfinished backups', retryFailedWrite)

/** Progress-storage failures must reach the UI even when the worker cannot save its error state. */
async function failedProgressStorage({extension}) {
  const panel = await extension.openPanel()
  const settingsPage = await openSync(panel)
  await createCollection(panel, 'Stored backup')
  await enableSync(settingsPage)
  const before = await diskFiles(panel)
  const [worker] = extension.context.serviceWorkers()
  /** Fail a progress write while preserving the actual collection edit and its recoverable source data. */
  function failProgress() {
    globalThis.failSyncProgress = true
    const set = chrome.storage.local.set.bind(chrome.storage.local)
    /** Reject worker progress storage until the test restores the browser API. */
    chrome.storage.local.set = function failedProgressWrite(items, callback) {
      if (globalThis.failSyncProgress && items['browsercurl.diskSync']) throw new Error('Progress storage unavailable')
      return set(items, callback)
    }
  }
  await worker.evaluate(failProgress)
  await renameCollection(panel, 'Stored backup', 'Pending storage recovery')
  await expect(settingsPage.locator('#disk-sync-status')).toContainText('Could not read or save sync progress')
  expect(await diskFiles(panel)).toEqual(before)
  /** Allow progress writes again while retaining the collection revision that needs a backup. */
  function restoreProgress() { globalThis.failSyncProgress = false }
  await worker.evaluate(restoreProgress)
  await click(settingsPage, '#retry-disk-sync')
  await expect(settingsPage.locator('#disk-sync-status')).toContainText('Last synced:')
  expect(await diskNames(panel)).toEqual(['Pending storage recovery'])
}
test('shows progress-storage failures and recovers the saved changes through Retry', failedProgressStorage)

/** Saved source data and completed fingerprints recover a failed export across a browser restart. */
async function recoverAfterRestart({extension}) {
  let panel = await extension.openPanel()
  const settingsPage = await openSync(panel)
  await createCollection(panel, 'Before restart')
  await enableSync(settingsPage)
  const settings = await syncSettings(panel)
  await failWorkerWrites(extension)
  await renameCollection(panel, 'Before restart', 'Pending across restart')
  await expect(settingsPage.locator('#disk-sync-status')).toContainText('Sync failed.')
  await extension.restart()
  panel = await extension.openPanel()
  /** Observe startup recovery without selecting the folder again or saving the collection again. */
  async function names() { return diskNames(panel) }
  await expect.poll(names).toEqual(['Pending across restart'])
  expect((await syncSettings(panel)).directoryKey).toBe(settings.directoryKey)
  expect((await syncSettings(panel)).fileNames).toEqual(settings.fileNames)
}
test('recovers unfinished backups after restarting the browser', recoverAfterRestart)

/** Lost permission must never open an automatic prompt or overwrite an existing disk file. */
async function recoverFolderPermission({extension}) {
  const panel = await extension.openPanel()
  const settingsPage = await openSync(panel)
  await createCollection(panel, 'Permission test')
  await enableSync(settingsPage)
  const before = await diskFiles(panel)
  const [worker] = extension.context.serviceWorkers()
  /** Change only permission responses; directory handles and storage remain native. */
  function revokePermission() {
    globalThis.denySyncPermission = true
    const query = FileSystemHandle.prototype.queryPermission
    /** Simulate lost folder access during an automatic background check. */
    FileSystemHandle.prototype.queryPermission = function deniedPermission(options) {
      if (globalThis.denySyncPermission) return Promise.resolve('prompt')
      return query.call(this, options)
    }
    /** Automatic backup must leave permission prompts to the user's folder selection. */
    FileSystemHandle.prototype.requestPermission = function unexpectedPrompt() { throw new Error('Unexpected prompt') }
  }
  await worker.evaluate(revokePermission)
  await renameCollection(panel, 'Permission test', 'Restored permission')
  await expect(settingsPage.locator('#disk-sync-status')).toContainText('Folder access is required')
  expect(await diskFiles(panel)).toEqual(before)
  /** Allow the user-selected directory to pass the next background permission query. */
  function restorePermission() { globalThis.denySyncPermission = false }
  await worker.evaluate(restorePermission)
  await click(settingsPage, '#choose-sync-folder')
  await click(settingsPage, '#save-disk-sync')
  await flushBackups(panel)
  expect(await diskNames(panel)).toEqual(['Restored permission'])
  const after = await diskFiles(panel)
  expect(Object.keys(after)).toEqual(Object.keys(before))
}
test('retains backups when folder permission is lost and resumes after reselection', recoverFolderPermission)

/** Two sidebars share one writer, and local-only env values do not rewrite unchanged Postman JSON. */
async function sharedBackgroundWriter({extension}) {
  const first = await extension.openPanel()
  const settingsPage = await openSync(first)
  await createCollection(first, 'Shared writer')
  await enableSync(settingsPage)
  const second = await extension.openPanel()
  await openSync(second)
  await flushBackups(second)
  const worker = await countWorkerWrites(extension)
  await renameCollection(first, 'Shared writer', 'One changed export')
  /** Observe the disk export through another open sidebar. */
  async function names() { return diskNames(second) }
  await expect.poll(names).toEqual(['One changed export'])
  await flushBackups(second)
  expect(await worker.evaluate(workerWriteCount)).toBe(1)
  /** Change metadata omitted by Postman export without changing exported request values or base names. */
  async function editLocalEnv() {
    const items = await chrome.storage.local.get(null)
    const id = items['browsercurl.collectionIndex'][0].id
    const key = 'browsercurl.collection.' + id
    const collection = items[key]
    const variables = [{name: 'localOnly', value: 'local-secret'}]
    collection.env = {baseNames: [], forks: [{id: 'local', name: 'local', variables}]}
    collection.chosenEnv = 'local'
    await chrome.storage.local.set({[key]: collection})
  }
  await first.evaluate(editLocalEnv)
  await flushBackups(second)
  expect(await worker.evaluate(workerWriteCount)).toBe(1)
  const files = await diskFiles(second)
  const [json] = Object.values(files)
  expect(json).not.toContain('local-secret')
}
test('shares one background writer and skips changes omitted by Postman export', sharedBackgroundWriter)

/** Run backs up saved data, sends draft values, and keeps unsaved edits available after a restart. */
async function runKeepsDraftBackup({extension, api}) {
  let panel = await extension.openPanel()
  await fill(panel, '#request-url', `${api.origin}/echo?saved=yes`)
  await click(panel, '#save-request')
  await fill(panel, '#save-request-name', 'Linked request')
  await fill(panel, '#new-collection-name', 'Run API')
  await click(panel, '#confirm-save-as')
  await expect(panel.locator('#save-as-dialog')).toBeHidden()
  const settingsPage = await openSync(panel)
  await enableSync(settingsPage)
  await click(panel, '#close-collections')
  await fill(panel, '#request-url', `${api.origin}/echo?manual=save`)
  await click(panel, '#save-request')
  /** Read the saved URL inside the actual disk export independently of the request editor. */
  async function diskUrl() {
    const files = await diskFiles(panel)
    const [text] = Object.values(files)
    return JSON.parse(text).item[0].request.url.raw
  }
  await expect.poll(diskUrl).toBe(`${api.origin}/echo?manual=save`)
  const saved = await panel.evaluate(storedCollections)
  await fill(panel, '#request-url', `${api.origin}/echo?run=draft`)
  await send(panel)
  await flushBackups(panel)
  expect(api.requests[0].url).toBe('/echo?run=draft')
  expect(await panel.evaluate(storedCollections)).toEqual(saved)
  expect(await diskUrl()).toBe(`${api.origin}/echo?manual=save`)

  // Leave a saved revision waiting for backup, then use Run to retry it with different draft values.
  const worker = await failWorkerWrites(extension)
  await fill(panel, '#request-url', `${api.origin}/echo?explicit=saved`)
  await click(panel, '#save-request')
  await expect(settingsPage.locator('#disk-sync-status')).toContainText('Sync failed.')
  const pendingSaved = await panel.evaluate(storedCollections)
  await fill(panel, '#request-url', `${api.origin}/echo?still=draft`)
  /** Restore writes so the Run event can back up the earlier explicit Save. */
  function restoreWrites() { globalThis.failSyncWrites = false }
  await worker.evaluate(restoreWrites)
  await send(panel)
  expect(api.requests[1].url).toBe('/echo?still=draft')
  await expect.poll(diskUrl).toBe(`${api.origin}/echo?explicit=saved`)
  expect(await panel.evaluate(storedCollections)).toEqual(pendingSaved)
  const workspace = await panel.evaluate(storedWorkspace)
  expect(workspace.draft.editor.url).toBe(`${api.origin}/echo?still=draft`)

  await extension.restart()
  panel = await extension.openPanel()
  await expect(panel.locator('#request-url')).toHaveValue(`${api.origin}/echo?still=draft`)
  expect(await panel.evaluate(storedCollections)).toEqual(pendingSaved)
  expect(await diskUrl()).toBe(`${api.origin}/echo?explicit=saved`)
  await click(panel, '#save-request')
  await expect.poll(diskUrl).toBe(`${api.origin}/echo?still=draft`)
}
test('Run backs up saved collections while unsaved request edits stay in the draft', runKeepsDraftBackup)

/** Validate folder selection and cancellation without any interval controls. */
async function validateBackupSetup({extension}) {
  const panel = await extension.openPanel()
  const settingsPage = await openSync(panel)
  await expect(settingsPage.locator('#disk-sync-interval')).toHaveCount(0)
  await settingsPage.locator('#disk-sync-enabled').check()
  await click(settingsPage, '#save-disk-sync')
  await expect(settingsPage.locator('#disk-sync-error')).toContainText('Choose a folder')
  /** Simulate a canceled native picker without selecting a different directory. */
  function cancelPicker() {
    /** Return the browser's standard cancellation error. */
    window.showDirectoryPicker = function cancelled() {
      const error = new DOMException('Cancelled', 'AbortError')
      return Promise.reject(error)
    }
  }
  await settingsPage.evaluate(cancelPicker)
  await click(settingsPage, '#choose-sync-folder')
  await expect(settingsPage.locator('#disk-sync-folder')).toHaveText('No folder selected')
  await installDirectoryPicker(settingsPage)
  await click(settingsPage, '#choose-sync-folder')
  await settingsPage.locator('#disk-sync-scope').selectOption('selected')
  await click(settingsPage, '#save-disk-sync')
  await expect(settingsPage.locator('#disk-sync-error')).toContainText('Select at least one collection')
}
test('validates event-driven backup setup and handles picker cancellation', validateBackupSetup)

/** Browsers without external folder access explain the Settings limitation and retain manual collection export. */
async function unsupportedFolderAccess({extension}) {
  const panel = await extension.openPanel()
  const settingsPage = await extension.context.newPage()
  /** Disable the picker before the Settings page's feature check runs. */
  function removePicker() { window.showDirectoryPicker = undefined }
  await settingsPage.addInitScript(removePicker)
  await settingsPage.goto(`chrome-extension://${extension.extensionId}/options/index.html`)
  await expect(settingsPage.locator('#disk-sync-unsupported')).toContainText('export collections manually')
  await expect(settingsPage.locator('#disk-sync-form')).toBeHidden()
  await click(panel, '#show-collections')
  await expect(panel.locator('#disk-sync-form')).toHaveCount(0)
  await createCollection(panel, 'Manual')
  await panel.getByRole('button', {name: 'Export', exact: true}).click()
  await expect(panel.locator('#collection-export-warning')).toBeVisible()
}
test('explains unsupported folder access in Settings without breaking manual export', unsupportedFolderAccess)
