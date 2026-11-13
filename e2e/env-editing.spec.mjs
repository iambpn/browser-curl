/** Complete env edits through the real panel at collection, folder, and request levels. */
import {appendFile} from 'node:fs/promises'
import {test, expect} from './fixtures.mjs'
import {click, fill, send, echoedRequest, storedCollections} from './panel-helpers.mjs'

async function proof(panel, name) {
  if (process.env.FACTORY_EVIDENCE !== '1') return
  await panel.screenshot({path: `.factory-evidence/${name}.png`})
  await appendFile('.factory-evidence/env-editing-captures.jsonl', JSON.stringify({name, video: await panel.video().path()}) + '\n')
}

function row(panel, name) {
  return panel.locator('.collection-row').filter({has: panel.locator('[data-collection-name], [data-item-name]').filter({hasText: new RegExp(`^${name}$`)})})
}

async function openEnv(panel, level) {
  await click(panel, '#show-collections')
  await row(panel, level).getByRole('button', {name: 'Environments', exact: true}).click()
  await expect(panel.locator('#env-editor')).toBeVisible()
}

async function closeEnv(panel) {
  await click(panel, '#env-close')
  await click(panel, '#close-collections')
}

async function addBase(panel, name) {
  await fill(panel, '#env-base-name', name)
  await click(panel, '#env-add-name')
  await expect(panel.locator('#env-base-name')).toHaveValue('')
}

async function newFork(panel, name) {
  await fill(panel, '#env-fork-name', name)
  await click(panel, '#env-new-fork')
  await expect(panel.getByRole('tab', {name, exact: true})).toHaveAttribute('aria-selected', 'true')
}

async function setup(panel, api, level) {
  // Keep the linked request inside a folder so all three env levels can supply its values.
  await fill(panel, '#request-url', `${api.origin}/echo`)
  await click(panel, '#save-as')
  await fill(panel, '#save-request-name', 'Outside')
  await fill(panel, '#new-collection-name', 'API')
  await click(panel, '#confirm-save-as')
  await expect(panel.locator('#save-as-dialog')).toBeHidden()
  await click(panel, '#show-collections')
  await row(panel, 'API').getByRole('button', {name: 'Add folder', exact: true}).click()
  await fill(panel, '#collection-item-name', 'Folder')
  await click(panel, '#confirm-collection-item')
  await expect(panel.locator('#collection-item-form')).toBeHidden()
  await click(panel, '#close-collections')
  await click(panel, '#save-as')
  await fill(panel, '#save-request-name', 'Request')
  await panel.locator('#save-collection').selectOption({label: '\u00a0'.repeat(2) + 'Folder'})
  await click(panel, '#confirm-save-as')
  await expect(panel.locator('#save-as-dialog')).toBeHidden()
  await openEnv(panel, level)
}

test('fork rename waits for pending value saves without replacing live values with stale text', async ({extension, api}) => {
  const panel = await extension.openPanel()
  await setup(panel, api, 'API')
  await addBase(panel, 'token')
  await newFork(panel, 'local')
  const token = panel.getByRole('textbox', {name: 'Value for token', exact: true})
  await token.fill('old')
  await expect(panel.locator('#env-new-fork')).toBeEnabled()

  // Hold the acknowledgement of one real collection write, without using a timed delay.
  await panel.evaluate(() => {
    const set = chrome.storage.local.set.bind(chrome.storage.local)
    chrome.storage.local.set = (items, callback) => {
      if (!Object.keys(items).some((key) => key.startsWith('browsercurl.collection.'))) return set(items, callback)
      chrome.storage.local.set = set
      set(items, () => { window.finishEnvValueSave = callback })
    }
  })
  await token.fill('new-value')
  await panel.waitForFunction(() => typeof window.finishEnvValueSave === 'function')
  // A native click attempts the action even when it should be disabled during persistence.
  await panel.locator('#env-rename-fork').evaluate((button) => button.click())
  await expect(token).toHaveValue('new-value')
  await expect(panel.locator('#env-rename-fork')).toBeDisabled()
  await expect(panel.locator('#env-rename-fork-name')).toHaveCount(0)
  await proof(panel, 'env-rename-pending-value-save')

  // Live input remains usable, and the action waits for all queued value saves.
  await token.fill('newest-value')
  await panel.evaluate(() => window.finishEnvValueSave())
  await expect(panel.locator('#env-rename-fork')).toBeEnabled()
  await click(panel, '#env-rename-fork')
  await expect(token).toHaveValue('newest-value')
  await fill(panel, '#env-rename-fork-name', 'staging')
  await click(panel, '#env-save-fork-name')
  await expect(panel.getByRole('tab', {name: 'staging', exact: true})).toHaveAttribute('aria-selected', 'true')
  await expect(token).toHaveValue('newest-value')
  await proof(panel, 'env-renamed-after-value-save')
  await token.press('End')
  await token.pressSequentially('-edited')
  await closeEnv(panel)
  await panel.locator('#env-picker').selectOption('staging')
  await fill(panel, '#request-url', `${api.origin}/echo?token={{token}}`)
  await send(panel)
  expect((await echoedRequest(panel)).url).toBe('/echo?token=newest-value-edited')
  await openEnv(panel, 'API')
  await panel.getByRole('tab', {name: 'staging', exact: true}).click()
  await expect(token).toHaveValue('newest-value-edited')
})

