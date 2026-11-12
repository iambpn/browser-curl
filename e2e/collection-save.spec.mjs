/** Update linked collection requests through the real editor and persistent extension storage. */
import {appendFile} from 'node:fs/promises'
import {test, expect} from './fixtures.mjs'
import {
  addEntry, click, expectHidden, expectText, expectValue, expectVisible, fill,
  savedWorkspaceWith, send, storedCollections, storedHistory, storedWorkspace
} from './panel-helpers.mjs'

/** Create a saved request using the public Save as form. */
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

/** Load a request by its visible saved name. */
async function load(panel, name) {
  await click(panel, '#show-collections')
  await panel.locator('[data-open-collection-request]').filter({hasText: name}).click()
  await expectHidden(panel, '#collections-dialog')
}

/** Save screenshots and video identities only for an explicit evidence run. */
async function evidence(panel, name) {
  if (process.env.FACTORY_EVIDENCE !== '1') return
  await panel.screenshot({path: `.factory-evidence/${name}.png`})
  await appendFile('.factory-evidence/save-captures.jsonl', JSON.stringify({name, video: await panel.video().path()}) + '\n')
}

test('Save updates every loaded value without adding a copy and keeps its link after restart', async ({extension, api}) => {
  let panel = await extension.openPanel()
  await fill(panel, '#request-url', `${api.origin}/echo`)
  await saveAs(panel, 'Original request', 'Widget API')
  await click(panel, '#clear-request')
  await load(panel, 'Original request')
  await expectText(panel, '#request-collection', 'Widget API')
  await fill(panel, '#request-url', `${api.origin}/echo?updated=yes`)
  await panel.locator('#request-method').selectOption('PATCH')
  await addEntry(panel, 'params', 'disabled', 'query kept', false)
  await addEntry(panel, 'headers', 'X-Disabled', 'header kept', false)
  await click(panel, '#body-tab')
  await panel.locator('#body-type').selectOption('text')
  await fill(panel, '#request-body', 'updated body')
  await click(panel, '#auth-tab')
  await panel.locator('#auth-type').selectOption('basic')
  await fill(panel, '#basic-username', 'inactive user')
  await fill(panel, '#basic-password', 'inactive password')
  await panel.locator('#auth-type').selectOption('bearer')
  await fill(panel, '#bearer-token', 'updated token')
  await click(panel, '#request-name')
  await fill(panel, '#request-name-input', 'Updated request')
  await panel.keyboard.press('Enter')
  const edited = await savedWorkspaceWith(panel, 'name', 'Updated request')
  await click(panel, '#save-request')
  await expectText(panel, '#collection-save-status', 'Request saved to collection.')
  await expect.poll(async () => (await panel.evaluate(storedCollections)).collections[0].requests[0].editor)
    .toEqual(edited.draft.editor)
  await click(panel, '#body-tab')
  await evidence(panel, 'linked-request-saved')
  await extension.restart()
  panel = await extension.openPanel()
  await expectText(panel, '#request-collection', 'Widget API')
  // Save directly after restart proves the restored workspace still targets this request.
  await click(panel, '#body-tab')
  await fill(panel, '#request-body', 'saved after restart')
  await click(panel, '#save-request')
  await expect.poll(async () => (await panel.evaluate(storedCollections)).collections[0].requests[0].editor.body)
    .toBe('saved after restart')
  await click(panel, '#clear-request')
  await load(panel, 'Updated request')
  await expectValue(panel, '#request-url', `${api.origin}/echo?updated=yes`)
  await expectValue(panel, '#request-body', 'saved after restart')
  const saved = await panel.evaluate(storedCollections)
  expect(saved.collections).toHaveLength(1)
  expect(saved.collections[0].requests).toHaveLength(1)
  expect(saved.collections[0].requests[0].editor).toEqual({...edited.draft.editor, body: 'saved after restart'})
  await evidence(panel, 'saved-request-restored')
  await click(panel, '#show-collections')
  await expect(panel.locator('[data-open-collection-request]')).toHaveCount(1)
  await evidence(panel, 'save-keeps-one-request')
})

