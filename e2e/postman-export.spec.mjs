/** Export real saved collections through the credential note and browser download. */
import {appendFile, readFile} from 'node:fs/promises'
import {test, expect} from './fixtures.mjs'
import {click, expectHidden, fill, storedCollections} from './panel-helpers.mjs'

const schema = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'

async function capture(panel, name) {
  if (process.env.FACTORY_EVIDENCE !== '1') return
  await panel.screenshot({path: `.factory-evidence/${name}.png`})
  await appendFile('.factory-evidence/export-captures.jsonl', JSON.stringify({name, video: await panel.video().path()}) + '\n')
}

function collectionRow(panel, name) {
  return panel.locator('.collection-row').filter({has: panel.locator('[data-collection-name]', {hasText: name})})
}

async function confirmDownload(panel) {
  const ready = panel.waitForEvent('download')
  await click(panel, '#confirm-collection-export')
  const download = await ready
  expect(await download.failure()).toBeNull()
  return {download, json: JSON.parse(await readFile(await download.path(), 'utf8'))}
}

test('cancels the credential note without downloading, then exports the saved nested collection and values', async ({extension, api}) => {
  const panel = await extension.openPanel()
  await panel.setViewportSize({width: 420, height: 1000})
  panel.on('dialog', () => { throw new Error('Export must use an in-panel note') })
  const downloads = []
  panel.on('download', download => downloads.push(download))
  await panel.evaluate(() => {
    const create = URL.createObjectURL.bind(URL)
    const revoke = URL.revokeObjectURL.bind(URL)
    window.exportUrls = {created: [], revoked: []}
    URL.createObjectURL = blob => {
      const url = create(blob)
      window.exportUrls.created.push(url)
      return url
    }
    URL.revokeObjectURL = url => {
      window.exportUrls.revoked.push(url)
      revoke(url)
    }
  })
  await click(panel, '#auth-tab')
  await expect(panel.locator('#auth-panel .help-text').last()).toContainText('collections')
  await capture(panel, 'export-credentials-help')
  await click(panel, '#show-collections')
  const source = (await readFile(new URL('./data/postman-v2.1.json', import.meta.url), 'utf8')).replaceAll('TEST_ORIGIN', api.origin)
  const chooserReady = panel.waitForEvent('filechooser')
  await click(panel, '#import-collection')
  await (await chooserReady).setFiles({name: 'widgets.json', mimeType: 'application/json', buffer: Buffer.from(source)})
  const row = collectionRow(panel, 'Imported Widget API')
  await expect(row).toBeVisible()
  await click(panel, '#dismiss-collection-import')
  await expect(panel.locator('.collection-row').filter({has: panel.locator('[data-folder-name]')}).getByRole('button', {name: 'Export', exact: true})).toHaveCount(0)
  const before = await panel.evaluate(storedCollections)
  await row.getByRole('button', {name: 'Export', exact: true}).click()
  await expect(panel.locator('#collection-export-warning')).toContainText('contains saved credentials')
  await expect(panel.locator('#collection-export-warning')).toContainText('Imported Widget API')
  await capture(panel, 'export-credential-note')
  await panel.emulateMedia({colorScheme: 'dark'})
  await capture(panel, 'export-credential-note-dark')
  await panel.emulateMedia({colorScheme: 'light'})
  await click(panel, '#cancel-collection-export')
  await expectHidden(panel, '#collection-export-warning')
  expect(downloads).toHaveLength(0)
  expect(await panel.evaluate(() => window.exportUrls.created)).toHaveLength(0)
  expect(await panel.evaluate(storedCollections)).toEqual(before)
  await capture(panel, 'export-cancelled')
  await row.getByRole('button', {name: 'Export', exact: true}).click()
  const {download, json} = await confirmDownload(panel)
  await expectHidden(panel, '#collection-export-warning')
  expect(downloads).toHaveLength(1)
  expect(download.suggestedFilename()).toBe('Imported Widget API.postman_collection.json')
  expect(json.info).toEqual({name: 'Imported Widget API', _postman_id: 'fixture-widget-api', schema})
  expect(json.variable).toEqual([{key: 'unused', value: ''}])
  expect(json.item.map(item => item.name)).toEqual(['Widgets', 'Health'])
  expect(json.item[0].item.map(item => item.name)).toEqual(['Writes', 'List widgets'])
  const item = json.item[0].item[0].item[0]
  expect(item.name).toBe('Create widget')
  expect(item.request).toEqual({
    method: 'POST', url: {raw: `${api.origin}/echo?kept=yes`,
      protocol: 'http', host: new URL(api.origin).hostname.split('.'), port: new URL(api.origin).port, path: ['echo'], query: [
      {key: 'kept', value: 'yes', disabled: false}, {key: 'disabled', value: '{{not-sent}}', disabled: true}
    ]},
    header: [{key: 'X-Widget', value: 'imported', disabled: false}, {key: 'X-Disabled', value: '{{not-sent}}', disabled: true}],
    body: {mode: 'raw', raw: '{"widget":"{{name}}"}', options: {raw: {language: 'json'}}},
    auth: {type: 'bearer', bearer: [{key: 'token', value: 'folder-token', type: 'string'}]}
  })
  expect(json.item[1].request.auth.bearer[0].value).toBe('collection-token')
  for (const dropped of ['event', 'response', 'description']) expect(JSON.stringify(json)).not.toContain(`"${dropped}":`)
  expect(await panel.evaluate(storedCollections)).toEqual(before)
  await expect.poll(() => panel.evaluate(() => window.exportUrls.revoked.length)).toBe(1)
  const urls = await panel.evaluate(() => window.exportUrls)
  expect(urls.created).toEqual(urls.revoked)
  await expect(panel.locator('a[download]')).toHaveCount(0)
  if (process.env.FACTORY_EVIDENCE === '1') await download.saveAs('.factory-evidence/Imported Widget API.postman_collection.json')
  await capture(panel, 'export-downloaded-collection')
})

