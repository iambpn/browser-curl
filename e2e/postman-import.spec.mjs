/** Import files through the real picker, persist new collections, and send through the existing request path. */
import {appendFile, readFile} from 'node:fs/promises'
import {test, expect} from './fixtures.mjs'
import {click, echoedRequest, expectHidden, expectText, expectValue, send, storedCollections, storedHistory} from './panel-helpers.mjs'

async function capture(panel, name) {
  if (process.env.FACTORY_EVIDENCE !== '1') return
  await panel.screenshot({path: `.factory-evidence/${name}.png`})
  await appendFile('.factory-evidence/postman-captures.jsonl', JSON.stringify({name, video: await panel.video().path()}) + '\n')
}

/** Exercise the Import button's actual file chooser rather than calling converter or store internals. */
async function chooseFile(panel, buffer, name = 'collection.json') {
  const chooserReady = panel.waitForEvent('filechooser')
  await click(panel, '#import-collection')
  const chooser = await chooserReady
  expect(chooser.isMultiple()).toBe(false)
  await expect(panel.locator('#collection-file')).toHaveAttribute('accept', '.json')
  await chooser.setFiles({name, mimeType: 'application/json', buffer: Buffer.from(buffer)})
}

async function importAndSend({extension, api}) {
  let panel = await extension.openPanel()
  await panel.setViewportSize({width: 420, height: 1100})
  await click(panel, '#show-collections')
  const source = (await readFile(new URL('./data/postman-v2.1.json', import.meta.url), 'utf8')).replaceAll('TEST_ORIGIN', api.origin)
  await chooseFile(panel, source)
  await expect(panel.locator('[data-collection-name]')).toHaveText(['Imported Widget API'])
  await expect(panel.locator('[data-folder-name]')).toHaveText(['Widgets', 'Writes'])
  await expect(panel.locator('[data-collection-request-name]')).toHaveText(['Create widget', 'List widgets', 'Health'])
  await expect(panel.locator('[data-collection-method]')).toHaveText(['POST', 'GET', 'GET'])
  await expect(panel.locator('#collection-import-warnings li')).toHaveCount(3)
  await expect(panel.locator('#collection-import-warnings')).toContainText('Descriptions were dropped')
  await expect(panel.locator('#collection-import-warnings')).toContainText('Scripts and events were dropped')
  await expect(panel.locator('#collection-import-warnings')).toContainText('Saved example responses were dropped')
  await expect(panel.locator('#collection-import-warnings')).toContainText('Create widget')
  await panel.screenshot({path: '.factory-evidence/postman-import.png'})
  await capture(panel, 'postman-import-tree-and-warnings')
  const saved = await panel.evaluate(storedCollections)
  expect(saved.collections[0].postmanId).toBe('fixture-widget-api')
  expect(saved.collections[0].variables).toEqual([{key: 'unused', value: '{{unchanged}}', type: 'string'}])
  await click(panel, '#dismiss-collection-import')
  await expectHidden(panel, '#collection-import-notice')
  await panel.getByRole('button', {name: 'Collapse Imported Widget API', exact: true}).click()
  // Importing the same file again must create a separate, expanded tree, even with the same Postman ID.
  await chooseFile(panel, source)
  await expect(panel.locator('[data-collection-name]')).toHaveCount(2)
  await expect(panel.getByRole('button', {name: 'Collapse Imported Widget API', exact: true})).toBeVisible()
  const both = await panel.evaluate(storedCollections)
  expect(both.index).toHaveLength(2)
  expect(both.collections[0].id).not.toBe(both.collections[1].id)
  expect(both.collections[0].requests[0].id).not.toBe(both.collections[1].requests[0].id)
  await capture(panel, 'postman-duplicate-import-expanded')
  await panel.locator('[data-open-collection-request]').filter({hasText: 'Create widget'}).last().click()
  await expectHidden(panel, '#collections-dialog')
  await expectText(panel, '#request-name', 'Create widget')
  await expectValue(panel, '#request-method', 'POST')
  await expectValue(panel, '#request-url', `${api.origin}/echo?kept=yes`)
  for (const group of ['params', 'headers']) {
    await click(panel, `#${group}-tab`)
    const rows = panel.locator(`#${group}-rows .entry-row`)
    await expect(rows).toHaveCount(2)
    await expect(rows.last().locator('[data-field="enabled"]')).not.toBeChecked()
    await expect(rows.last().locator('[data-field="value"]')).toHaveValue('{{not-sent}}')
    await capture(panel, `postman-loaded-${group}`)
  }
  await click(panel, '#body-tab')
  await expectValue(panel, '#body-type', 'json')
  await expectValue(panel, '#request-body', '{"widget":"{{name}}"}')
  await capture(panel, 'postman-loaded-body')
  await click(panel, '#auth-tab')
  await expectValue(panel, '#auth-type', 'bearer')
  await expectValue(panel, '#bearer-token', 'folder-token')
  await capture(panel, 'postman-loaded-inherited-auth')
  // Imported requests are linked too: templates require a chosen collection env.
  const count = api.requests.length
  await click(panel, '#send-request')
  await expect(panel.locator('#request-error')).toContainText('“name”')
  await expect(panel.locator('#request-error')).toContainText('no env is chosen')
  expect(api.requests).toHaveLength(count)
  await click(panel, '#show-collections')
  await panel.getByRole('button', {name: 'Environments', exact: true}).last().click()
  await panel.locator('#env-base-name').fill('name')
  await click(panel, '#env-add-name')
  await expect(panel.locator('#env-base-name')).toHaveValue('')
  await panel.locator('#env-fork-name').fill('local')
  await click(panel, '#env-new-fork')
  await panel.getByRole('textbox', {name: 'Value for name', exact: true}).fill('imported-widget')
  await expect.poll(async () => {
    const {collections} = await panel.evaluate(storedCollections)
    return collections.some((collection) => collection.env.forks.some((fork) =>
      fork.variables.some((variable) => variable.name === 'name' && variable.value === 'imported-widget')))
  }).toBe(true)
  await click(panel, '#env-close')
  await click(panel, '#close-collections')
  await panel.locator('#env-picker').selectOption('local')
  await send(panel)
  const received = await echoedRequest(panel)
  expect(received.method).toBe('POST')
  expect(received.url).toBe('/echo?kept=yes')
  expect(received.headers['x-widget']).toBe('imported')
  expect(received.headers['x-disabled']).toBeUndefined()
  expect(received.headers['content-type']).toBe('application/json')
  expect(received.headers.authorization).toBe('Bearer folder-token')
  expect(received.body).toBe('{"widget":"imported-widget"}')
  const history = await panel.evaluate(storedHistory)
  expect(history).toHaveLength(1)
  expect(history[0].editor.body).toBe('{"widget":"{{name}}"}')
  await capture(panel, 'postman-sent-echo')
  await extension.restart()
  panel = await extension.openPanel()
  await click(panel, '#clear-request')
  await click(panel, '#show-collections')
  await expect(panel.locator('[data-collection-name]')).toHaveCount(2)
  await panel.locator('[data-open-collection-request]').filter({hasText: 'Health'}).last().click()
  await click(panel, '#auth-tab')
  await expectValue(panel, '#bearer-token', 'collection-token')
}
test('imports a v2.1 file as a new expanded collection, shows warnings, and sends with inherited auth and a collection env', importAndSend)

