/** Record a continuous, captioned walkthrough against real extension storage and a local HTTP service. */
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {test, expect} from './fixtures.mjs'
import {forkBase, send, storedCollections, storedHistory} from './panel-helpers.mjs'

test.skip(process.env.FACTORY_EVIDENCE !== '1', 'Run with FACTORY_EVIDENCE=1 to record the extended feature walkthrough.')

/** Identify a collection, folder, or API by its displayed name. */
function collectionRow(panel, name) {
  const pattern = new RegExp(`^${name}$`)
  const label = panel.locator('[data-item-name]').filter({hasText: pattern})
  return panel.locator('.collection-row').filter({has: label})
}

/** Show a recording-only caption above modal dialogs without changing the product's layout or focus. */
function showCaption(text) {
  let caption = document.querySelector('#feature-tour-caption')
  if (!caption) {
    caption = document.createElement('div')
    caption.id = 'feature-tour-caption'
    caption.setAttribute('popover', 'manual')
    Object.assign(caption.style, {
      position: 'fixed', inset: 'auto 24px 18px', margin: '0', padding: '14px 18px',
      width: 'calc(100% - 48px)', boxSizing: 'border-box', border: '1px solid #555',
      borderLeft: '4px solid #ed683e', borderRadius: '7px', background: '#12151df5',
      color: 'white', font: '16px/1.5 system-ui', pointerEvents: 'none', boxShadow: '0 4px 20px #0005'
    })
    document.body.append(caption)
  }
  caption.textContent = text
  if (caption.matches(':popover-open')) caption.hidePopover()
  caption.showPopover()
}

/** Hold verified checkpoints long enough to read their captions and record their chapter times. */
async function checkpoint(panel, text, chapters, startedAt) {
  const elapsed = Date.now() - startedAt
  const seconds = Math.floor(elapsed / 1000)
  chapters.push({seconds, title: text})
  console.log(text)
  await panel.evaluate(showCaption, text)
  // This delay is recording pace; assertions already establish the state before each checkpoint.
  await panel.waitForTimeout(6000)
}

/** Create Base names and local values through the same environment editor that users operate. */
async function configureEnv(panel, level, values) {
  await panel.locator('#show-collections').click()
  await collectionRow(panel, level).getByRole('button', {name: 'Environments', exact: true}).click()
  for (const name of Object.keys(values)) {
    await panel.locator('#env-base-name').fill(name)
    await panel.locator('#env-add-name').click()
    await expect(panel.locator('#env-base-name')).toHaveValue('')
  }
  await forkBase(panel, 'local')
  for (const [name, value] of Object.entries(values)) {
    await panel.getByRole('textbox', {name: `Value for ${name}`, exact: true}).fill(value)
  }
}

/** Return from the environment editor to the current request without discarding queued value saves. */
async function closeEnv(panel) {
  await panel.locator('#env-close').click()
  await panel.locator('#close-collections').click()
}

/** Open a saved API from the real collection tree. */
async function openApi(panel, name) {
  await panel.locator('#show-collections').click()
  await collectionRow(panel, name).locator('[data-open-collection-request]').click()
  await expect(panel.locator('#collections-dialog')).toBeHidden()
}