for (const selection of ['caret', 'selection']) {
  test(`typing through a fork rename save preserves value focus and ${selection}`, async ({extension, api}) => {
    const panel = await extension.openPanel()
    await setup(panel, api, 'API')
    await addBase(panel, 'token')
    await newFork(panel, 'local')
    const token = panel.getByRole('textbox', {name: 'Value for token', exact: true})
    await token.fill('old')
    await click(panel, '#env-rename-fork')
    await fill(panel, '#env-rename-fork-name', 'staging')

    // Hold the rename acknowledgement, then the following value acknowledgement,
    // so the test exercises both the in-flight field and the fully saved state.
    await panel.evaluate(() => {
      const set = chrome.storage.local.set.bind(chrome.storage.local)
      window.envWriteCallbacks = []
      chrome.storage.local.set = (items, callback) => {
        if (!Object.keys(items).some((key) => key.startsWith('browsercurl.collection.'))) return set(items, callback)
        set(items, () => window.envWriteCallbacks.push(callback))
      }
      window.restoreEnvStorageSet = () => { chrome.storage.local.set = set }
    })
    await click(panel, '#env-save-fork-name')
    await panel.waitForFunction(() => window.envWriteCallbacks.length === 1)
    await token.fill('')
    await panel.keyboard.type('prefix')
    if (selection === 'selection') {
      await panel.keyboard.press('ArrowLeft')
      await panel.keyboard.press('ArrowLeft')
      await panel.keyboard.press('Shift+ArrowLeft')
      await panel.keyboard.press('Shift+ArrowLeft')
    }
    const caret = await token.evaluate((input) => [input.selectionStart, input.selectionEnd, input.selectionDirection])
    await proof(panel, `env-value-edited-during-rename-${selection}`)
    await panel.evaluate(() => window.envWriteCallbacks[0]())
    await panel.waitForFunction(() => window.envWriteCallbacks.length === 2)
    await expect(token).toHaveValue('prefix')
    await expect(panel.locator('#env-rename-fork')).toBeDisabled()
    await panel.evaluate(() => {
      window.restoreEnvStorageSet()
      window.envWriteCallbacks[1]()
    })
    await expect(panel.locator('#env-rename-fork')).toBeEnabled()
    await expect(panel.getByRole('tab', {name: 'staging', exact: true})).toHaveAttribute('aria-selected', 'true')
    await expect(token).toHaveValue('prefix')
    await expect(token).toBeFocused()
    expect(await token.evaluate((input) => [input.selectionStart, input.selectionEnd, input.selectionDirection])).toEqual(caret)
    expect((await panel.evaluate(storedCollections)).collections[0].env.forks[0].variables[0].value).toBe('prefix')
    await proof(panel, `env-rename-retains-new-value-${selection}`)

    // Keep typing through the keyboard without focusing the rebuilt field again.
    await panel.keyboard.type('suffix')
    const expected = selection === 'caret' ? 'prefixsuffix' : 'prsuffixix'
    await expect(token).toHaveValue(expected)
    await expect(token).toBeFocused()
    await expect(panel.locator('#env-rename-fork')).toBeEnabled()
    await proof(panel, `env-rename-typing-continues-${selection}`)
    await closeEnv(panel)
    await panel.locator('#env-picker').selectOption('staging')
    await fill(panel, '#request-url', `${api.origin}/echo?token={{token}}`)
    await send(panel)
    expect((await echoedRequest(panel)).url).toBe(`/echo?token=${expected}`)
    await openEnv(panel, 'API')
    await panel.getByRole('tab', {name: 'staging', exact: true}).click()
    await expect(token).toHaveValue(expected)
    await proof(panel, `env-rename-subsequent-edit-saved-${selection}`)
  })
}

