/** Postman envs arrive ready to send and leave the device as names only. */
import {appendFile, readFile, writeFile} from 'node:fs/promises'
import {test, expect} from './fixtures.mjs'
import {click, fill, forkBase, send, echoedRequest, storedCollections} from './panel-helpers.mjs'

const schema = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'

async function capture(panel, name) {
  if (process.env.FACTORY_EVIDENCE !== '1') return
  await panel.screenshot({path: `.factory-evidence/${name}.png`})
  await appendFile('.factory-evidence/postman-env-captures.jsonl', JSON.stringify({name, video: await panel.video().path()}) + '\n')
}

async function importFile(panel, source) {
  await click(panel, '#show-collections')
  const ready = panel.waitForEvent('filechooser')
  await click(panel, '#import-collection')
  await (await ready).setFiles({name: 'envs.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(source))})
  await expect(panel.locator('#collection-import-summary')).toHaveText(`Imported “${source.info.name}”.`)
}

function source(origin) {
  return {
    info: {name: 'Shared env API', schema},
    variable: [{key: ' baseUrl ', value: origin}, {key: 'token', value: 'collection-token'}, {key: 'empty', value: ''}],
    item: [{name: 'Folder', variable: [{key: 'token', value: 'folder-token'}, {key: 'header', value: 'file-header'}], item: [
      {name: 'Send with imported env', variable: [{key: 'body', value: 'file-body'}], request: {
        method: 'POST', url: '{{baseUrl}}/echo', header: [{key: 'X-File', value: '{{header}}'}],
        body: {mode: 'raw', raw: '{"value":"{{body}}"}', options: {raw: {language: 'json'}}},
        auth: {type: 'bearer', bearer: [{key: 'token', value: '{{token}}', type: 'string'}]}
      }}
    ]}, {name: 'No base names', item: []}]
  }
}

async function openEnv(panel, name) {
  const level = panel.locator('.collection-row').filter({has: panel.locator('[data-item-name]', {hasText: name})})
  await level.getByRole('button', {name: 'Environments', exact: true}).click()
  await expect(panel.locator('#env-editor')).toBeVisible()
}

test('import chooses imported and sends collection, folder, and request values from the file after restart', async ({extension, api}) => {
  let panel = await extension.openPanel()
  await panel.setViewportSize({width: 480, height: 1050})
  const file = source(api.origin)
  file.item[0].variable.push({key: 'bad{key', value: 'skipped'})
  await importFile(panel, file)
  await expect(panel.locator('#collection-import-warnings')).toContainText('bad{key')
  await expect(panel.locator('#collection-import-warnings')).toContainText('Shared env API / Folder')
  await capture(panel, 'postman-env-import-warning')
  await click(panel, '#dismiss-collection-import')
  for (const [level, names, variable, value] of [
    ['Shared env API', ['baseUrl', 'token', 'empty'], 'baseUrl', api.origin],
    ['Folder', ['token', 'header'], 'token', 'folder-token'],
    ['Send with imported env', ['body'], 'body', 'file-body']
  ]) {
    await openEnv(panel, level)
    await expect(panel.locator('#env-content .env-variable-row > span')).toHaveText(names)
    await capture(panel, `postman-env-${variable}-base`)
    await panel.getByRole('tab', {name: 'imported', exact: true}).click()
    await expect(panel.getByRole('textbox', {name: `Value for ${variable}`, exact: true})).toHaveValue(value)
    await capture(panel, `postman-env-${variable}-imported`)
    await click(panel, '#env-close')
  }
  await panel.locator('[data-open-collection-request]').click()
  await expect(panel.locator('#env-picker')).toHaveValue('imported')
  await capture(panel, 'postman-env-imported-chosen')
  await extension.restart()
  panel = await extension.openPanel()
  await expect(panel.locator('#env-picker')).toHaveValue('imported')
  await send(panel)
  const received = await echoedRequest(panel)
  expect(received.url).toBe('/echo')
  expect(received.headers.authorization).toBe('Bearer folder-token')
  expect(received.headers['x-file']).toBe('file-header')
  expect(received.body).toBe('{"value":"file-body"}')
  await expect(panel.locator('#request-url')).toHaveValue('{{baseUrl}}/echo')
  await panel.locator('#response-resizer').press('End')
  await capture(panel, 'postman-env-sent-file-values')
  if (process.env.FACTORY_EVIDENCE === '1') {
    await writeFile('.factory-evidence/postman-env-server-requests.json', JSON.stringify(api.requests, null, 2) + '\n')
  }
})

test('export downloads base names with empty values at each level and omits forks and all their values', async ({extension, api}) => {
  const panel = await extension.openPanel()
  await panel.setViewportSize({width: 480, height: 1050})
  await importFile(panel, source(api.origin))
  await click(panel, '#dismiss-collection-import')
  await openEnv(panel, 'Shared env API')
  await forkBase(panel, 'local')
  await panel.getByRole('textbox', {name: 'Value for token', exact: true}).fill('local-secret')
  await fill(panel, '#env-variable-name', 'private-only')
  await click(panel, '#env-add-variable')
  await panel.getByRole('textbox', {name: 'Value for private-only', exact: true}).fill('private-secret')
  await expect.poll(async () => (await panel.evaluate(storedCollections)).collections[0].env.forks[1].variables.at(-1).value).toBe('private-secret')
  await capture(panel, 'postman-env-local-values-before-export')
  await click(panel, '#env-close')
  const before = await panel.evaluate(storedCollections)
  await panel.locator('.collection-row').filter({has: panel.locator('[data-collection-name]')}).getByRole('button', {name: 'Export', exact: true}).click()
  await expect(panel.locator('#collection-export-warning')).toContainText('contains saved credentials')
  await capture(panel, 'postman-env-export-credential-note')
  const ready = panel.waitForEvent('download')
  await click(panel, '#confirm-collection-export')
  const download = await ready
  expect(await download.failure()).toBeNull()
  const json = JSON.parse(await readFile(await download.path(), 'utf8'))
  expect(json.variable).toEqual([{key: 'baseUrl', value: ''}, {key: 'token', value: ''}, {key: 'empty', value: ''}])
  expect(json.item[0].variable).toEqual([{key: 'token', value: ''}, {key: 'header', value: ''}])
  expect(json.item[0].item[0].variable).toEqual([{key: 'body', value: ''}])
  expect(json.item[1]).not.toHaveProperty('variable')
  for (const privateText of ['local-secret', 'private-only', 'private-secret', 'collection-token', 'folder-token', 'file-header', 'file-body', api.origin, 'forks', 'chosenEnv']) {
    expect(JSON.stringify(json)).not.toContain(privateText)
  }
  const after = await panel.evaluate(storedCollections)
  expect(after.collections[0]).toEqual({...before.collections[0], postmanId: json.info._postman_id})
  await capture(panel, 'postman-env-export-downloaded')
  if (process.env.FACTORY_EVIDENCE === '1') await download.saveAs('.factory-evidence/env-names.postman_collection.json')
})
