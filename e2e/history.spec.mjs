/** Exercise saved-history navigation, draft preservation, clearing, resending, and deletion with real extension storage. */
import {test, expect} from './fixtures.mjs'
import {
  addEntry, click, echoedRequest, expectHidden, expectText, expectValue, expectVisible,
  fill, savedWorkspaceWith, send, storedHistory, storedWorkspace
} from './panel-helpers.mjs'

/** Save and resend a request, preview it without losing an unsent draft, and delete the complete saved item. */
async function historyAndDraft({extension, api}) {
  let panel = await extension.openPanel()
  await expectText(panel, '#clear-request', 'Clear')
  await fill(panel, '#request-url', `${api.origin}/echo?original=yes`)
  await panel.locator('#request-method').selectOption('POST')
  await click(panel, '#body-tab')
  await fill(panel, '#request-body', '{"original":true}')
  await addEntry(panel, 'headers', 'X-Kept', 'disabled', false)
  await click(panel, '#auth-tab')
  await fill(panel, '#bearer-token', 'history-token')
  await send(panel)
  const original = await panel.evaluate(storedHistory)
  await click(panel, '#show-history')
  await click(panel, '[data-open-history]')
  await send(panel)
  const resent = await panel.evaluate(storedHistory)
  expect(resent).toHaveLength(2)
  expect(resent[0].id).not.toBe(resent[1].id)
  await click(panel, '#show-history')
  const deletes = panel.locator('[data-delete-history]')
  await deletes.first().click()
  await expect(deletes).toHaveCount(1)
  await click(panel, '#close-history')

  await click(panel, '#clear-request')
  await fill(panel, '#request-url', `${api.origin}/unsent?keep=draft`)
  await panel.locator('#request-method').selectOption('PATCH')
  await click(panel, '#body-tab')
  await fill(panel, '#request-body', 'unfinished draft')
  const draft = await savedWorkspaceWith(panel, 'body', 'unfinished draft')
  await click(panel, '#show-history')
  await click(panel, '[data-open-history]')
  await expectVisible(panel, '#back-to-draft')
  await click(panel, '#body-tab')
  await expectValue(panel, '#request-body', '{"original":true}')
  await fill(panel, '#request-body', 'preview edit')
  await savedWorkspaceWith(panel, 'body', 'preview edit')
  const unchangedHistory = await panel.evaluate(storedHistory)
  expect(unchangedHistory).toEqual(original)
  await extension.restart()
  panel = await extension.openPanel()
  await click(panel, '#body-tab')
  await expectValue(panel, '#request-body', 'preview edit')
  await click(panel, '#back-to-draft')
  await expectHidden(panel, '#back-to-draft')
  const restoredDraft = await panel.evaluate(storedWorkspace)
  expect(restoredDraft).toEqual(draft)

  await click(panel, '#show-history')
  await click(panel, '[data-delete-history]')
  await expectVisible(panel, '#history-empty')
  const deleted = await panel.evaluate(storedHistory)
  expect(deleted).toEqual([])
  await click(panel, '#close-history')
  await click(panel, '#clear-request')
  const cleared = await panel.evaluate(storedWorkspace)
  expect(cleared.draft.editor.url).toBe('')
  expect(cleared.draft.editor.name).toBe('')
  expect(cleared.draft.editor.body).toBe('')
  expect(cleared.draft.editor.method).toBe('GET')
  expect(cleared.draft.editor.authType).toBe('none')
  for (const [key, value] of Object.entries(cleared.draft.editor.authValues)) {
    const expected = key === 'api-key-location' ? 'header' : ''
    expect(value).toBe(expected)
  }
  await expectHidden(panel, '#response-content')
}
test('preserves drafts through history previews and browser restarts and deletes complete saved items', historyAndDraft)

/** Delete an in-flight request, finish its actual HTTP response, and prove it never returns to history. */
async function deleteRunningRequest({extension, api}) {
  const panel = await extension.openPanel()
  await fill(panel, '#request-url', `${api.origin}/hold/deleted`)
  await click(panel, '#send-request')
  /** Confirm the request is in the network before deleting its saved entry. */
  function requestArrived() { return api.held.has('/hold/deleted') }
  await expect.poll(requestArrived).toBe(true)
  const before = await panel.evaluate(storedHistory)
  const deletedId = before[0].id
  await click(panel, '#show-history')
  await click(panel, '[data-delete-history]')
  await expectVisible(panel, '#history-empty')
  await click(panel, '#close-history')
  await click(panel, '#clear-request')
  api.release('/hold/deleted', '{"deleted":true}')
  await fill(panel, '#request-url', `${api.origin}/echo?after=delete`)
  await send(panel)
  const response = await echoedRequest(panel)
  expect(response.url).toBe('/echo?after=delete')
  const after = await panel.evaluate(storedHistory)
  expect(after).toHaveLength(1)
  expect(after[0].id).not.toBe(deletedId)
  expect(after[0].result.type).toBe('response')
}
test('keeps an in-flight history item deleted after its real response arrives', deleteRunningRequest)