test('a failed value save during fork rename keeps the unsaved text across renders for retry', async ({extension, api}) => {
  const panel = await extension.openPanel()
  await setup(panel, api, 'API')
  await addBase(panel, 'token')
  await newFork(panel, 'local')
  const token = panel.getByRole('textbox', {name: 'Value for token', exact: true})
  await token.fill('old')
  await click(panel, '#env-rename-fork')
  await fill(panel, '#env-rename-fork-name', 'staging')

  // Hold the real rename acknowledgement and fail the following value write.
  await panel.evaluate(() => {
    const set = chrome.storage.local.set.bind(chrome.storage.local)
    let renamed = false
    chrome.storage.local.set = (items, callback) => {
      if (!Object.keys(items).some((key) => key.startsWith('browsercurl.collection.'))) return set(items, callback)
      if (!renamed) {
        renamed = true
        return set(items, () => { window.finishEnvRename = callback })
      }
      chrome.storage.local.set = set
      throw new Error('Storage quota exceeded')
    }
  })
  await click(panel, '#env-save-fork-name')
  await panel.waitForFunction(() => typeof window.finishEnvRename === 'function')
  await token.fill('new-value')
  await panel.evaluate(() => window.finishEnvRename())
  await expect(panel.getByRole('tab', {name: 'staging', exact: true})).toHaveAttribute('aria-selected', 'true')
  await expect(panel.locator('#env-error')).toBeVisible()
  await expect(panel.locator('#env-error')).toHaveText('Storage quota exceeded')
  await expect(token).toHaveValue('new-value')
  expect((await panel.evaluate(storedCollections)).collections[0].env.forks[0].variables[0].value).toBe('old')
  await proof(panel, 'env-rename-failed-value-retained')

  // Further renders must also retain the failed edit until the user retries it.
  await panel.getByRole('tab', {name: 'Base', exact: true}).click()
  await panel.getByRole('tab', {name: 'staging', exact: true}).click()
  await expect(token).toHaveValue('new-value')
  await token.press('End')
  await token.pressSequentially('-retried')
  await expect(panel.locator('#env-rename-fork')).toBeEnabled()
  await closeEnv(panel)
  await panel.locator('#env-picker').selectOption('staging')
  await fill(panel, '#request-url', `${api.origin}/echo?token={{token}}`)
  await send(panel)
  expect((await echoedRequest(panel)).url).toBe('/echo?token=new-value-retried')
  await openEnv(panel, 'API')
  await panel.getByRole('tab', {name: 'staging', exact: true}).click()
  await expect(token).toHaveValue('new-value-retried')
  await proof(panel, 'env-rename-failed-value-retried')
})

test('deleting a fork after its first value save fails requires confirmation and Cancel preserves the draft', async ({extension, api}) => {
  const panel = await extension.openPanel()
  panel.on('dialog', () => { throw new Error('Env edits must never open browser dialogs') })
  await setup(panel, api, 'API')
  await addBase(panel, 'token')
  await newFork(panel, 'local')
  const token = panel.getByRole('textbox', {name: 'Value for token', exact: true})
  await expect(token).toHaveValue('')

  // Fail the first nonempty value write, leaving only the draft with a value.
  await panel.evaluate(() => {
    const set = chrome.storage.local.set.bind(chrome.storage.local)
    chrome.storage.local.set = (items, callback) => {
      if (!Object.keys(items).some((key) => key.startsWith('browsercurl.collection.'))) return set(items, callback)
      chrome.storage.local.set = set
      throw new Error('Storage quota exceeded')
    }
  })
  await token.fill('unsaved-token')
  await expect(panel.locator('#env-error')).toHaveText('Storage quota exceeded')
  expect((await panel.evaluate(storedCollections)).collections[0].env.forks[0].variables[0].value).toBe('')
  await proof(panel, 'env-delete-failed-save-draft')

  await click(panel, '#env-delete-fork')
  await expect(panel.locator('#env-delete-warning')).toContainText('local')
  await expect(token).toHaveValue('unsaved-token')
  await proof(panel, 'env-delete-unsaved-confirm')
  await click(panel, '#env-cancel-delete')
  await expect(panel.locator('#env-delete-warning')).toHaveCount(0)
  await expect(panel.getByRole('tab', {name: 'local', exact: true})).toHaveAttribute('aria-selected', 'true')
  await expect(token).toHaveValue('unsaved-token')
  expect((await panel.evaluate(storedCollections)).collections[0].env.forks[0].variables[0].value).toBe('')
  await proof(panel, 'env-delete-unsaved-cancelled')

  // Cancel must retain the draft through later renders as well.
  await panel.getByRole('tab', {name: 'Base', exact: true}).click()
  await panel.getByRole('tab', {name: 'local', exact: true}).click()
  await expect(token).toHaveValue('unsaved-token')
  await click(panel, '#env-delete-fork')
  await click(panel, '#env-confirm-delete')
  await expect(panel.getByRole('tab', {name: 'local', exact: true})).toHaveCount(0)
  expect((await panel.evaluate(storedCollections)).collections[0].env.forks).toEqual([])
  await proof(panel, 'env-delete-unsaved-confirmed')
})

