/** Exercise autocomplete in the real Chromium extension with real storage and editor events. */
import {test, expect} from './fixtures.mjs'
import {suggestionsCollection} from '../tests/helpers/env-suggestions.mjs'
import {chooseNewRequestDestination, savedWorkspaceWith, storedWorkspace, send} from './panel-helpers.mjs'

/** Install a nested collection through real extension storage and open its API through the collection list. */
async function openApi(extension) {
  const panel = await extension.openPanel()
  const collection = suggestionsCollection()
  const editor = collection.requests[0].requests[0].requests[0].editor
  editor.params = []
  editor.headers = []
  editor.body = ''
  await panel.evaluate(saveCollection, collection)
  await panel.locator('#show-collections').click()
  await panel.locator('[data-open-collection-request="get-item"]').click()
  await expect(panel.locator('#collections-dialog')).toBeHidden()
  await expect(panel.locator('#env-picker')).toHaveValue('local')
  return panel
}

/** Seed only collection keys; autocomplete still reads and resolves the production storage data. */
async function saveCollection(collection) {
  await chrome.storage.local.set({
    'browsercurl.collectionIndex': [{id: collection.id, name: collection.name}],
    [`browsercurl.collection.${collection.id}`]: collection
  })
}

/** Check sources and filtering, then insert within an existing token without submitting or losing text. */
async function sourceAndKeyboardWorkflow({extension}) {
  const panel = await openApi(extension)
  const url = panel.locator('#request-url')
  const list = panel.getByRole('listbox', {name: 'Environment variables'})
  await url.fill('{{')
  await expect(list.getByRole('option')).toHaveCount(8)
  await expect(list).not.toContainText('secret')
  await expect(list).not.toContainText('siblingOnly')
  await expect(list.locator('[data-source="collection"]')).toHaveText(['📚', '📚', '📚'])
  await expect(list.locator('[data-source="folder"]')).toHaveText(['📁', '📁', '📁'])
  await expect(list.locator('[data-source="api"]')).toHaveText(['POST', 'POST'])
  const bounds = await list.boundingBox()
  expect(bounds.width).toBeLessThanOrEqual(320)
  expect(bounds.height).toBeLessThanOrEqual(220)
  const shared = list.getByRole('option').filter({hasText: '{{shared}}'})
  await expect(shared).toContainText('Folder · Shop / Outer / Items')
  await url.fill('{{TO')
  await expect(list.getByRole('option')).toHaveCount(1)
  await expect(list).toContainText('API · Shop / Outer / Items / Get item')
  await url.press('Enter')
  await expect(url).toHaveValue('{{token}}')
  await expect(list).toBeHidden()
  await expect(panel.locator('#response-stats')).toBeHidden()
  await url.fill('https://example.test/{{ba}}/tail')
  await url.press('Home')
  for (let index = 0; index < 24; index++) await url.press('ArrowRight')
  await expect(list.getByRole('option')).toHaveCount(1)
  await url.press('Tab')
  await expect(url).toHaveValue('https://example.test/{{baseUrl}}/tail')
  await expect(url).toBeFocused()
  await savedWorkspaceWith(panel, 'url', 'https://example.test/{{baseUrl}}/tail')
}
test('typing {{ shows source icons and supports filtering, Enter, Tab, and existing references', sourceAndKeyboardWorkflow)

/** Check pointer insertion and normal URL synchronization in every field that supports variable substitution. */
async function requestFieldsWorkflow({extension}) {
  const panel = await openApi(extension)
  const list = panel.getByRole('listbox', {name: 'Environment variables'})
  for (const [tab, selector] of [
    ['#params-tab', '#params-rows [data-field="key"]'],
    ['#params-tab', '#params-rows [data-field="value"]'],
    ['#headers-tab', '#headers-rows [data-field="key"]'],
    ['#headers-tab', '#headers-rows [data-field="value"]'],
    ['#body-tab', '#request-body'],
    ['#auth-tab', '#bearer-token']
  ]) {
    await panel.locator(tab).click()
    const field = panel.locator(selector).first()
    await field.fill('before {{tok')
    await expect(list.getByRole('option')).toHaveCount(1)
    await list.getByRole('option').click()
    await expect(field).toHaveValue('before {{token}}')
    await expect(field).toBeFocused()
    await expect(list).toBeHidden()
  }
  await expect(panel.locator('#request-url')).toHaveValue('https://example.test/items?before+{{token}}=before+{{token}}')
  await savedWorkspaceWith(panel, 'body', 'before {{token}}')
  /** Wait for the last field's debounce instead of observing an earlier body save. */
  async function savedToken() {
    const workspace = await panel.evaluate(storedWorkspace)
    return workspace.draft.editor.authValues['bearer-token']
  }
  await expect.poll(savedToken).toBe('before {{token}}')
  const workspace = await panel.evaluate(storedWorkspace)
  expect(workspace.draft.editor.authValues['bearer-token']).toBe('before {{token}}')
  expect(workspace.draft.editor.headers[0].value).toBe('before {{token}}')
}
test('pointer selection works in parameter, header, body, and authorization fields and saves the draft', requestFieldsWorkflow)

