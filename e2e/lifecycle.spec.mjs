/** Check real disk storage and background worker lifetimes across extension page and browser process closure. */
import {test, expect} from './fixtures.mjs'
import {
  addEntry, click, echoedRequest, expectHidden, expectText, expectValue, expectVisible,
  fill, send, sessionRules, storedHistory, storedWorkspace
} from './panel-helpers.mjs'

/** Preserve every editor value before sending, and the complete response after restarting the browser. */
async function diskPersistence({extension, api}) {
  let panel = await extension.openPanel()
  await fill(panel, '#request-url', `${api.origin}/echo?tag=one&tag=two`)
  await panel.locator('#request-method').selectOption('POST')
  await click(panel, '#request-name')
  await fill(panel, '#request-name-input', 'Persistent request')
  await panel.locator('#request-name-input').press('Enter')
  await addEntry(panel, 'params', 'unfinished', 'kept', false)
  await addEntry(panel, 'headers', 'X-Draft', 'disabled value', false)
  await click(panel, '#body-tab')
  await fill(panel, '#request-body', '{"unfinished":')
  await click(panel, '#auth-tab')
  await fill(panel, '#bearer-token', 'persistent-bearer')
  await panel.locator('#auth-type').selectOption('basic')
  await fill(panel, '#basic-username', 'test-user')
  await fill(panel, '#basic-password', 'inactive-password')
  await panel.locator('#auth-type').selectOption('api-key')
  await fill(panel, '#api-key-name', 'inactive-key')
  await fill(panel, '#api-key-value', 'inactive-value')
  await panel.locator('#api-key-location').selectOption('query')
  await panel.locator('#auth-type').selectOption('custom')
  await fill(panel, '#custom-authorization', 'Token inactive')
  await panel.locator('#auth-type').selectOption('bearer')
  const before = await panel.evaluate(storedWorkspace)
  expect(before.draft.editor.body).toBe('{"unfinished":')
  const unsent = await panel.evaluate(storedHistory)
  expect(unsent).toEqual([])

  await extension.restart()
  panel = await extension.openPanel()
  const restored = await panel.evaluate(storedWorkspace)
  expect(restored).toEqual(before)
  await expectText(panel, '#request-name', 'Persistent request')
  await expectValue(panel, '#request-method', 'POST')
  await click(panel, '#body-tab')
  await expectValue(panel, '#request-body', '{"unfinished":')
  await fill(panel, '#request-body', '{"sent":true}')
  await send(panel)
  const response = await echoedRequest(panel)
  expect(response.headers.authorization).toBe('Bearer persistent-bearer')
  expect(response.body).toBe('{"sent":true}')
  const sent = await panel.evaluate(storedHistory)
  expect(sent).toHaveLength(1)
  expect(sent[0].editor.authValues['basic-password']).toBe('inactive-password')
  expect(sent[0].editor.authValues['api-key-location']).toBe('query')
  expect(sent[0].editor.authValues['custom-authorization']).toBe('Token inactive')

  await extension.restart()
  panel = await extension.openPanel()
  await expectVisible(panel, '#response-stats')
  const history = await panel.evaluate(storedHistory)
  expect(history).toEqual(sent)
  const responseAfterRestart = await echoedRequest(panel)
  expect(responseAfterRestart).toEqual(response)
  await click(panel, '#response-headers-tab')
  const headers = panel.locator('#response-headers-panel')
  await expect(headers).toContainText('x-test-response: preserved')
}
test('persists unsent fields, inactive credentials, and complete responses across browser restarts', diskPersistence)

/** Close every request page while its real background fetch runs, and restore its pending and completed states. */
async function detachedCompletion({extension, api}) {
  let panel = await extension.openPanel()
  await fill(panel, '#request-url', `${api.origin}/hold/closed-panel`)
  await click(panel, '#send-request')
  /** Observe the server receiving the real request before destroying the client page. */
  function requestArrived() { return api.held.has('/hold/closed-panel') }
  await expect.poll(requestArrived).toBe(true)
  await panel.close()

  panel = await extension.openPanel()
  await expectText(panel, '#workspace-status-label', 'Running')
  await click(panel, '#show-history')
  await expectText(panel, '[data-history-status-label]', 'Running')
  await expectVisible(panel, '[data-history-status] .running-spinner')
  await click(panel, '#close-history')
  await panel.close()
  api.release('/hold/closed-panel')

  panel = await extension.openPanel()
  await expectVisible(panel, '#response-stats')
  const response = await echoedRequest(panel)
  expect(response).toEqual({finished: true})
  const history = await panel.evaluate(storedHistory)
  expect(history).toHaveLength(1)
  expect(history[0].result.type).toBe('response')
}
test('finishes and saves a real request after the extension page closes', detachedCompletion)