for (const level of ['API', 'Folder', 'Request']) {
  test(`rename a base name at ${level}: forks keep the old value and gain the new name empty`, async ({extension, api}) => {
    const panel = await extension.openPanel()
    await setup(panel, api, level)
    await addBase(panel, 'old')
    await newFork(panel, 'local')
    await panel.getByRole('textbox', {name: 'Value for old', exact: true}).fill('kept-value')
    await newFork(panel, 'staging')
    await panel.getByRole('tab', {name: 'Base', exact: true}).click()
    await panel.getByRole('button', {name: 'Rename old', exact: true}).click()
    await fill(panel, '#env-rename-base-name', ' new ')
    await click(panel, '#env-save-base-name')
    await expect(panel.getByRole('button', {name: 'Rename new', exact: true})).toBeVisible()
    for (const fork of ['local', 'staging']) {
      await panel.getByRole('tab', {name: fork, exact: true}).click()
      await expect(panel.getByRole('textbox', {name: 'Value for old', exact: true})).toHaveValue(fork === 'local' ? 'kept-value' : '')
      await expect(panel.getByRole('textbox', {name: 'Value for new', exact: true})).toHaveValue('')
      await expect(panel.locator('.env-value-row label')).toHaveText(['new', 'old'])
      await expect(panel.locator('.env-value-row').first()).toContainText('From base')
      await expect(panel.getByRole('button', {name: 'Delete new', exact: true})).toHaveCount(0)
      await expect(panel.getByRole('button', {name: 'Delete old', exact: true})).toBeVisible()
    }
    await panel.getByRole('tab', {name: 'local', exact: true}).click()
    await proof(panel, `env-rename-base-${level.toLowerCase()}`)
  })

  test(`fork-only variable at ${level} resolves in a sent request, can join the base, and can be deleted after removal`, async ({extension, api}) => {
    const panel = await extension.openPanel()
    await setup(panel, api, level)
    await newFork(panel, 'local')
    await fill(panel, '#env-variable-name', ' extra ')
    await click(panel, '#env-add-variable')
    await expect(panel.getByRole('textbox', {name: 'Value for extra', exact: true})).toHaveValue('')
    await panel.getByRole('textbox', {name: 'Value for extra', exact: true}).fill('fork-value')
    await proof(panel, `env-fork-only-added-${level.toLowerCase()}`)
    await closeEnv(panel)
    await panel.locator('#env-picker').selectOption('local')
    await fill(panel, '#request-url', `${api.origin}/echo?extra={{extra}}`)
    await send(panel)
    expect((await echoedRequest(panel)).url).toBe('/echo?extra=fork-value')
    await proof(panel, `env-fork-only-sent-${level.toLowerCase()}`)
    await openEnv(panel, level)
    await addBase(panel, 'first')
    await addBase(panel, 'extra')
    await panel.getByRole('tab', {name: 'local', exact: true}).click()
    await expect(panel.locator('.env-value-row label')).toHaveText(['first', 'extra'])
    await expect(panel.getByRole('textbox', {name: 'Value for extra', exact: true})).toHaveValue('fork-value')
    await expect(panel.getByRole('button', {name: 'Delete extra', exact: true})).toHaveCount(0)
    await proof(panel, `env-fork-variable-joins-base-${level.toLowerCase()}`)
    await panel.getByRole('tab', {name: 'Base', exact: true}).click()
    await panel.getByRole('button', {name: 'Remove extra', exact: true}).click()
    await expect(panel.getByRole('button', {name: 'Remove extra', exact: true})).toHaveCount(0)
    await panel.getByRole('tab', {name: 'local', exact: true}).click()
    await expect(panel.locator('.env-value-row').last()).not.toContainText('From base')
    await panel.getByRole('button', {name: 'Delete extra', exact: true}).click()
    await expect(panel.getByRole('textbox', {name: 'Value for extra', exact: true})).toHaveCount(0)
    await proof(panel, `env-fork-only-deleted-${level.toLowerCase()}`)
  })

  test(`delete a valued fork at ${level}: in-panel Cancel keeps it, confirming removes it and resets the picker`, async ({extension, api}) => {
    const panel = await extension.openPanel()
    panel.on('dialog', () => { throw new Error('Env edits must never open browser dialogs') })
    await setup(panel, api, level)
    await addBase(panel, 'token')
    await newFork(panel, 'local')
    await panel.getByRole('textbox', {name: 'Value for token', exact: true}).fill('kept-until-confirmed')
    await closeEnv(panel)
    await panel.locator('#env-picker').selectOption('local')
    await openEnv(panel, level)
    await panel.getByRole('tab', {name: 'local', exact: true}).click()
    await click(panel, '#env-delete-fork')
    await expect(panel.locator('#env-delete-warning')).toContainText('local')
    await proof(panel, `env-delete-confirm-${level.toLowerCase()}`)
    await click(panel, '#env-cancel-delete')
    await expect(panel.locator('#env-delete-warning')).toHaveCount(0)
    await expect(panel.getByRole('textbox', {name: 'Value for token', exact: true})).toHaveValue('kept-until-confirmed')
    await proof(panel, `env-delete-cancelled-${level.toLowerCase()}`)
    await click(panel, '#env-delete-fork')
    await click(panel, '#env-confirm-delete')
    await expect(panel.getByRole('tab', {name: 'local', exact: true})).toHaveCount(0)
    await closeEnv(panel)
    await expect(panel.locator('#env-picker option')).toHaveText(['No env'])
    await expect(panel.locator('#env-picker')).toHaveValue('')
    await proof(panel, `env-deleted-picker-${level.toLowerCase()}`)
  })

  test(`rename the chosen fork on its only level (${level}) resets the picker to No env`, async ({extension, api}) => {
    const panel = await extension.openPanel()
    await setup(panel, api, level)
    await newFork(panel, 'local')
    await closeEnv(panel)
    await panel.locator('#env-picker').selectOption('local')
    await openEnv(panel, level)
    await panel.getByRole('tab', {name: 'local', exact: true}).click()
    await click(panel, '#env-rename-fork')
    await fill(panel, '#env-rename-fork-name', ' staging ')
    await click(panel, '#env-save-fork-name')
    await expect(panel.getByRole('tab', {name: 'staging', exact: true})).toHaveAttribute('aria-selected', 'true')
    await proof(panel, `env-renamed-fork-${level.toLowerCase()}`)
    await closeEnv(panel)
    await expect(panel.locator('#env-picker option')).toHaveText(['No env', 'staging'])
    await expect(panel.locator('#env-picker')).toHaveValue('')
    expect((await panel.evaluate(storedCollections)).collections[0].chosenEnv).toBe(null)
    await proof(panel, `env-renamed-picker-${level.toLowerCase()}`)
  })
}

