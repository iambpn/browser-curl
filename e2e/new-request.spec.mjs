/** New requests choose a destination without saving or clearing the current editor before confirmation. */
import {test, expect} from './fixtures.mjs'
import {suggestionsCollection} from '../tests/helpers/env-suggestions.mjs'
import {chooseNewRequestDestination, savedWorkspaceWith, send, storedCollections, storedHistory, storedWorkspace} from './panel-helpers.mjs'

/** Seed a real nested collection whose environment can resolve requests against the test HTTP server. */
async function seedCollection(panel, origin = 'https://example.test') {
  const collection = suggestionsCollection()
  collection.env.forks[0].variables[0].value = origin
  await panel.evaluate(saveCollection, collection)
  return collection
}

/** Store only collection keys through the extension's actual storage API. */
async function saveCollection(collection) {
  await chrome.storage.local.set({
    'browsercurl.collectionIndex': [{id: collection.id, name: collection.name}],
    [`browsercurl.collection.${collection.id}`]: collection
  })
}

/** Open the picker and choose a collection, nested folder, or No collection through normal user controls. */
async function chooseDestination(panel, destination) {
  await panel.locator('#new-request').click()
  await expect(panel.locator('#new-request-dialog')).toBeVisible()
  await chooseNewRequestDestination(panel, destination)
  await panel.locator('#confirm-new-request').click()
  await expect(panel.locator('#new-request-dialog')).toBeHidden()
  await expect(panel.locator('#request-url')).toBeFocused()
}

/** No collections means the New request button goes directly to a blank unsaved editor. */
async function noCollectionsWorkflow({extension}) {
  const panel = await extension.openPanel()
  await panel.locator('#request-url').fill('https://example.test/old')
  await panel.locator('#new-request').click()
  await expect(panel.locator('#request-url')).toHaveValue('')
  await expect(panel.locator('#request-url')).toBeFocused()
  await expect(panel.locator('#new-request-dialog')).toBeHidden()
  const saved = await panel.evaluate(storedCollections)
  expect(saved.collections).toEqual([])
  await savedWorkspaceWith(panel, 'url', '')
  const workspace = await panel.evaluate(storedWorkspace)
  expect(workspace.draft.collectionDestination).toBeUndefined()
}
test('New request skips destination selection when no collections exist', noCollectionsWorkflow)

for (const [label, value, folderId] of [['collection', 'shop', undefined], ['nested folder', 'shop/items', 'items']]) {
  /** A chosen destination survives restart, supplies environment values, and becomes the default in Save. */
  async function selectedDestinationWorkflow({extension, api}) {
    let panel = await extension.openPanel()
    await seedCollection(panel, api.origin)
    const before = await panel.evaluate(storedCollections)
    await chooseDestination(panel, value)
    await expect(panel.locator('#request-url')).toHaveValue('')
    await expect(panel.locator('#save-as')).toBeHidden()
    await expect(panel.locator('#env-picker')).toHaveValue('local')
    await expect(panel.locator('#request-collection')).toContainText('Shop')
    if (folderId) await expect(panel.locator('#request-collection')).toContainText('Items')
    expect(await panel.evaluate(storedCollections)).toEqual(before)
    await panel.locator('#request-url').fill('{{base')
    const list = panel.getByRole('listbox', {name: 'Environment variables'})
    await expect(list).toContainText('Collection · Shop')
    await list.getByRole('option').click()
    await panel.locator('#request-url').press('End')
    await panel.locator('#request-url').pressSequentially('/echo')
    await savedWorkspaceWith(panel, 'url', '{{baseUrl}}/echo')
    await extension.restart()
    panel = await extension.openPanel()
    await expect(panel.locator('#request-url')).toHaveValue('{{baseUrl}}/echo')
    await expect(panel.locator('#env-picker')).toHaveValue('local')
    await panel.locator('#auth-tab').click()
    await panel.locator('#auth-type').selectOption('bearer')
    await panel.locator('#bearer-token').fill('{{token}}')
    await send(panel)
    expect(api.requests[0].headers.authorization).toBe('Bearer collection-secret')
    const history = await panel.evaluate(storedHistory)
    expect(history[0].collectionDestination.collectionId).toBe('shop')
    expect(history[0].collectionDestination.folderId).toBe(folderId)
    expect(history[0].collectionRequest).toBeUndefined()
    expect(await panel.evaluate(storedCollections)).toEqual(before)
    await panel.locator('#show-history').click()
    await panel.locator('[data-open-history]').first().click()
    await send(panel)
    expect(api.requests[1].headers.authorization).toBe('Bearer collection-secret')
    await panel.locator('#back-to-draft').click()
    await panel.locator('#save-request').click()
    await expect(panel.locator('#save-collection')).toHaveValue(value)
    await panel.locator('#save-request-name').fill('New API')
    await panel.locator('#confirm-save-as').click()
    await expect(panel.locator('#save-as-dialog')).toBeHidden()
    await expect(panel.locator('#collection-save-status')).toHaveText('Request saved to collection.')
    const saved = await panel.evaluate(storedCollections)
    const collection = saved.collections[0]
    const children = folderId ? collection.requests[0].requests[0].requests : collection.requests
    expect(children.at(-1).editor.name).toBe('New API')
    const workspace = await panel.evaluate(storedWorkspace)
    expect(workspace.draft.collectionDestination).toBeUndefined()
    expect(workspace.draft.collectionRequest.requestId).toBe(children.at(-1).id)
  }
  test(`new requests stay unsaved in the chosen ${label} and keep their environment through restart, history, and Save`, selectedDestinationWorkflow)
}