test('warns before replacing unsaved edits, cancels safely, and discards only when chosen', async ({extension, api}) => {
  const panel = await extension.openPanel()
  await fill(panel, '#request-url', `${api.origin}/echo?first=yes`)
  await saveAs(panel, 'First request', 'Widget API')
  await fill(panel, '#request-url', `${api.origin}/echo?second=yes`)
  await saveAs(panel, 'Second request')
  await load(panel, 'First request')
  await fill(panel, '#request-url', `${api.origin}/echo?unsaved=yes`)
  await click(panel, '#show-collections')
  await panel.locator('[data-open-collection-request]').filter({hasText: 'Second request'}).click()
  await expectVisible(panel, '#collection-unsaved-warning')
  await expectValue(panel, '#request-url', `${api.origin}/echo?unsaved=yes`)
  await evidence(panel, 'unsaved-changes-warning')
  await click(panel, '#cancel-collection-load')
  await expectHidden(panel, '#collection-unsaved-warning')
  await click(panel, '#close-collections')
  await expectValue(panel, '#request-url', `${api.origin}/echo?unsaved=yes`)
  await evidence(panel, 'cancel-keeps-edits')
  await click(panel, '#show-collections')
  await panel.locator('[data-open-collection-request]').filter({hasText: 'Second request'}).click()
  await click(panel, '#discard-collection-changes')
  await expectHidden(panel, '#collections-dialog')
  await expectValue(panel, '#request-url', `${api.origin}/echo?second=yes`)
  await expectText(panel, '#request-name', 'Second request')
  await evidence(panel, 'discard-loads-other-request')
  // A restored value is clean even if the editor was edited in between.
  await fill(panel, '#request-url', `${api.origin}/echo?temporary=yes`)
  await fill(panel, '#request-url', `${api.origin}/echo?second=yes`)
  await load(panel, 'First request')
  // An unlinked, nonempty draft must also be protected.
  await click(panel, '#clear-request')
  await addEntry(panel, 'headers', 'X-Unsent', 'keep', false)
  await click(panel, '#show-collections')
  await panel.locator('[data-open-collection-request]').first().click()
  await expectVisible(panel, '#collection-unsaved-warning')
  await panel.keyboard.press('Escape')
  await expectHidden(panel, '#collections-dialog')
  await click(panel, '#show-collections')
  await expectHidden(panel, '#collection-unsaved-warning')
  await click(panel, '#close-collections')
  await click(panel, '#headers-tab')
  await expect(panel.locator('#headers-rows [data-field="key"]').last()).toHaveValue('X-Unsent')
})

for (const destination of ['same', 'new']) {
  test(`Save as links to a copy in a ${destination} collection so Save changes only the copy`, async ({extension, api}) => {
    const panel = await extension.openPanel()
    await fill(panel, '#request-url', `${api.origin}/echo?original=yes`)
    await saveAs(panel, 'Original request', 'Original collection')
    await click(panel, '#clear-request')
    await load(panel, 'Original request')
    const original = (await panel.evaluate(storedCollections)).collections[0].requests[0]
    const collectionName = destination === 'new' ? 'Copy collection' : 'Original collection'
    await saveAs(panel, 'Copied request', destination === 'new' ? collectionName : undefined)
    await expectText(panel, '#request-name', 'Copied request')
    await expectText(panel, '#request-collection', collectionName)
    await fill(panel, '#request-url', `${api.origin}/echo?copy=changed`)
    await click(panel, '#save-request')
    await expect.poll(async () => (await panel.evaluate(storedCollections)).collections.flatMap(({requests}) => requests)
      .find(({editor}) => editor.name === 'Copied request').editor.url)
      .toBe(`${api.origin}/echo?copy=changed`)
    const saved = await panel.evaluate(storedCollections)
    const requests = saved.collections.flatMap(({requests}) => requests)
    expect(requests).toHaveLength(2)
    expect(requests.find(({id}) => id === original.id)).toEqual(original)
    await evidence(panel, `save-updates-copy-${destination}`)
    await click(panel, '#show-collections')
    await expect(panel.locator('[data-collection-request-name]')).toHaveText(['Original request', 'Copied request'])
    await evidence(panel, `original-and-copy-${destination}`)
  })
}

test('Clear removes the link and Save opens Save as for an empty or unlinked editor', async ({extension, api}) => {
  const panel = await extension.openPanel()
  await click(panel, '#save-request')
  await expectVisible(panel, '#save-as-dialog')
  await click(panel, '#cancel-save-as')
  await fill(panel, '#request-url', `${api.origin}/echo`)
  await saveAs(panel, 'Linked request', 'Widget API')
  await click(panel, '#clear-request')
  await expectHidden(panel, '#request-collection')
  const cleared = await savedWorkspaceWith(panel, 'url', '')
  expect(cleared.draft.collectionRequest).toBeUndefined()
  await click(panel, '#save-request')
  await expectVisible(panel, '#save-as-dialog')
  await expectValue(panel, '#save-request-name', 'Untitled request')
  await evidence(panel, 'clear-save-opens-save-as')
  await click(panel, '#cancel-save-as')
  await load(panel, 'Linked request')
  await expectHidden(panel, '#collection-unsaved-warning')
})