test('fork names are suggested collection-wide for creation and rename; selection stays until the last matching fork is removed', async ({extension, api}) => {
  const panel = await extension.openPanel()
  await setup(panel, api, 'API')
  await newFork(panel, 'local')
  await closeEnv(panel)
  await panel.locator('#env-picker').selectOption('local')
  await openEnv(panel, 'Folder')
  await expect(panel.locator('#env-fork-name')).toHaveAttribute('list', 'env-fork-suggestions')
  await expect(panel.locator('#env-fork-suggestions option')).toHaveText(['local'])
  await newFork(panel, 'local')
  await newFork(panel, 'staging')
  await click(panel, '#env-rename-fork')
  await expect(panel.locator('#env-rename-fork-name')).toHaveAttribute('list', 'env-fork-suggestions')
  await expect(panel.locator('#env-fork-suggestions option')).toHaveText(['local', 'staging'])
  await fill(panel, '#env-rename-fork-name', ' local ')
  await click(panel, '#env-save-fork-name')
  await expect(panel.locator('#env-error')).toHaveText('This fork name already exists.')
  await fill(panel, '#env-rename-fork-name', '  ')
  await click(panel, '#env-save-fork-name')
  await expect(panel.locator('#env-error')).toHaveText('Enter a fork name.')
  await proof(panel, 'env-fork-rename-invalid')
  await fill(panel, '#env-rename-fork-name', ' Local ')
  await click(panel, '#env-save-fork-name')
  await expect(panel.getByRole('tab', {name: 'Local', exact: true})).toHaveAttribute('aria-selected', 'true')
  await closeEnv(panel)
  await openEnv(panel, 'API')
  await panel.getByRole('tab', {name: 'local', exact: true}).click()
  await click(panel, '#env-rename-fork')
  await fill(panel, '#env-rename-fork-name', 'other')
  await proof(panel, 'env-fork-name-suggestions')
  await click(panel, '#env-save-fork-name')
  await expect(panel.getByRole('tab', {name: 'other', exact: true})).toBeVisible()
  await closeEnv(panel)
  await expect(panel.locator('#env-picker')).toHaveValue('local')
  await proof(panel, 'env-shared-name-stays-chosen')
  await openEnv(panel, 'Folder')
  await panel.getByRole('tab', {name: 'local', exact: true}).click()
  // Empty forks delete immediately, without a confirmation.
  await click(panel, '#env-delete-fork')
  await expect(panel.getByRole('tab', {name: 'local', exact: true})).toHaveCount(0)
  await expect(panel.locator('#env-delete-warning')).toHaveCount(0)
  await closeEnv(panel)
  await expect(panel.locator('#env-picker')).toHaveValue('')
  await openEnv(panel, 'Request')
  await expect(panel.locator('#env-fork-suggestions option')).toHaveText(['Local', 'other'])
  await proof(panel, 'env-new-fork-name-suggestions')
})