test('persists a generated Postman ID before download and reuses it after restart', async ({extension}) => {
  let panel = await extension.openPanel()
  await click(panel, '#show-collections')
  await click(panel, '#new-collection')
  await fill(panel, '#collection-item-name', 'API / <test>:?*')
  await click(panel, '#confirm-collection-item')
  const exportButton = () => collectionRow(panel, 'API / <test>:?*').getByRole('button', {name: 'Export', exact: true})
  await exportButton().click()
  await click(panel, '#cancel-collection-export')
  expect((await panel.evaluate(storedCollections)).collections[0].postmanId).toBeUndefined()
  await exportButton().click()
  const first = await confirmDownload(panel)
  expect(first.download.suggestedFilename()).toBe('API _ _test____.postman_collection.json')
  expect(first.json.info._postman_id).toMatch(/^[0-9a-f-]{36}$/)
  expect((await panel.evaluate(storedCollections)).collections[0].postmanId).toBe(first.json.info._postman_id)
  await extension.restart()
  panel = await extension.openPanel()
  await click(panel, '#show-collections')
  await exportButton().click()
  expect((await confirmDownload(panel)).json).toEqual(first.json)
  await capture(panel, 'export-stable-id-after-restart')
})

test('does not download when saving the generated ID fails and allows retry', async ({extension}) => {
  const panel = await extension.openPanel()
  const downloads = []
  panel.on('download', download => downloads.push(download))
  await click(panel, '#show-collections')
  await click(panel, '#new-collection')
  await fill(panel, '#collection-item-name', 'Retry export')
  await click(panel, '#confirm-collection-item')
  await collectionRow(panel, 'Retry export').getByRole('button', {name: 'Export', exact: true}).click()
  await panel.evaluate(() => {
    const set = chrome.storage.local.set.bind(chrome.storage.local)
    chrome.storage.local.set = () => {
      chrome.storage.local.set = set
      throw new Error('Storage write failed')
    }
  })
  await click(panel, '#confirm-collection-export')
  await expect(panel.locator('#collections-error')).toContainText('Could not export')
  await expect(panel.locator('#confirm-collection-export')).toBeEnabled()
  expect(downloads).toHaveLength(0)
  expect((await panel.evaluate(storedCollections)).collections[0].postmanId).toBeUndefined()
  await capture(panel, 'export-storage-error')
  const {json} = await confirmDownload(panel)
  expect(downloads).toHaveLength(1)
  expect((await panel.evaluate(storedCollections)).collections[0].postmanId).toBe(json.info._postman_id)
})