/** Cancel and Escape preserve the original editor; No collection starts an independent unsaved request. */
async function cancelAndNoCollectionWorkflow({extension}) {
  const panel = await extension.openPanel()
  await seedCollection(panel)
  await panel.locator('#request-url').fill('https://example.test/keep')
  await savedWorkspaceWith(panel, 'url', 'https://example.test/keep')
  const before = await panel.evaluate(storedCollections)
  for (const cancel of ['Cancel', 'Escape']) {
    await panel.locator('#new-request').click()
    await expect(panel.locator('#new-request-collection option')).toHaveText([
      'No collection', '📚 Shop', '\u00a0\u00a0\u00a0\u00a0📁 Outer',
      '\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0📁 Outer / Items'
    ])
    await chooseNewRequestDestination(panel, 'shop/items')
    if (cancel === 'Cancel') await panel.locator('#cancel-new-request').click()
    else await panel.keyboard.press('Escape')
    await expect(panel.locator('#new-request-dialog')).toBeHidden()
    await expect(panel.locator('#request-url')).toHaveValue('https://example.test/keep')
    expect(await panel.evaluate(storedCollections)).toEqual(before)
  }
  await panel.setViewportSize({width: 320, height: 720})
  await chooseDestination(panel, 'none')
  await expect(panel.locator('#request-url')).toHaveValue('')
  await expect(panel.locator('#request-collection')).toBeHidden()
  await expect(panel.locator('#env-picker')).toBeHidden()
  await savedWorkspaceWith(panel, 'url', '')
  const workspace = await panel.evaluate(storedWorkspace)
  expect(workspace.draft.collectionDestination).toBeUndefined()
  expect(await panel.evaluate(storedCollections)).toEqual(before)
}
test('new request selection offers folders and No collection while Cancel and Escape preserve edits', cancelAndNoCollectionWorkflow)

/** Retain the native list with slightly larger options and one selectable entry for each collection. */
async function nativeDestinationListWorkflow({extension}) {
  const panel = await extension.openPanel()
  await seedCollection(panel)
  await panel.locator('#request-url').fill('https://example.test/keep')
  await panel.locator('#new-request').click()
  const picker = panel.getByRole('listbox', {name: 'Collection or folder'})
  await expect(picker.getByRole('option')).toHaveCount(4)
  await expect(picker.locator('optgroup')).toHaveCount(0)
  await expect(picker.getByRole('option', {name: '📚 Shop', exact: true})).toHaveCount(1)
  await expect(picker).toHaveCSS('font-size', '13px')
  await picker.press('Home')
  await picker.press('ArrowDown')
  await expect(picker).toHaveValue('shop')
  await expect(picker).toBeFocused()
  await picker.press('Tab')
  await expect(panel.locator('#cancel-new-request')).toBeFocused()
  for (const width of [1100, 320]) {
    await panel.setViewportSize({width, height: 720})
    for (const option of await picker.getByRole('option').all()) {
      const bounds = await option.boundingBox()
      expect(bounds.height).toBeGreaterThanOrEqual(28)
      expect(bounds.height).toBeLessThan(36)
      expect(bounds.x).toBeGreaterThanOrEqual(0)
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width)
    }
  }
  await panel.emulateMedia({colorScheme: 'dark'})
  await chooseNewRequestDestination(panel, 'shop/items')
  const collection = picker.getByRole('option', {name: '📚 Shop', exact: true})
  const bounds = await collection.boundingBox()
  const position = {x: bounds.width - 12, y: bounds.height / 2}
  await collection.click({position})
  await expect(picker).toHaveValue('shop')
  await expect(panel.locator('#request-url')).toHaveValue('https://example.test/keep')
  await panel.locator('#confirm-new-request').click()
  await expect(panel.locator('#request-collection')).toHaveText('Shop')
}
test('the original destination list uses slightly larger options without duplicate collection headings', nativeDestinationListWorkflow)

