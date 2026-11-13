/** Folder and request envs resolve through their saved ancestry in the real panel. */
import {appendFile, writeFile} from 'node:fs/promises'
import {test, expect} from './fixtures.mjs'
import {click, fill, send, echoedRequest, storedCollections} from './panel-helpers.mjs'

function row(panel, name) {
  return panel.locator('.collection-row').filter({has: panel.locator('[data-item-name]').filter({hasText: new RegExp(`^${name}$`)})})
}

async function proof(panel, name) {
  if (process.env.FACTORY_EVIDENCE !== '1') return
  if (name.startsWith('nested-env-sent-') || name === 'nested-env-history-chain') {
    await panel.locator('#response-resizer').press('End')
  }
  await panel.screenshot({path: `.factory-evidence/${name}.png`})
  await appendFile('.factory-evidence/nested-env-captures.jsonl', JSON.stringify({name, video: await panel.video().path()}) + '\n')
}

async function folder(panel, name, parent) {
  await row(panel, parent).getByRole('button', {name: 'Add folder', exact: true}).click()
  await fill(panel, '#collection-item-name', name)
  await click(panel, '#confirm-collection-item')
  await expect(panel.locator('#collection-item-form')).toBeHidden()
}

async function setup(panel) {
  await fill(panel, '#request-url', '{{baseUrl}}/echo')
  await click(panel, '#auth-tab')
  await panel.locator('#auth-type').selectOption('bearer')
  await fill(panel, '#bearer-token', '{{token}}')
  await click(panel, '#save-as')
  await fill(panel, '#save-request-name', 'Outside')
  await fill(panel, '#new-collection-name', 'API')
  await click(panel, '#confirm-save-as')
  await expect(panel.locator('#save-as-dialog')).toBeHidden()
  await click(panel, '#show-collections')
  await folder(panel, 'Outer', 'API')
  await folder(panel, 'Inner', 'Outer')
  await click(panel, '#close-collections')
  for (const name of ['Folder request', 'Override request']) {
    await click(panel, '#save-as')
    await fill(panel, '#save-request-name', name)
    await panel.locator('#save-collection').selectOption({label: '\u00a0'.repeat(4) + 'Inner'})
    await click(panel, '#confirm-save-as')
    await expect(panel.locator('#save-as-dialog')).toBeHidden()
  }
}

async function openEnv(panel, name) {
  await click(panel, '#show-collections')
  await row(panel, name).getByRole('button', {name: 'Environments', exact: true}).click()
  await expect(panel.locator('#env-editor')).toBeVisible()
  await expect(panel.locator('#env-collection-name')).toContainText(name)
}

async function setEnv(panel, level, fork, values) {
  await openEnv(panel, level)
  for (const name of Object.keys(values)) {
    await fill(panel, '#env-base-name', name)
    await click(panel, '#env-add-name')
    await expect(panel.locator('#env-base-name')).toHaveValue('')
  }
  await fill(panel, '#env-fork-name', fork)
  await click(panel, '#env-new-fork')
  await expect(panel.getByRole('tab', {name: fork, exact: true})).toHaveAttribute('aria-selected', 'true')
  for (const [name, value] of Object.entries(values)) {
    await panel.getByRole('textbox', {name: `Value for ${name}`, exact: true}).fill(value)
  }
  // Closing queues subsequent sends behind these storage edits.
  await proof(panel, `nested-env-${level.toLowerCase().replaceAll(' ', '-')}-${fork}`)
  await click(panel, '#env-close')
  await click(panel, '#close-collections')
}

async function loadRequest(panel, name) {
  await click(panel, '#show-collections')
  await row(panel, name).locator('[data-open-collection-request]').click()
  await expect(panel.locator('#collections-dialog')).toBeHidden()
}

