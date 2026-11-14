/** Update linked collection requests through the real editor and persistent extension storage. */
import {appendFile} from 'node:fs/promises'
import {test, expect} from './fixtures.mjs'
import {
  addEntry, click, expectHidden, expectText, expectValue, expectVisible, fill,
  savedWorkspaceWith, send, storedCollections, storedHistory, storedWorkspace, folderOption
} from './panel-helpers.mjs'

/** Create a saved request using the public Save as form. */
async function saveAs(panel, name, collectionName) {
  // Save as appears once the editor is linked; Save opens the same form for an unsaved request.
  await click(panel, await panel.locator('#save-as').isVisible() ? '#save-as' : '#save-request')
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
  // Save as is only for a request that is already saved in a collection.
  await expectHidden(panel, '#save-as')
  await click(panel, '#save-request')
  await expectVisible(panel, '#save-as-dialog')
  await click(panel, '#cancel-save-as')
  await fill(panel, '#request-url', `${api.origin}/echo`)
  await saveAs(panel, 'Linked request', 'Widget API')
  await expectVisible(panel, '#save-as')
  await click(panel, '#clear-request')
  await expectHidden(panel, '#request-collection')
  await expectHidden(panel, '#save-as')
  const cleared = await savedWorkspaceWith(panel, 'url', '')
  expect(cleared.draft.collectionRequest).toBeUndefined()
  await click(panel, '#save-request')
  await expectVisible(panel, '#save-as-dialog')
  await expectValue(panel, '#save-request-name', 'Untitled request')
  await evidence(panel, 'clear-save-opens-save-as')
  await click(panel, '#cancel-save-as')
  await load(panel, 'Linked request')
  await expectHidden(panel, '#collection-unsaved-warning')
  await expectVisible(panel, '#save-as')
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
    await expectHidden(panel, '#save-as')
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

/** Hold the real collection write lock until the test explicitly releases it. */
async function holdCollectionLock(panel) {
  await panel.evaluate(() => new Promise((held) => {
    window.collectionLock = navigator.locks.request('browsercurl.collectionIndex', () => new Promise((release) => {
      window.releaseCollectionLock = release
      held()
    }))
  }))
}

/** Wait until the user's save is queued, so the following editor action happens before completion. */
async function expectPendingCollectionSave(panel) {
  await expect.poll(() => panel.evaluate(async () => {
    const {pending} = await navigator.locks.query()
    return pending.some(({name}) => name === 'browsercurl.collectionIndex')
  })).toBe(true)
}

/** Drain the queued write; UI assertions also wait for the save handler's completion. */
async function releaseCollectionLock(panel) {
  await panel.evaluate(async () => {
    window.releaseCollectionLock()
    await window.collectionLock
    await navigator.locks.request('browsercurl.collectionIndex', () => {})
  })
}

for (const action of ['cleared', 'replaced']) {
  test(`a pending Save as cannot relink an editor that was ${action}`, async ({extension, api}) => {
    const panel = await extension.openPanel()
    await fill(panel, '#request-url', `${api.origin}/echo?original=yes`)
    await saveAs(panel, 'Original request', 'Widget API')
    await fill(panel, '#request-url', `${api.origin}/echo?other=yes`)
    await saveAs(panel, 'Other request')
    await load(panel, 'Original request')
    const before = await panel.evaluate(storedCollections)

    await holdCollectionLock(panel)
    await click(panel, '#save-as')
    await fill(panel, '#save-request-name', 'Pending copy')
    await click(panel, '#confirm-save-as')
    await expectPendingCollectionSave(panel)
    await click(panel, '#cancel-save-as')
    if (action === 'cleared') await click(panel, '#clear-request')
    else await load(panel, 'Other request')
    const currentUrl = action === 'cleared' ? '' : `${api.origin}/echo?other=yes`
    const current = await savedWorkspaceWith(panel, 'url', currentUrl)

    await releaseCollectionLock(panel)
    await expect(panel.locator('#confirm-save-as')).toBeEnabled()
    await expectText(panel, '#request-name', action === 'cleared' ? 'Untitled request' : 'Other request')
    await expectValue(panel, '#request-url', currentUrl)
    if (action === 'cleared') await expectHidden(panel, '#request-collection')
    else await expectText(panel, '#request-collection', 'Widget API')
    expect((await panel.evaluate(storedWorkspace)).draft.collectionRequest).toEqual(current.draft.collectionRequest)
    const saved = await panel.evaluate(storedCollections)
    expect(saved.collections[0].requests).toHaveLength(3)
    expect(saved.collections[0].requests.slice(0, 2)).toEqual(before.collections[0].requests)
    expect(saved.collections[0].requests[2].editor).toEqual({...before.collections[0].requests[0].editor, name: 'Pending copy'})

    if (action === 'cleared') {
      await click(panel, '#save-request')
      await expectVisible(panel, '#save-as-dialog')
      expect(await panel.evaluate(storedCollections)).toEqual(saved)
    } else {
      await fill(panel, '#request-url', `${api.origin}/echo?other=saved`)
      await click(panel, '#save-request')
      await expectText(panel, '#collection-save-status', 'Request saved to collection.')
      saved.collections[0].requests[1].editor.url = `${api.origin}/echo?other=saved`
      saved.collections[0].requests[1].editor.params[0].value = 'saved'
      await expect.poll(() => panel.evaluate(storedCollections)).toEqual(saved)
    }
    await evidence(panel, `pending-save-as-editor-${action}`)
  })
}

for (const rename of ['committed', 'in progress']) {
  test(`a pending Save as preserves a newer request name (${rename})`, async ({extension, api}) => {
    const panel = await extension.openPanel()
    await fill(panel, '#request-url', `${api.origin}/echo?original=yes`)
    await saveAs(panel, 'Original request', 'Widget API')
    const before = await panel.evaluate(storedCollections)

    await holdCollectionLock(panel)
    await click(panel, '#save-as')
    await fill(panel, '#save-request-name', 'Pending copy')
    await click(panel, '#confirm-save-as')
    await expectPendingCollectionSave(panel)
    await click(panel, '#cancel-save-as')
    await click(panel, '#request-name')
    await fill(panel, '#request-name-input', 'New user edit')
    if (rename === 'committed') await panel.keyboard.press('Enter')

    await releaseCollectionLock(panel)
    await expect(panel.locator('#confirm-save-as')).toBeEnabled()
    if (rename === 'in progress') {
      await expectValue(panel, '#request-name-input', 'New user edit')
      await panel.keyboard.press('Enter')
    }
    await expectText(panel, '#request-name', 'New user edit')
    const workspace = await savedWorkspaceWith(panel, 'name', 'New user edit')
    const saved = await panel.evaluate(storedCollections)
    expect(saved.collections[0].requests).toHaveLength(2)
    expect(saved.collections[0].requests[0]).toEqual(before.collections[0].requests[0])
    const copy = saved.collections[0].requests[1]
    expect(copy.editor).toEqual({...before.collections[0].requests[0].editor, name: 'Pending copy'})
    expect(workspace.draft.collectionRequest).toEqual({collectionId: saved.collections[0].id, requestId: copy.id})
    await evidence(panel, `pending-save-as-name-${rename.replaceAll(' ', '-')}`)

    // The newer name remains an unsaved edit to the copy until the next explicit Save.
    await click(panel, '#save-request')
    await expect.poll(async () => (await panel.evaluate(storedCollections)).collections[0].requests[1].editor.name)
      .toBe('New user edit')
    expect((await panel.evaluate(storedCollections)).collections[0].requests[0]).toEqual(before.collections[0].requests[0])
  })
}

test('Save as becomes usable when a pending linked Save finishes', async ({extension, api}) => {
  const panel = await extension.openPanel()
  await fill(panel, '#request-url', `${api.origin}/echo?original=yes`)
  await saveAs(panel, 'Original request', 'Widget API')
  await fill(panel, '#request-url', `${api.origin}/echo?updated=yes`)
  await holdCollectionLock(panel)
  await click(panel, '#save-request')
  await expectPendingCollectionSave(panel)
  await click(panel, '#save-as')
  await expect(panel.locator('#save-collection option')).toHaveText(['\u{1F4DA} Widget API (root)', '\uff0b New collection'])
  await expect(panel.locator('#confirm-save-as')).toBeDisabled()

  await releaseCollectionLock(panel)
  await expectText(panel, '#collection-save-status', 'Request saved to collection.')
  await fill(panel, '#save-request-name', 'Copy after Save')
  await expect(panel.locator('#confirm-save-as')).toBeEnabled()
  await evidence(panel, 'save-as-enabled-after-pending-save')
  await click(panel, '#confirm-save-as')
  await expectHidden(panel, '#save-as-dialog')
  await expectText(panel, '#request-name', 'Copy after Save')
  const {collections: [collection]} = await panel.evaluate(storedCollections)
  expect(collection.requests.map(({editor}) => editor.name)).toEqual(['Original request', 'Copy after Save'])
  expect(collection.requests.map(({editor}) => editor.url)).toEqual(Array(2).fill(`${api.origin}/echo?updated=yes`))
})

test('Save as groups each collection with its root first and folders as paths', async ({extension, api}) => {
  const panel = await extension.openPanel()
  await fill(panel, '#request-url', `${api.origin}/echo`)
  await saveAs(panel, 'Root request', 'Widget API')
  await click(panel, '#show-collections')
  const collectionRow = panel.locator('.collection-row').filter({has: panel.locator('[data-collection-name]')})
  await collectionRow.getByRole('button', {name: 'Add folder', exact: true}).click()
  await fill(panel, '#collection-item-name', 'Users')
  await click(panel, '#confirm-collection-item')
  await expectHidden(panel, '#collection-item-form')
  const usersRow = panel.locator('.collection-row').filter({has: panel.locator('[data-item-name]').filter({hasText: /^Users$/})})
  await usersRow.getByRole('button', {name: 'Add folder', exact: true}).click()
  await fill(panel, '#collection-item-name', 'Admins')
  await click(panel, '#confirm-collection-item')
  await expectHidden(panel, '#collection-item-form')
  await click(panel, '#new-collection')
  await fill(panel, '#collection-item-name', 'Other API')
  await click(panel, '#confirm-collection-item')
  await expectHidden(panel, '#collection-item-form')
  await click(panel, '#close-collections')

  await click(panel, '#save-as')
  const picker = panel.locator('#save-collection')
  await expect(picker.locator('optgroup')).toHaveCount(2)
  const groups = await picker.locator('optgroup').evaluateAll((nodes) => nodes.map((group) => ({
    label: group.label, options: Array.from(group.querySelectorAll('option'), (option) => option.textContent)
  })))
  expect(groups.map(({label}) => label).sort()).toEqual(['Other API', 'Widget API'])
  const widgetGroup = groups.find(({label}) => label === 'Widget API')
  const otherGroup = groups.find(({label}) => label === 'Other API')
  expect(widgetGroup.options).toEqual([
    '\u{1F4DA} Widget API (root)', folderOption('Users'), folderOption('Users', 'Admins')
  ])
  expect(otherGroup.options).toEqual(['\u{1F4DA} Other API (root)'])
  await expect(picker.locator(':scope > option')).toHaveText(['\uff0b New collection'])
  await picker.selectOption({label: folderOption('Users', 'Admins')})
  await fill(panel, '#save-request-name', 'Admin request')
  await click(panel, '#confirm-save-as')
  await expectHidden(panel, '#save-as-dialog')
  const {collections} = await panel.evaluate(storedCollections)
  const widget = collections.find(({name}) => name === 'Widget API')
  const users = widget.requests.find((item) => item.name === 'Users')
  const admins = users.requests.find((item) => item.name === 'Admins')
  expect(admins.requests.map(({editor}) => editor.name)).toEqual(['Admin request'])
  await evidence(panel, 'save-as-grouped-destinations')
})

test('New request in the header opens a blank, unsaved request and keeps the saved one', async ({extension, api}) => {
  const panel = await extension.openPanel()
  await fill(panel, '#request-url', `${api.origin}/echo?kept=yes`)
  await saveAs(panel, 'Kept request', 'Widget API')
  await expectVisible(panel, '#save-as')
  await click(panel, '#new-request')
  await expectValue(panel, '#request-url', '')
  await expect(panel.locator('#request-url')).toBeFocused()
  await expectHidden(panel, '#request-collection')
  await expectHidden(panel, '#save-as')
  await expectText(panel, '#request-name', 'Untitled request')
  // The new request saves as a second request, so the first one is unchanged.
  await fill(panel, '#request-url', `${api.origin}/echo?new=yes`)
  await saveAs(panel, 'New one')
  const saved = await panel.evaluate(storedCollections)
  const urls = saved.collections[0].requests.map((request) => request.editor.url)
  expect(urls).toEqual([`${api.origin}/echo?kept=yes`, `${api.origin}/echo?new=yes`])
  // The header must fit a narrow side panel with the extra button.
  await panel.setViewportSize({width: 280, height: 820})
  const header = panel.locator('.app-header')
  expect(await header.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true)
  await expect(panel.getByRole('button', {name: 'New request', exact: true})).toBeVisible()
})