/** Check selection, dismissal, missing matches, env changes, and fields with no collection context. */
async function dismissalAndContextWorkflow({extension}) {
  const panel = await openApi(extension)
  const url = panel.locator('#request-url')
  const list = panel.getByRole('listbox', {name: 'Environment variables'})
  await url.fill('{{')
  await expect(list).toBeVisible()
  await url.press('ArrowUp')
  await expect(list.getByRole('option', {selected: true})).toContainText('{{unfilled}}')
  await url.press('ArrowDown')
  await expect(list.getByRole('option', {selected: true})).toContainText('{{apiOnly}}')
  await url.press('Escape')
  await expect(list).toBeHidden()
  await expect(url).toHaveValue('{{')
  await url.fill('{{tok')
  await expect(list).toBeVisible()
  await url.press('Control+A')
  await url.press('Enter')
  await expect(list).toBeHidden()
  await expect(url).toHaveValue('{{tok')
  await expect(panel.locator('#response-stats')).toBeHidden()
  await url.fill('{{unknown')
  await expect(list).toBeHidden()
  await panel.locator('#env-picker').selectOption('production')
  await url.fill('{{prod')
  await expect(list).toContainText('{{prodOnly}}')
  await panel.locator('#env-picker').selectOption('')
  await url.fill('{{')
  await expect(list.getByRole('option')).toHaveCount(6)
  await panel.locator('#headers-tab').click()
  await expect(list).toBeHidden()
  await panel.locator('#new-request').click()
  await chooseNewRequestDestination(panel, 'none')
  await panel.locator('#confirm-new-request').click()
  await url.fill('{{')
  await expect(list).toBeHidden()
}
test('keyboard navigation and dismissal preserve edits and suggestions follow the selected env', dismissalAndContextWorkflow)

/** Check history uses its source API and sends the inserted reference through the real local HTTP service. */
async function historyAndSendWorkflow({extension, api}) {
  const panel = await openApi(extension)
  await panel.locator('#request-url').fill(`${api.origin}/echo`)
  await panel.locator('#auth-tab').click()
  await panel.locator('#bearer-token').fill('{{tok')
  await expect(panel.getByRole('listbox')).toBeVisible()
  await panel.locator('#bearer-token').press('Enter')
  await send(panel)
  expect(api.requests[0].headers.authorization).toBe('Bearer api-secret')
  await panel.locator('#show-history').click()
  await panel.locator('[data-open-history]').first().click()
  await expect(panel.locator('#env-picker')).toBeHidden()
  await panel.locator('#request-url').fill('{{sha')
  await expect(panel.getByRole('listbox')).toContainText('Folder · Shop / Outer / Items')
  await panel.getByRole('listbox').getByRole('option').click()
  await expect(panel.locator('#request-url')).toHaveValue('{{shared}}')
}
test('autocomplete uses the API source in history and inserted references resolve when sending', historyAndSendWorkflow)

/** Check a narrow sidebar, multiline insertion, dynamically added rows, and deletion of the source collection. */
async function narrowSidebarWorkflow({extension}) {
  const panel = await openApi(extension)
  await panel.setViewportSize({width: 360, height: 720})
  await panel.emulateMedia({colorScheme: 'dark'})
  const list = panel.getByRole('listbox', {name: 'Environment variables'})
  await panel.locator('#headers-tab').click()
  await panel.locator('[data-add="headers"]').click()
  const header = panel.locator('#headers-rows [data-field="value"]').last()
  await header.fill('{{fol')
  await expect(list).toBeVisible()
  const bounds = await list.boundingBox()
  expect(bounds.x).toBeGreaterThanOrEqual(0)
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(360)
  expect(bounds.y).toBeGreaterThanOrEqual(0)
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(720)
  await list.getByRole('option').click()
  await expect(header).toHaveValue('{{folderOnly}}')
  await panel.locator('#body-tab').click()
  const body = panel.locator('#request-body')
  await body.fill('{\n  "token": "{{to}}"\n}')
  await body.press('Control+Home')
  await body.press('ArrowDown')
  await body.press('End')
  await body.press('ArrowLeft')
  await body.press('ArrowLeft')
  await body.press('ArrowLeft')
  await expect(list).toBeVisible()
  await body.press('Enter')
  await expect(body).toHaveValue('{\n  "token": "{{token}}"\n}')
  await body.fill('{{')
  await expect(list).toBeVisible()
  await panel.evaluate(deleteCollection)
  await expect(list).toBeHidden()
  await body.pressSequentially('tok')
  await expect(list).toBeHidden()
  await expect(body).toHaveValue('{{tok')
}

/** Remove only the seeded collection to check stale suggestions cannot outlive their source. */
async function deleteCollection() {
  await chrome.storage.local.remove('browsercurl.collection.shop')
}
test('suggestions fit a narrow sidebar and preserve multiline text and dynamically added rows', narrowSidebarWorkflow)
