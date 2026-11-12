/** Save and reopen complete editor snapshots through the installed extension and real local storage. */
import {appendFile, writeFile} from 'node:fs/promises'
import {test, expect} from './fixtures.mjs'
import {
  addEntry, click, echoedRequest, expectHidden, expectText, expectValue, expectVisible,
  fill, savedWorkspaceWith, send, storedCollections, storedHistory, storedWorkspace
} from './panel-helpers.mjs'

/** Capture actual sidebar states and identify their videos only during an evidence run. */
async function captureEvidence(panel, name) {
  if (process.env.FACTORY_EVIDENCE !== '1') return
  await panel.screenshot({path: `.factory-evidence/${name}.png`})
  await appendFile('.factory-evidence/captures.jsonl', JSON.stringify({name, video: await panel.video().path()}) + '\n')
}

/** Save the editor using the in-panel form, creating a collection only when requested. */
async function saveAs(panel, name, collectionName) {
  await click(panel, '#save-as')
  await fill(panel, '#save-request-name', name)
  if (collectionName) {
    await panel.locator('#save-collection').selectOption('new')
    await fill(panel, '#new-collection-name', collectionName)
  }
  await click(panel, '#confirm-save-as')
  await expectHidden(panel, '#save-as-dialog')
  await expectText(panel, '#collection-save-status', 'Request saved to collection.')
}