/** Cancel a request from a fresh extension page even when the edited URL no longer passes form validation. */
async function reopenedCancellation({extension, api}) {
  let panel = await extension.openPanel()
  await fill(panel, '#request-url', `${api.origin}/hold/cancel?stream=1`)
  await click(panel, '#send-request')
  /** Wait until the real server holds the response body. */
  function requestArrived() { return api.held.has('/hold/cancel') }
  await expect.poll(requestArrived).toBe(true)
  await panel.close()
  panel = await extension.openPanel()
  await expectText(panel, '#send-request', 'Cancel')
  await fill(panel, '#request-url', '')
  await click(panel, '#send-request')
  await expectText(panel, '#request-error', 'Request canceled.')
  await expectText(panel, '#send-request', 'Send')
  const history = await panel.evaluate(storedHistory)
  expect(history[0].result.message).toBe('Request canceled.')
  expect(history[0].request.url).toBe(`${api.origin}/hold/cancel?stream=1`)
}
test('cancels a running request from a reopened page with an invalid current URL', reopenedCancellation)

/** Exercise the actual thirty-second deadline with a streaming response and no extension page remaining open. */
async function realTimeout({extension, api}) {
  let panel = await extension.openPanel()
  await fill(panel, '#request-url', `${api.origin}/hold/timeout?stream=1`)
  await click(panel, '#send-request')
  /** Confirm that the request reached the server before closing the page. */
  function requestArrived() { return api.held.has('/hold/timeout') }
  await expect.poll(requestArrived).toBe(true)
  await panel.close()
  /** Observe the real network connection closing while no request page exists. */
  function requestTimedOut() { return api.closedResponses.has('/hold/timeout') }
  await expect.poll(requestTimedOut, {timeout: 45000}).toBe(true)
  panel = await extension.openPanel()
  const error = panel.locator('#request-error')
  await expect(error).toContainText('timed out after 30 seconds')
  const history = await panel.evaluate(storedHistory)
  expect(history[0].result.type).toBe('error')
  const rules = await panel.evaluate(sessionRules)
  expect(rules).toEqual([])
}
test('enforces the real timeout after the request page closes', realTimeout)

/** Interrupt a real request by ending the browser, then retain its data and mark the unfinished attempt as failed. */
async function interruptedBrowser({extension, api}) {
  let panel = await extension.openPanel()
  await fill(panel, '#request-url', `${api.origin}/hold/restart`)
  await click(panel, '#send-request')
  /** Ensure the initial history entry exists and the request is in flight. */
  function requestArrived() { return api.held.has('/hold/restart') }
  await expect.poll(requestArrived).toBe(true)
  const before = await panel.evaluate(storedHistory)
  expect(before[0].result).toBeUndefined()
  await extension.restart()
  panel = await extension.openPanel()
  const error = panel.locator('#request-error')
  await expect(error).toContainText('browser stopped')
  const after = await panel.evaluate(storedHistory)
  expect(after).toHaveLength(1)
  expect(after[0].editor).toEqual(before[0].editor)
  expect(after[0].result.type).toBe('error')
  await expectHidden(panel, '#workspace-status .running-spinner')
  const rules = await panel.evaluate(sessionRules)
  expect(rules).toEqual([])
}
test('recovers an interrupted request and removes stale rules after a browser restart', interruptedBrowser)

/** Stop the actual extension worker independently of the browser and verify recovery when a new request wakes it. */
async function workerRestart({extension, api}) {
  const panel = await extension.openPanel()
  await fill(panel, '#request-url', `${api.origin}/hold/worker-stop`)
  await click(panel, '#send-request')
  /** Wait for the real fetch to hold an active header rule before terminating its worker. */
  function requestArrived() { return api.held.has('/hold/worker-stop') }
  await expect.poll(requestArrived).toBe(true)
  const before = await panel.evaluate(storedHistory)
  const activeRules = await panel.evaluate(sessionRules)
  expect(activeRules).toHaveLength(1)
  const session = await extension.context.newCDPSession(panel)
  const versions = new Map()
  const workerPrefix = `chrome-extension://${extension.extensionId}/`
  /** Track real worker lifecycle events without replacing its code or browser APIs. */
  function rememberVersions(event) {
    for (const version of event.versions) {
      if (version.scriptURL.startsWith(workerPrefix)) versions.set(version.versionId, version)
    }
  }
  /** Identify this extension's running worker version. */
  function runningVersion() {
    for (const version of versions.values()) {
      if (version.runningStatus === 'running') return version.versionId
    }
    return ''
  }
  session.on('ServiceWorker.workerVersionUpdated', rememberVersions)
  await session.send('ServiceWorker.enable')
  await expect.poll(runningVersion).not.toBe('')
  const versionId = runningVersion()
  await session.send('ServiceWorker.stopWorker', {versionId})
  /** Confirm actual worker termination before using the extension again. */
  function stopped() { return versions.get(versionId)?.runningStatus === 'stopped' }
  await expect.poll(stopped).toBe(true)
  await session.detach()
  await click(panel, '#clear-request')
  await fill(panel, '#request-url', `${api.origin}/echo?worker=restarted`)
  await send(panel)
  const saved = await panel.evaluate(storedHistory)
  expect(saved).toHaveLength(2)
  /** Find the interrupted record by its immutable saved ID. */
  function isOriginal(record) { return record.id === before[0].id }
  const original = saved.find(isOriginal)
  expect(original.editor).toEqual(before[0].editor)
  expect(original.result.type).toBe('error')
  expect(original.result.message).toContain('browser stopped')
  const rules = await panel.evaluate(sessionRules)
  expect(rules).toEqual([])
}
test('recovers after actual worker termination and wakes the worker for the next send', workerRestart)