/** Delete only the currently selected nested folder, as another panel could do. */
async function removeSelectedFolder() {
  const key = 'browsercurl.collection.shop'
  const data = await chrome.storage.local.get(key)
  data[key].requests[0].requests = []
  await chrome.storage.local.set(data)
}

/** A removed destination requires a fresh choice and cannot silently discard the current draft. */
async function deletedDestinationWorkflow({extension}) {
  const panel = await extension.openPanel()
  await seedCollection(panel)
  await panel.locator('#request-url').fill('https://example.test/keep')
  await panel.locator('#new-request').click()
  await chooseNewRequestDestination(panel, 'shop/items')
  await panel.evaluate(removeSelectedFolder)
  await expect(panel.locator('#new-request-error')).toContainText('no longer available')
  await expect(panel.locator('#confirm-new-request')).toBeDisabled()
  await expect(panel.locator('#request-url')).toHaveValue('https://example.test/keep')
  await panel.locator('#cancel-new-request').click()
  await expect(panel.locator('#request-url')).toHaveValue('https://example.test/keep')
}
test('removing a selected folder keeps the current draft and requires another destination', deletedDestinationWorkflow)

/** Hold the real collection write lock until the test explicitly releases it. */
function holdCollectionLock() {
  /** Keep the lock pending while a new request confirmation waits for current data. */
  async function hold() {
    const pending = Promise.withResolvers()
    window.releaseCollectionLock = pending.resolve
    await pending.promise
  }
  void navigator.locks.request('browsercurl.collectionIndex', hold)
}

/** Indicate that the lock owner installed the release callback. */
function collectionLockReady() {
  return typeof window.releaseCollectionLock === 'function'
}

/** Release the test-owned lock without changing any collection data. */
function releaseCollectionLock() {
  window.releaseCollectionLock()
}

/** A canceled confirmation cannot replace the editor after its delayed storage read finishes. */
async function canceledConfirmationWorkflow({extension}) {
  const panel = await extension.openPanel()
  await seedCollection(panel)
  const other = await extension.openPanel()
  await other.evaluate(holdCollectionLock)
  await other.waitForFunction(collectionLockReady)
  await panel.locator('#request-url').fill('https://example.test/keep')
  await panel.locator('#new-request').click()
  await chooseNewRequestDestination(panel, 'shop')
  await panel.locator('#confirm-new-request').click()
  await expect(panel.locator('#confirm-new-request')).toBeDisabled()
  await panel.locator('#cancel-new-request').click()
  await other.evaluate(releaseCollectionLock)
  await expect(panel.locator('#confirm-new-request')).toBeEnabled()
  await expect(panel.locator('#request-url')).toHaveValue('https://example.test/keep')
  await expect(panel.locator('#new-request-dialog')).toBeHidden()
}
test('Cancel preserves the draft even when confirming a new request is waiting for storage', canceledConfirmationWorkflow)

/** Fail one collection-index read without affecting draft saves or later reads. */
function failCollectionRead() {
  const get = chrome.storage.local.get.bind(chrome.storage.local)
  /** Restore the real API before rejecting the destination lookup. */
  function read(keys, callback) {
    if (keys === 'browsercurl.collectionIndex') {
      chrome.storage.local.get = get
      throw new Error('Collection storage unavailable')
    }
    return get(keys, callback)
  }
  chrome.storage.local.get = read
}

/** A failed read reports the problem instead of assuming the user has no collections and clearing their draft. */
async function failedReadWorkflow({extension}) {
  const panel = await extension.openPanel()
  await seedCollection(panel)
  await panel.locator('#request-url').fill('https://example.test/keep')
  await panel.evaluate(failCollectionRead)
  await panel.locator('#new-request').click()
  await expect(panel.locator('#new-request-error')).toContainText('Could not read collections')
  await expect(panel.locator('#confirm-new-request')).toBeDisabled()
  await expect(panel.locator('#request-url')).toHaveValue('https://example.test/keep')
  await panel.locator('#cancel-new-request').click()
  await chooseDestination(panel, 'shop')
  await expect(panel.locator('#request-url')).toHaveValue('')
}
test('a storage read failure preserves the draft and allows retrying destination selection', failedReadWorkflow)