test('loading a collection request clears the visible response and its persisted reference', async ({extension, api}) => {
  let panel = await extension.openPanel()
  await fill(panel, '#request-url', `${api.origin}/echo?first=yes`)
  await saveAs(panel, 'First request', 'Widget API')
  await fill(panel, '#request-url', `${api.origin}/echo?second=yes`)
  await saveAs(panel, 'Second request')
  await send(panel)
  await expectVisible(panel, '#response-content')
  await evidence(panel, 'response-before-collection-load')
  await load(panel, 'First request')
  await expectHidden(panel, '#response-content')
  await expectHidden(panel, '#response-stats')
  await expectText(panel, '#empty-title', 'Ready when you are')
  await expect.poll(async () => (await panel.evaluate(storedWorkspace)).draft.responseId).toBeUndefined()
  await evidence(panel, 'collection-load-clears-response')
  await extension.restart()
  panel = await extension.openPanel()
  await expectHidden(panel, '#response-content')
  await expectHidden(panel, '#response-stats')
  await expectText(panel, '#request-name', 'First request')
})

test('sending adds history without saving edits and Back to draft restores the collection link', async ({extension, api}) => {
  let panel = await extension.openPanel()
  await fill(panel, '#request-url', `${api.origin}/echo?saved=yes`)
  await saveAs(panel, 'Linked request', 'Widget API')
  const original = await panel.evaluate(storedCollections)
  await fill(panel, '#request-url', `${api.origin}/echo?sent=unsaved`)
  await send(panel)
  expect(await panel.evaluate(storedCollections)).toEqual(original)
  expect(await panel.evaluate(storedHistory)).toHaveLength(1)
  await evidence(panel, 'linked-request-sent')
  await click(panel, '#show-history')
  await click(panel, '[data-open-history]')
  await expectVisible(panel, '#back-to-draft')
  await expectHidden(panel, '#request-collection')
  await click(panel, '#save-request')
  await expectVisible(panel, '#save-as-dialog')
  await evidence(panel, 'history-preview-save-as')
  await click(panel, '#cancel-save-as')
  await extension.restart()
  panel = await extension.openPanel()
  await click(panel, '#back-to-draft')
  await expectText(panel, '#request-collection', 'Widget API')
  await expectValue(panel, '#request-url', `${api.origin}/echo?sent=unsaved`)
  await click(panel, '#save-request')
  await expect.poll(async () => (await panel.evaluate(storedCollections)).collections[0].requests[0].editor.url)
    .toBe(`${api.origin}/echo?sent=unsaved`)
  await evidence(panel, 'back-to-linked-draft')
})

for (const deleted of ['request', 'collection']) {
  test(`Save opens Save as when the linked ${deleted} was deleted`, async ({extension, api}) => {
    const panel = await extension.openPanel()
    await fill(panel, '#request-url', `${api.origin}/echo`)
    await saveAs(panel, 'Deleted request', 'Widget API')
    const {collections: [collection]} = await panel.evaluate(storedCollections)
    await panel.evaluate(async ({deleted, collection}) => {
      const key = 'browsercurl.collection.' + collection.id
      if (deleted === 'collection') {
        await chrome.storage.local.remove(key)
        await chrome.storage.local.set({'browsercurl.collectionIndex': []})
      } else {
        await chrome.storage.local.set({[key]: {...collection, requests: []}})
      }
    }, {deleted, collection})
    await click(panel, '#save-request')
    await expectVisible(panel, '#save-as-dialog')
    await expectValue(panel, '#save-request-name', 'Deleted request')
    await expectValue(panel, '#request-url', `${api.origin}/echo`)
    await evidence(panel, `deleted-${deleted}-save-as`)
  })
}

test('a rejected linked Save keeps the stored request and current edits for retry', async ({extension, api}) => {
  const panel = await extension.openPanel()
  await fill(panel, '#request-url', `${api.origin}/echo?saved=yes`)
  await saveAs(panel, 'Linked request', 'Widget API')
  const original = await panel.evaluate(storedCollections)
  await fill(panel, '#request-url', `${api.origin}/echo?edited=yes`)
  await panel.evaluate(() => {
    const set = chrome.storage.local.set.bind(chrome.storage.local)
    chrome.storage.local.set = (items, callback) => {
      if (!Object.keys(items).some((key) => key.startsWith('browsercurl.collection.'))) return set(items, callback)
      chrome.storage.local.set = set
      throw new Error('Storage quota exceeded')
    }
  })
  await click(panel, '#save-request')
  await expectText(panel, '#collection-save-status', 'Could not save this request to the collection. Your request was not saved. Try again.')
  expect(await panel.evaluate(storedCollections)).toEqual(original)
  await expectValue(panel, '#request-url', `${api.origin}/echo?edited=yes`)
  await evidence(panel, 'linked-save-error')
  await click(panel, '#save-request')
  await expectText(panel, '#collection-save-status', 'Request saved to collection.')
  await expect.poll(async () => (await panel.evaluate(storedCollections)).collections[0].requests[0].editor.url)
    .toBe(`${api.origin}/echo?edited=yes`)
})