test('sends imported object URLs with decoded query rows and preserved empty path segments', async ({extension, api}) => {
  const panel = await extension.openPanel()
  const origin = new URL(api.origin)
  const query = [
    {key: 'q', value: 'hello%20world'},
    {key: 'encoded%20key', value: 'a%2Bb%26c%3Dd'},
    {key: 'off%20key', value: 'not%20sent', disabled: true}
  ]
  const source = {
    info: {name: 'URL regression API', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'},
    item: [
      {name: 'Raw object query', request: {method: 'GET', url: {raw: `${api.origin}/echo?q=hello%20world&encoded%20key=a%2Bb%26c%3Dd`, query}}},
      {name: 'Reconstructed object URL', request: {method: 'GET', url: {
        protocol: 'http', host: origin.hostname, port: origin.port, path: ['', 'v1', 'widgets'], query
      }}}
    ]
  }
  await click(panel, '#show-collections')
  await chooseFile(panel, JSON.stringify(source))
  for (const [name, path] of [['Raw object query', '/echo'], ['Reconstructed object URL', '//v1/widgets']]) {
    await panel.locator('[data-open-collection-request]').filter({hasText: name}).click()
    await click(panel, '#params-tab')
    const rows = panel.locator('#params-rows .entry-row')
    await expect(rows).toHaveCount(3)
    await expect(rows.nth(0).locator('[data-field="value"]')).toHaveValue('hello world')
    await expect(rows.nth(1).locator('[data-field="key"]')).toHaveValue('encoded key')
    await expect(rows.nth(1).locator('[data-field="value"]')).toHaveValue('a+b&c=d')
    await expect(rows.nth(2).locator('[data-field="enabled"]')).not.toBeChecked()
    await send(panel)
    expect((await echoedRequest(panel)).url).toBe(`${path}?q=hello+world&encoded+key=a%2Bb%26c%3Dd`)
    expect(api.requests.at(-1).url).toBe(`${path}?q=hello+world&encoded+key=a%2Bb%26c%3Dd`)
    await capture(panel, path === '/echo' ? 'postman-object-query-sent' : 'postman-empty-path-segment-sent')
    await click(panel, '#show-collections')
  }
})

test('imported raw URL references in disabled query rows do not block sending', async ({extension, api}) => {
  const panel = await extension.openPanel()
  const source = {
    info: {name: 'Disabled query API', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'},
    item: [{name: 'Disabled reference', request: {method: 'GET', url: {
      raw: `${api.origin}/echo?skip={{missing}}`, query: [{key: 'skip', value: '{{missing}}', disabled: true}]
    }}}]
  }
  await click(panel, '#show-collections')
  await chooseFile(panel, JSON.stringify(source))
  await panel.locator('[data-open-collection-request]').click()
  await expect(panel.locator('#request-url')).toHaveValue(`${api.origin}/echo?skip={{missing}}`)
  await expect(panel.locator('#params-rows [data-field="enabled"]')).not.toBeChecked()
  await send(panel)
  expect((await echoedRequest(panel)).url).toBe('/echo')
  await expect(panel.locator('#request-error')).toBeHidden()
  await capture(panel, 'postman-disabled-query-reference-sent')
})

for (const [name, source, error] of [
  ['invalid JSON', '{invalid', 'not valid JSON'],
  ['Postman v1', '{"name":"Old collection","requests":[]}', 'Postman Collection v2.0 or v2.1'],
  ['unrelated JSON', '{"settings":true}', 'Postman Collection v2.0 or v2.1']
]) {
  test(`rejects ${name} with a panel error and no new collection`, async ({extension}) => {
    const panel = await extension.openPanel()
    await click(panel, '#show-collections')
    await chooseFile(panel, source, 'wrong-file.json')
    await expect(panel.locator('#collections-error')).toContainText(error)
    expect(await panel.evaluate(storedCollections)).toEqual({index: [], collections: []})
    await expect(panel.locator('[data-collection-name]')).toHaveCount(0)
    await capture(panel, `postman-rejected-${name.replaceAll(' ', '-')}`)
  })
}