/** Persist two requests, restart Chromium, and send a restored snapshot without changing its editor values. */
async function saveAndReopen({extension, api}) {
  let panel = await extension.openPanel()
  await click(panel, '#show-collections')
  await expectText(panel, '#collections-empty', 'No collections yet. Use Save as to save a request in a collection.')
  await captureEvidence(panel, 'collections-empty')
  await panel.keyboard.press('Escape')
  await expectHidden(panel, '#collections-dialog')
  await fill(panel, '#request-url', `${api.origin}/echo?kept=yes`)
  await panel.locator('#request-method').selectOption('POST')
  await addEntry(panel, 'params', 'disabled-query', 'retained', false)
  await addEntry(panel, 'headers', 'X-Disabled', 'retained', false)
  await addEntry(panel, 'headers', 'X-Enabled', 'sent')
  await click(panel, '#body-tab')
  await fill(panel, '#request-body', '{"collection":true}')
  await panel.locator('#body-type').selectOption('json')
  await click(panel, '#auth-tab')
  await panel.locator('#auth-type').selectOption('basic')
  await fill(panel, '#basic-username', 'inactive-user')
  await fill(panel, '#basic-password', 'inactive-password')
  await panel.locator('#auth-type').selectOption('api-key')
  await fill(panel, '#api-key-name', 'inactive-key')
  await fill(panel, '#api-key-value', 'inactive-value')
  await panel.locator('#api-key-location').selectOption('query')
  await panel.locator('#auth-type').selectOption('custom')
  await fill(panel, '#custom-authorization', 'inactive-custom')
  await panel.locator('#auth-type').selectOption('bearer')
  await fill(panel, '#bearer-token', 'collection-token')
  await click(panel, '#request-name')
  await fill(panel, '#request-name-input', 'Create widget')
  await panel.keyboard.press('Enter')
  await click(panel, '#save-as')
  await expectValue(panel, '#save-request-name', 'Create widget')
  await fill(panel, '#new-collection-name', 'Widget API')
  await captureEvidence(panel, 'save-as-new-collection')
  await click(panel, '#confirm-save-as')
  await expectHidden(panel, '#save-as-dialog')
  await expectVisible(panel, '#collection-save-status')
  await captureEvidence(panel, 'collection-save-confirmation')
  const original = await savedWorkspaceWith(panel, 'name', 'Create widget')
  const saved = await panel.evaluate(storedCollections)
  expect(saved.index).toEqual([{id: saved.collections[0].id, name: 'Widget API'}])
  expect(saved.collections).toHaveLength(1)
  expect(saved.collections[0].requests).toHaveLength(1)
  expect(saved.collections[0].requests[0].editor).toEqual(original.draft.editor)
  expect(await panel.evaluate(storedHistory)).toEqual([])
  await click(panel, '#show-collections')
  await expectText(panel, '[data-collection-name]', 'Widget API')
  await expectText(panel, '[data-collection-method]', 'POST')
  await expectText(panel, '[data-collection-request-name]', 'Create widget')
  await panel.setViewportSize({width: 380, height: 820})
  await panel.screenshot({path: '.playwright/results/collections.png'})
  await captureEvidence(panel, 'collections-one-request')
  await click(panel, '#close-collections')

  await click(panel, '#clear-request')
  await fill(panel, '#request-url', `${api.origin}/echo?second=yes`)
  await saveAs(panel, 'List widgets')
  await click(panel, '#show-collections')
  await expect(panel.locator('[data-collection-name]')).toHaveCount(1)
  await expect(panel.locator('[data-open-collection-request]')).toHaveCount(2)
  await expect(panel.locator('[data-collection-method]')).toHaveText(['POST', 'GET'])
  await expect(panel.locator('[data-collection-request-name]')).toHaveText(['Create widget', 'List widgets'])
  await captureEvidence(panel, 'collections-two-requests')
  const both = await panel.evaluate(storedCollections)
  expect(both.collections[0].requests).toHaveLength(2)
  if (process.env.FACTORY_EVIDENCE === '1') {
    await writeFile('.factory-evidence/stored-collections.json', JSON.stringify(both, null, 2) + '\n')
  }
  await extension.restart()
  panel = await extension.openPanel()
  await click(panel, '#show-collections')
  await panel.locator('[data-open-collection-request]').first().click()
  await expectHidden(panel, '#collections-dialog')
  await expectValue(panel, '#request-method', 'POST')
  await expectValue(panel, '#request-url', `${api.origin}/echo?kept=yes`)
  await expectText(panel, '#request-name', 'Create widget')
  await click(panel, '#params-tab')
  for (const group of ['params', 'headers']) {
    await click(panel, group === 'params' ? '#params-tab' : '#headers-tab')
    const rows = panel.locator(`#${group}-rows .entry-row`)
    const entries = original.draft.editor[group]
    await expect(rows).toHaveCount(entries.length)
    for (const [index, entry] of entries.entries()) {
      await expect(rows.nth(index).locator('[data-field="key"]')).toHaveValue(entry.key)
      await expect(rows.nth(index).locator('[data-field="value"]')).toHaveValue(entry.value)
      await expect(rows.nth(index).locator('[data-field="enabled"]')).toBeChecked({checked: entry.enabled})
    }
    await captureEvidence(panel, `restored-${group}`)
  }
  await click(panel, '#body-tab')
  await expectValue(panel, '#request-body', '{"collection":true}')
  await expectValue(panel, '#body-type', 'json')
  await captureEvidence(panel, 'restored-json-body')
  await click(panel, '#auth-tab')
  await expectValue(panel, '#auth-type', 'bearer')
  await expectValue(panel, '#bearer-token', 'collection-token')
  await captureEvidence(panel, 'restored-bearer-token')
  const restored = await panel.evaluate(storedWorkspace)
  expect(restored.draft.editor).toEqual(original.draft.editor)
  await expectHidden(panel, '#response-content')
  await send(panel)
  const received = await echoedRequest(panel)
  expect(received.method).toBe('POST')
  expect(received.url).toBe('/echo?kept=yes')
  expect(received.headers['x-disabled']).toBeUndefined()
  expect(received.headers['x-enabled']).toBe('sent')
  expect(received.headers.authorization).toBe('Bearer collection-token')
  expect(received.headers['content-type']).toBe('application/json')
  expect(received.body).toBe('{"collection":true}')
  expect(await panel.evaluate(storedHistory)).toHaveLength(1)
  await captureEvidence(panel, 'restored-request-response')
  if (process.env.FACTORY_EVIDENCE === '1') {
    await writeFile('.factory-evidence/echoed-request.json', JSON.stringify(received, null, 2) + '\n')
    await click(panel, '#show-history')
    await expect(panel.locator('[data-open-history]')).toHaveCount(1)
    await captureEvidence(panel, 'restored-request-history')
  }
}
test('saves requests into new and existing collections and restores every editor value after restart', saveAndReopen)

/** Keep two open panels current for new collections and additions to an existing collection. */
async function changesAcrossPanels({extension, api}) {
  const first = await extension.openPanel()
  const second = await extension.openPanel()
  await click(second, '#show-collections')
  await expectVisible(second, '#collections-empty')
  await fill(first, '#request-url', `${api.origin}/echo?first=yes`)
  await saveAs(first, 'First request', 'Shared collection')
  await expectText(second, '[data-collection-name]', 'Shared collection')
  await expectText(second, '[data-collection-request-name]', 'First request')
  await click(second, '#close-collections')
  await click(first, '#show-collections')
  await fill(second, '#request-url', `${api.origin}/echo?second=yes`)
  await second.locator('#request-method').selectOption('PATCH')
  await click(second, '#body-tab')
  await second.locator('#body-type').selectOption('text')
  await fill(second, '#request-body', 'plain text body')
  await saveAs(second, 'Second request')
  await expect(first.locator('[data-collection-request-name]')).toHaveText(['First request', 'Second request'])
  await expect(first.locator('[data-collection-method]')).toHaveText(['GET', 'PATCH'])
  await first.locator('[data-open-collection-request]').last().click()
  await expectHidden(first, '#collections-dialog')
  await click(first, '#body-tab')
  await expectValue(first, '#body-type', 'text')
  await expectValue(first, '#request-body', 'plain text body')
  await first.emulateMedia({colorScheme: 'dark'})
  await first.setViewportSize({width: 280, height: 820})
  await click(first, '#show-collections')
  const dialog = first.locator('#collections-dialog')
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  await first.screenshot({path: '.playwright/results/collections-dark-narrow.png'})
  await captureEvidence(first, 'collections-dark-narrow')
}
test('refreshes collections in another open panel and loads text bodies in a narrow dark panel', changesAcrossPanels)