/** Exercise scoped suggestions, all request fields, native destinations, persistence, history, and export in one recording. */
async function featureTour({extension, api}) {
  test.setTimeout(360000)
  await mkdir('.factory-evidence', {recursive: true})
  const panel = await extension.openPanel()
  const video = panel.video()
  const startedAt = Date.now()
  const chapters = []
  await panel.emulateMedia({colorScheme: 'light'})
  await panel.locator('#new-request').click()
  await expect(panel.locator('#new-request-dialog')).toBeHidden()
  await checkpoint(panel, '01 · No collections: New request opens the editor directly.', chapters, startedAt)

  await panel.locator('#request-url').pressSequentially('{{baseUrl}}/echo', {delay: 70})
  await panel.locator('#save-request').click()
  await panel.locator('#save-request-name').fill('List orders')
  await panel.locator('#new-collection-name').fill('Store API')
  await panel.locator('#confirm-save-as').click()
  await expect(panel.locator('#save-as-dialog')).toBeHidden()
  await panel.locator('#show-collections').click()
  await collectionRow(panel, 'Store API').getByRole('button', {name: 'Add folder', exact: true}).click()
  await panel.locator('#collection-item-name').fill('Orders')
  await panel.locator('#confirm-collection-item').click()
  await expect(panel.locator('#collection-item-form')).toBeHidden()
  await panel.locator('#close-collections').click()
  await panel.locator('#save-as').click()
  await expect(panel.locator('#save-collection .destination-root')).toHaveCount(1)
  await panel.locator('#save-request-name').fill('Get order')
  const choices = panel.locator('#save-collection option')
  const folder = await choices.filter({hasText: 'Orders'}).getAttribute('value')
  await panel.locator('#save-collection').selectOption(folder)
  await checkpoint(panel, '02 · Save as lists each collection once, followed by its folders.', chapters, startedAt)
  await panel.locator('#confirm-save-as').click()
  await expect(panel.locator('#save-as-dialog')).toBeHidden()

  await configureEnv(panel, 'Store API', {baseUrl: api.origin, apiKey: 'collection-demo-token', shared: 'collection-value'})
  await checkpoint(panel, '03 · Collection env: shared URL and credentials are kept in the local fork.', chapters, startedAt)
  await closeEnv(panel)
  await configureEnv(panel, 'Orders', {orderId: '42', shared: 'folder-value'})
  await checkpoint(panel, '04 · Folder env: orderId is local to Orders; shared overrides the collection.', chapters, startedAt)
  await closeEnv(panel)
  await configureEnv(panel, 'Get order', {apiKey: 'api-demo-token', requestLabel: 'order-request'})
  await checkpoint(panel, '05 · API env: apiKey overrides its parent; requestLabel belongs to this API.', chapters, startedAt)
  await closeEnv(panel)
  await panel.locator('#env-picker').selectOption('local')
  await openApi(panel, 'Get order')

  const url = panel.locator('#request-url')
  const suggestions = panel.getByRole('listbox', {name: 'Environment variables'})
  await url.fill('{{')
  await expect(suggestions.getByRole('option')).toHaveCount(5)
  await expect(suggestions).toContainText('Collection · Store API')
  await expect(suggestions).toContainText('Folder · Store API / Orders')
  await expect(suggestions).toContainText('API · Store API / Orders / Get order')
  await checkpoint(panel, '06 · Type {{ to see available variables with collection, folder, and API origins.', chapters, startedAt)
  await suggestions.getByRole('option').filter({hasText: '{{baseUrl}}'}).click()
  await url.pressSequentially('/echo?order={{or', {delay: 90})
  await expect(suggestions.getByRole('option')).toHaveCount(1)
  await checkpoint(panel, '07 · Typing filters variable names. Enter inserts the complete {{orderId}} reference.', chapters, startedAt)
  await url.press('Enter')
  await expect(url).toHaveValue('{{baseUrl}}/echo?order={{orderId}}')

  await panel.locator('#headers-tab').click()
  await panel.locator('#headers-rows [data-field="key"]').first().fill('X-Api-Key')
  const headerValue = panel.locator('#headers-rows [data-field="value"]').first()
  await headerValue.fill('{{')
  await headerValue.press('ArrowDown')
  await headerValue.press('ArrowUp')
  await headerValue.fill('{{api')
  await checkpoint(panel, '08 · Headers support suggestions too. Arrow keys navigate; Tab inserts without submitting.', chapters, startedAt)
  await headerValue.press('Tab')
  await expect(headerValue).toHaveValue('{{apiKey}}')
  await panel.locator('#params-tab').click()
  const parameter = panel.locator('#params-rows [data-field="value"]').first()
  await parameter.fill('{{ord')
  await suggestions.getByRole('option').click()
  await expect(parameter).toHaveValue('{{orderId}}')
  await checkpoint(panel, '09 · Parameter selection keeps the URL synchronized and preserves the template.', chapters, startedAt)

  await panel.locator('#auth-tab').click()
  await panel.locator('#auth-type').selectOption('bearer')
  await panel.locator('#bearer-token').fill('{{api')
  await expect(suggestions).toContainText('API · Store API / Orders / Get order')
  await panel.locator('#bearer-token').press('Enter')
  await checkpoint(panel, '10 · Authorization uses the nearest API variable, shown with the existing HTTP method badge.', chapters, startedAt)
  await panel.locator('#request-method').selectOption('POST')
  await panel.locator('#body-tab').click()
  const body = panel.locator('#request-body')
  await body.fill('{\n  "scope": "{{sha')
  await expect(suggestions).toContainText('Folder · Store API / Orders')
  await body.press('Enter')
  await body.pressSequentially('",\n  "label": "{{req', {delay: 90})
  await body.press('Enter')
  await body.pressSequentially('"\n}', {delay: 90})
  await expect(body).toHaveValue('{\n  "scope": "{{shared}}",\n  "label": "{{requestLabel}}"\n}')
  await checkpoint(panel, '11 · Multiline body suggestions preserve surrounding JSON and show the effective folder source.', chapters, startedAt)
  await panel.locator('#save-request').click()
  await expect(panel.locator('#collection-save-status')).toHaveText('Request saved to collection.')
  await send(panel)
  expect(api.requests[0].url).toBe('/echo?order=42')
  expect(api.requests[0].headers.authorization).toBe('Bearer api-demo-token')
  expect(api.requests[0].headers['x-api-key']).toBe('api-demo-token')
  expect(JSON.parse(api.requests[0].body)).toEqual({scope: 'folder-value', label: 'order-request'})
  await panel.locator('#response-resizer').press('End')
  await checkpoint(panel, '12 · Real HTTP response: order=42, API credentials, folder fallback, and resolved JSON.', chapters, startedAt)

  await panel.locator('#response-resizer').press('Home')
  await panel.locator('#env-picker').selectOption('')
  await panel.locator('#send-request').click()
  await expect(panel.locator('#request-error')).toContainText('Missing variables')
  expect(api.requests).toHaveLength(1)
  await checkpoint(panel, '13 · No env blocks unresolved variables before sending. Existing request text stays intact.', chapters, startedAt)
  await panel.locator('#env-picker').selectOption('local')
  await panel.locator('#show-history').click()
  await panel.locator('[data-open-history]').first().click()
  await send(panel)
  expect(api.requests[1].headers.authorization).toBe('Bearer api-demo-token')
  await checkpoint(panel, '14 · History resends the saved template using the current collection, folder, and API values.', chapters, startedAt)
  await panel.locator('#back-to-draft').click()

  const beforeNew = await panel.evaluate(storedCollections)
  await panel.locator('#new-request').click()
  const picker = panel.locator('#new-request-collection')
  await expect(picker.locator('option')).toHaveCount(3)
  await expect(picker.locator('optgroup')).toHaveCount(0)
  await expect(picker).toHaveCSS('font-size', '13px')
  await picker.selectOption(folder)
  await checkpoint(panel, '15 · New request uses the native list with larger options and one clickable collection entry.', chapters, startedAt)
  await panel.locator('#cancel-new-request').click()
  await expect(url).toHaveValue('{{baseUrl}}/echo?order={{orderId}}')
  await panel.locator('#new-request').click()
  await picker.selectOption(folder)
  await panel.locator('#confirm-new-request').click()
  await expect(url).toHaveValue('')
  expect(await panel.evaluate(storedCollections)).toEqual(beforeNew)
  await url.fill('{{')
  await expect(suggestions).not.toContainText('requestLabel')
  await checkpoint(panel, '16 · A new folder request stays unsaved and inherits only its collection and folder variables.', chapters, startedAt)
  await suggestions.getByRole('option').filter({hasText: '{{baseUrl}}'}).click()
  await url.pressSequentially('/echo', {delay: 90})
  await panel.locator('#auth-tab').click()
  await panel.locator('#auth-type').selectOption('bearer')
  await panel.locator('#bearer-token').fill('inline-demo-credential')
  await panel.locator('#save-request').click()
  await expect(panel.locator('#save-collection')).toHaveValue(folder)
  await panel.locator('#save-request-name').fill('New order draft')
  await checkpoint(panel, '17 · Save remembers the chosen folder. This example also has a credential entered directly.', chapters, startedAt)
  await panel.locator('#confirm-save-as').click()
  await expect(panel.locator('#save-as-dialog')).toBeHidden()

  await panel.emulateMedia({colorScheme: 'dark'})
  await panel.locator('#new-request').click()
  await picker.selectOption('none')
  await checkpoint(panel, '18 · The same native picker works in dark mode and still offers No collection.', chapters, startedAt)
  await panel.locator('#cancel-new-request').click()
  await panel.locator('#show-collections').click()
  await collectionRow(panel, 'Store API').getByRole('button', {name: 'Export', exact: true}).click()
  await expect(panel.locator('#collection-export-message')).toContainText('excludes environment values')
  await checkpoint(panel, '19 · Export explains the boundary: env values are excluded; directly entered credentials remain included.', chapters, startedAt)
  const downloadReady = panel.waitForEvent('download')
  await panel.locator('#confirm-collection-export').click()
  const download = await downloadReady
  const exportPath = await download.path()
  const exported = await readFile(exportPath, 'utf8')
  expect(exported).not.toContain('api-demo-token')
  expect(exported).not.toContain('collection-demo-token')
  expect(exported).not.toContain('folder-value')
  expect(exported).not.toContain(api.origin)
  expect(exported).toContain('inline-demo-credential')
  await panel.locator('#close-collections').click()
  await send(panel)
  expect(api.requests[2].headers.authorization).toBe('Bearer inline-demo-credential')
  const history = await panel.evaluate(storedHistory)
  expect(history).toHaveLength(3)
  await checkpoint(panel, '20 · Passed: scoped suggestions, keyboard and mouse selection, native destinations, Save, history, and export.', chapters, startedAt)
  const chapterJson = JSON.stringify(chapters, null, 2)
  await writeFile('.factory-evidence/feature-tour-chapters.json', chapterJson + '\n')
  await panel.close()
  await video.saveAs('.factory-evidence/env-feature-tour.webm')
}
test('extended feature walkthrough with continuous video and real HTTP assertions', featureTour)