test('nearest request and nested folder envs override ancestors, survive Save and restart, and resolve history', async ({extension, api}) => {
  let panel = await extension.openPanel()
  await setup(panel)
  await setEnv(panel, 'API', 'staging', {baseUrl: `${api.origin}/collection`, token: 'collection-token'})
  await setEnv(panel, 'Outer', 'staging', {baseUrl: `${api.origin}/outer`, token: 'folder-token'})
  await setEnv(panel, 'Inner', 'staging', {baseUrl: `${api.origin}/folder`})
  await setEnv(panel, 'Override request', 'staging', {baseUrl: '', token: 'request-token'})
  await panel.locator('#env-picker').selectOption('staging')
  // Saving a linked request must replace only its editor snapshot, retaining its env.
  await click(panel, '#save-request')
  await expect(panel.locator('#collection-save-status')).toHaveText('Request saved to collection.')
  await extension.restart()
  panel = await extension.openPanel()
  await expect(panel.locator('#env-picker')).toHaveValue('staging')
  for (const [name, path, token] of [
    ['Folder request', '/folder/echo', 'folder-token'],
    ['Override request', '/folder/echo', 'request-token'],
    ['Outside', '/collection/echo', 'collection-token']
  ]) {
    await loadRequest(panel, name)
    await send(panel)
    const echoed = await echoedRequest(panel)
    expect(echoed.url).toBe(path)
    expect(echoed.headers.authorization).toBe(`Bearer ${token}`)
    await expect(panel.locator('#request-url')).toHaveValue('{{baseUrl}}/echo')
    await proof(panel, `nested-env-sent-${name.toLowerCase().replaceAll(' ', '-')}`)
  }
  expect(api.requests.map(({url, headers}) => [url, headers.authorization])).toEqual([
    ['/folder/echo', 'Bearer folder-token'], ['/folder/echo', 'Bearer request-token'], ['/collection/echo', 'Bearer collection-token']
  ])
  if (process.env.FACTORY_EVIDENCE === '1') {
    await writeFile('.factory-evidence/nested-env-server-requests.json', JSON.stringify(api.requests, null, 2) + '\n')
  }
  // The history entry for the overridden request must use its current folder and request envs.
  await openEnv(panel, 'Override request')
  await panel.getByRole('tab', {name: 'staging', exact: true}).click()
  await panel.getByRole('textbox', {name: 'Value for token', exact: true}).fill('updated-token')
  await panel.emulateMedia({colorScheme: 'dark'})
  await proof(panel, 'nested-env-request-dark')
  await panel.emulateMedia({colorScheme: 'light'})
  await click(panel, '#env-close')
  await click(panel, '#close-collections')
  const before = await panel.evaluate(storedCollections)
  await click(panel, '#show-history')
  await panel.locator('[data-open-history]').nth(1).click()
  await expect(panel.locator('#env-picker')).toBeHidden()
  await send(panel)
  const echoed = await echoedRequest(panel)
  expect(echoed.url).toBe('/folder/echo')
  expect(echoed.headers.authorization).toBe('Bearer updated-token')
  expect(await panel.evaluate(storedCollections)).toEqual(before)
  await proof(panel, 'nested-env-history-chain')
})

test('a fork that exists only on a folder appears in the collection picker for an outside request', async ({extension}) => {
  const panel = await extension.openPanel()
  await setup(panel)
  await setEnv(panel, 'Inner', 'folder-only', {baseUrl: 'https://folder.example.test'})
  await loadRequest(panel, 'Outside')
  await expect(panel.locator('#env-picker option')).toHaveText(['No env', 'folder-only'])
  await panel.locator('#env-picker').selectOption('folder-only')
  await expect.poll(async () => (await panel.evaluate(storedCollections)).collections[0].chosenEnv).toBe('folder-only')
  await proof(panel, 'nested-env-folder-only-picker')
})

test('deleting folders and requests removes their envs and clears the last chosen fork name', async ({extension}) => {
  const panel = await extension.openPanel()
  await setup(panel)
  await setEnv(panel, 'Inner', 'folder-only', {baseUrl: 'https://deleted.example.test'})
  await setEnv(panel, 'Override request', 'request-only', {token: 'deleted-secret'})
  await loadRequest(panel, 'Outside')
  await expect(panel.locator('#env-picker option')).toHaveText(['No env', 'folder-only', 'request-only'])
  await panel.locator('#env-picker').selectOption('request-only')
  await click(panel, '#show-collections')
  await row(panel, 'Override request').getByRole('button', {name: 'Delete', exact: true}).click()
  await expect(row(panel, 'Override request')).toHaveCount(0)
  await click(panel, '#close-collections')
  await expect(panel.locator('#env-picker')).toHaveValue('')
  expect(JSON.stringify(await panel.evaluate(storedCollections))).not.toContain('deleted-secret')
  await panel.locator('#env-picker').selectOption('folder-only')
  const before = await panel.evaluate(storedCollections)
  expect(before.collections[0].requests[1].requests[0].env.forks[0].name).toBe('folder-only')
  await click(panel, '#show-collections')
  await row(panel, 'Outer').getByRole('button', {name: 'Delete', exact: true}).click()
  await expect(panel.locator('#collection-delete-warning')).toBeVisible()
  await proof(panel, 'nested-env-folder-delete-confirm')
  await click(panel, '#confirm-collection-delete')
  await expect(row(panel, 'Outer')).toHaveCount(0)
  const after = await panel.evaluate(storedCollections)
  expect(after.collections[0].requests.map(({editor}) => editor.name)).toEqual(['Outside'])
  expect(after.collections[0].chosenEnv).toBe(null)
  const allStorage = await panel.evaluate(() => chrome.storage.local.get(null))
  expect(JSON.stringify(allStorage)).not.toContain('deleted.example.test')
  expect(JSON.stringify(allStorage)).not.toContain('deleted-secret')
  if (process.env.FACTORY_EVIDENCE === '1') {
    await writeFile('.factory-evidence/nested-env-deletion-storage.json', JSON.stringify({before, after}, null, 2) + '\n')
  }
  await proof(panel, 'nested-env-folder-deleted')
  await click(panel, '#close-collections')
  await expect(panel.locator('#env-picker option')).toHaveText(['No env'])
  await expect(panel.locator('#env-picker')).toHaveValue('')
  await proof(panel, 'nested-env-deleted-picker-reset')
})