/** Delay one real storage read's result so concurrent saves reliably overlap before either writes. */
function delayCollectionRead() {
  const get = chrome.storage.local.get.bind(chrome.storage.local)
  let delayed = false
  chrome.storage.local.get = (keys, callback) => {
    if (!delayed && typeof keys === 'string' && keys.startsWith('browsercurl.collection')) {
      delayed = true
      get(keys, (items) => setTimeout(() => callback(items), 500))
    } else {
      return get(keys, callback)
    }
  }
}

for (const destination of ['existing', 'new']) {
  test(`keeps concurrent saves from separate panels in ${destination} collections`, async ({extension, api}) => {
    const first = await extension.openPanel()
    await fill(first, '#request-url', `${api.origin}/echo?seed=yes`)
    await saveAs(first, 'Seed request', 'Shared collection')
    const second = await extension.openPanel()
    const panels = [first, second]
    const names = ['First concurrent request', 'Second concurrent request']
    const collectionNames = ['First collection', 'Second collection']
    for (const [index, panel] of panels.entries()) {
      await fill(panel, '#request-url', `${api.origin}/echo?panel=${index}`)
      await click(panel, '#save-as')
      await fill(panel, '#save-request-name', names[index])
      if (destination === 'new') {
        await panel.locator('#save-collection').selectOption('new')
        await fill(panel, '#new-collection-name', collectionNames[index])
      }
      await expect(panel.locator('#confirm-save-as')).toBeEnabled()
      await panel.evaluate(delayCollectionRead)
    }
    // Dispatch both clicks together, without Playwright's focus/actionability waits between panels.
    await Promise.all(panels.map((panel) => panel.evaluate(() => document.querySelector('#confirm-save-as').click())))
    for (const panel of panels) {
      await expectHidden(panel, '#save-as-dialog')
      await expectText(panel, '#collection-save-status', 'Request saved to collection.')
    }
    const saved = await first.evaluate(storedCollections)
    expect(saved.index.map(({name}) => name).sort()).toEqual(
      (destination === 'new' ? ['Shared collection', ...collectionNames] : ['Shared collection']).sort()
    )
    // Every stored collection must remain reachable from the index, including concurrent creations.
    expect(saved.index.map(({id}) => id).sort()).toEqual(saved.collections.map(({id}) => id).sort())
    const requests = saved.collections.flatMap(({requests}) => requests)
    expect(requests.map(({editor}) => editor.name).sort()).toEqual(['Seed request', ...names].sort())
    for (const [index, name] of names.entries()) {
      expect(requests.find(({editor}) => editor.name === name).editor.url).toBe(`${api.origin}/echo?panel=${index}`)
    }
    for (const panel of panels) {
      await click(panel, '#show-collections')
      await expect(panel.locator('[data-collection-name]')).toHaveCount(saved.index.length)
      await expect(panel.locator('[data-collection-request-name]')).toHaveCount(3)
    }
  })
}