test('exports a manually saved request with untouched Params without adding a query', async ({extension}) => {
  const panel = await extension.openPanel()
  await fill(panel, '#request-url', 'https://example.com/health')
  await click(panel, '#save-request')
  await fill(panel, '#save-request-name', 'Health')
  await fill(panel, '#new-collection-name', 'Manual API')
  await click(panel, '#confirm-save-as')
  await expectHidden(panel, '#save-as-dialog')
  const saved = await panel.evaluate(storedCollections)
  expect(saved.collections[0].requests[0].editor.params).toEqual([{enabled: true, key: '', value: ''}])
  await click(panel, '#show-collections')
  await collectionRow(panel, 'Manual API').getByRole('button', {name: 'Export', exact: true}).click()
  const {json} = await confirmDownload(panel)
  expect(json.item[0].request.url.raw).toBe('https://example.com/health')
  expect(json.item[0].request.url.query).toEqual([])
  await capture(panel, 'export-manual-request')
})

test('cancelling a confirmed export invalidates its delayed download when the same collection is reopened', async ({extension}) => {
  const panel = await extension.openPanel()
  const downloads = []
  panel.on('download', download => downloads.push(download))
  await click(panel, '#show-collections')
  await click(panel, '#new-collection')
  await fill(panel, '#collection-item-name', 'Delayed export')
  await click(panel, '#confirm-collection-item')
  const exportButton = collectionRow(panel, 'Delayed export').getByRole('button', {name: 'Export', exact: true})
  await exportButton.click()
  await panel.evaluate(() => {
    const get = chrome.storage.local.get.bind(chrome.storage.local)
    chrome.storage.local.get = (keys, callback) => {
      if (typeof keys !== 'string' || !keys.startsWith('browsercurl.collection.')) return get(keys, callback)
      chrome.storage.local.get = get
      get(keys, items => { window.finishExportRead = () => callback(items) })
    }
    const create = URL.createObjectURL.bind(URL)
    window.exportBlobCount = 0
    URL.createObjectURL = blob => {
      window.exportBlobCount++
      return create(blob)
    }
  })
  await click(panel, '#confirm-collection-export')
  await panel.waitForFunction(() => typeof window.finishExportRead === 'function')
  await expect(panel.locator('#confirm-collection-export')).toBeDisabled()
  await click(panel, '#cancel-collection-export')
  await exportButton.click()
  await expect(panel.locator('#collection-export-warning')).toBeVisible()
  await panel.evaluate(() => window.finishExportRead())
  // Enabled again means the old async confirmation has finished, including its download guard.
  await expect(panel.locator('#confirm-collection-export')).toBeEnabled()
  expect(await panel.evaluate(() => window.exportBlobCount)).toBe(0)
  expect(downloads).toHaveLength(0)
  await expect(panel.locator('#collection-export-warning')).toBeVisible()
  await capture(panel, 'export-cancelled-pending-read')
  await confirmDownload(panel)
  expect(downloads).toHaveLength(1)
  expect(await panel.evaluate(() => window.exportBlobCount)).toBe(1)
  await expectHidden(panel, '#collection-export-warning')
  await capture(panel, 'export-confirmed-after-cancellation')
})