test('inline base rename and fork-only additions reject invalid names and support cancellation in a narrow dark panel', async ({extension, api}) => {
  const panel = await extension.openPanel()
  await setup(panel, api, 'API')
  await addBase(panel, 'old')
  await addBase(panel, 'taken')
  await panel.getByRole('button', {name: 'Rename old', exact: true}).click()
  for (const [name, error] of [['  ', 'Enter a variable name.'], ['bad{', 'Variable names cannot contain { or }.'], ['taken', 'This variable name already exists.']]) {
    await fill(panel, '#env-rename-base-name', name)
    await click(panel, '#env-save-base-name')
    await expect(panel.locator('#env-error')).toHaveText(error)
  }
  await proof(panel, 'env-base-rename-invalid')
  await panel.locator('#env-rename-base-name').press('Escape')
  await expect(panel.locator('#collections-dialog')).toBeVisible()
  await expect(panel.getByRole('button', {name: 'Rename old', exact: true})).toBeVisible()
  await newFork(panel, 'local')
  for (const [name, error] of [[' ', 'Enter a variable name.'], ['bad}', 'Variable names cannot contain { or }.'], [' old ', 'This variable name already exists.']]) {
    await fill(panel, '#env-variable-name', name)
    await click(panel, '#env-add-variable')
    await expect(panel.locator('#env-error')).toHaveText(error)
  }
  await fill(panel, '#env-variable-name', ' extra ')
  await click(panel, '#env-add-variable')
  await expect(panel.locator('#env-variable-name')).toHaveValue('')
  await panel.getByRole('textbox', {name: 'Value for extra', exact: true}).fill('private-value')
  await click(panel, '#env-rename-fork')
  await fill(panel, '#env-rename-fork-name', 'cancelled')
  await panel.locator('#env-content').getByRole('button', {name: 'Cancel', exact: true}).click()
  await expect(panel.getByRole('tab', {name: 'local', exact: true})).toBeVisible()
  await panel.emulateMedia({colorScheme: 'dark'})
  await panel.setViewportSize({width: 380, height: 820})
  expect(await panel.locator('#collections-dialog').evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true)
  await proof(panel, 'env-editing-dark-narrow')
  await click(panel, '#env-delete-fork')
  await expect(panel.locator('#env-delete-warning')).toBeVisible()
  await proof(panel, 'env-delete-dark-narrow')
})