/** Let another panel update the picker while a save waits for the collection write lock. */
for (const outcome of ['accepted', 'rejected']) {
  test(`blocks duplicate submission during a picker refresh until a pending save is ${outcome}`, async ({extension, api}) => {
    const first = await extension.openPanel()
    await fill(first, '#request-url', `${api.origin}/echo`)
    await saveAs(first, 'Seed request', 'Shared collection')
    const second = await extension.openPanel()
    await click(first, '#save-as')
    await fill(first, '#save-request-name', 'Pending request')
    await expect(first.locator('#confirm-save-as')).toBeEnabled()
    await click(second, '#save-as')
    await fill(second, '#save-request-name', 'Other request')
    await second.locator('#save-collection').selectOption('new')
    await fill(second, '#new-collection-name', 'Other collection')
    await expect(second.locator('#confirm-save-as')).toBeEnabled()

    // Pause before the real write and before its acknowledgement, keeping the write lock held.
    await second.evaluate(() => {
      const set = chrome.storage.local.set.bind(chrome.storage.local)
      chrome.storage.local.set = (items, callback) => {
        if (!Object.hasOwn(items, 'browsercurl.collectionIndex')) return set(items, callback)
        window.commitCollectionWrite = () => set(items, () => {
          window.finishCollectionWrite = callback
        })
      }
    })
    await click(second, '#confirm-save-as')
    await second.waitForFunction(() => typeof window.commitCollectionWrite === 'function')
    if (outcome === 'rejected') {
      // Fail just the first collection write; a queued duplicate would then incorrectly succeed.
      await first.evaluate(() => {
        const set = chrome.storage.local.set.bind(chrome.storage.local)
        chrome.storage.local.set = (items, callback) => {
          if (!Object.keys(items).some((key) => key.startsWith('browsercurl.collection.'))) return set(items, callback)
          chrome.storage.local.set = set
          throw new Error('Storage quota exceeded')
        }
      })
    }
    await click(first, '#confirm-save-as')
    await expect(first.locator('#confirm-save-as')).toBeDisabled()
    await second.evaluate(() => window.commitCollectionWrite())
    await second.waitForFunction(() => typeof window.finishCollectionWrite === 'function')
    await expect(first.locator('#save-collection option')).toHaveText(['Shared collection', 'Other collection', 'New collection'])
    await expect.soft(first.locator('#confirm-save-as')).toBeDisabled()
    await captureEvidence(first, `pending-save-${outcome}`)
    // Exercise both button clicks and form submission while the original save is still pending.
    await first.evaluate(() => {
      document.querySelector('#confirm-save-as').click()
      document.querySelector('#save-as-form').requestSubmit()
    })
    await second.evaluate(() => window.finishCollectionWrite())
    await expectHidden(second, '#save-as-dialog')
    await expectText(second, '#collection-save-status', 'Request saved to collection.')
    if (outcome === 'rejected') {
      await expectVisible(first, '#save-as-dialog')
      await expectText(first, '#save-as-error', 'Could not save this request to the collection. Your request was not saved. Try again.')
      await expectHidden(first, '#collection-save-status')
      await expect(first.locator('#confirm-save-as')).toBeEnabled()
      await first.evaluate(() => navigator.locks.request('browsercurl.collectionIndex', () => {}))
      const failed = await first.evaluate(storedCollections)
      expect(failed.collections.flatMap(({requests}) => requests).map(({editor}) => editor.name).sort())
        .toEqual(['Other request', 'Seed request'])
      await captureEvidence(first, 'collection-save-rejected')
      // The completed failure must release the submission guard so one explicit retry can succeed.
      await click(first, '#confirm-save-as')
    }
    await expectHidden(first, '#save-as-dialog')
    await expectText(first, '#collection-save-status', 'Request saved to collection.')
    // Wait behind all queued writes before checking that the attempted resubmit stored no duplicate.
    await first.evaluate(() => navigator.locks.request('browsercurl.collectionIndex', () => {}))
    const saved = await first.evaluate(storedCollections)
    expect(saved.collections.flatMap(({requests}) => requests).map(({editor}) => editor.name).sort())
      .toEqual(['Other request', 'Pending request', 'Seed request'])
    if (outcome === 'rejected') {
      await click(first, '#show-collections')
      await expect(first.locator('[data-collection-request-name]')).toHaveText(['Seed request', 'Pending request', 'Other request'])
      await captureEvidence(first, 'collections-after-save-retry')
    }
  })
}

/** Cancel without writing, and reject whitespace-only names without losing entered editor values. */
async function saveFormValidation({extension, api}) {
  const panel = await extension.openPanel()
  await fill(panel, '#request-url', `${api.origin}/echo`)
  await click(panel, '#save-as')
  await expectVisible(panel, '#new-collection-name')
  await fill(panel, '#save-request-name', '   ')
  await fill(panel, '#new-collection-name', 'Uncreated')
  await click(panel, '#confirm-save-as')
  await expectText(panel, '#save-as-error', 'Enter a request name.')
  await fill(panel, '#save-request-name', 'Valid request')
  await fill(panel, '#new-collection-name', '   ')
  await click(panel, '#confirm-save-as')
  await expectText(panel, '#save-as-error', 'Enter a collection name.')
  await panel.keyboard.press('Control+Enter')
  expect(await panel.evaluate(storedHistory)).toEqual([])
  await expectVisible(panel, '#save-as-dialog')
  await click(panel, '#cancel-save-as')
  await expectHidden(panel, '#save-as-dialog')
  await expectValue(panel, '#request-url', `${api.origin}/echo`)
  expect(await panel.evaluate(storedCollections)).toEqual({index: [], collections: []})
  await click(panel, '#save-as')
  await panel.keyboard.press('Escape')
  await expectHidden(panel, '#save-as-dialog')
  await expectHidden(panel, '#collection-save-status')
}
test('validates Save as names and cancels without saving or sending', saveFormValidation)
