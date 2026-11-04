/** Unit tests for request persistence, size limits, cancellation, disconnection, and deletion with simulated fetch and storage. */
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createHttpRequestHandlers, isTextContentType} from '../src/requests/http-runner.ts'
import {HTTP_REQUEST_PORT, REQUEST_TIMEOUT_MS} from '../src/requests/http-messages.ts'
import {HISTORY_KEY_PREFIX} from '../src/history/request-store.ts'
import {SETTINGS_KEY} from '../src/settings/settings.ts'
import {extensionEvent, savedFixture, storageFixture} from './helpers/extension-storage.mjs'

/** Run fetch without browser header rules. Header classification has its own unit tests. */
function withoutHeaderRules(_url, _headers, send) { return send([]) }

/** Create a trusted extension port and capture the result sent by the background. */
function requestPort() {
  const reply = Promise.withResolvers()
  const port = {
    name: HTTP_REQUEST_PORT,
    sender: {id: 'test-extension', url: 'chrome-extension://test-extension/sidebar/index.html'},
    onMessage: extensionEvent(), onDisconnect: extensionEvent(), disconnected: false,
    /** Capture the background's one result. */
    postMessage(message) { reply.resolve(message) },
    /** Simulate closure by either the panel or the background. */
    disconnect() { port.disconnected = true; port.onDisconnect.emit() }
  }
  return {port, result: reply.promise}
}

/** Start a persisted send with isolated extension APIs, optional saved settings, and an injected network implementation. */
function startRequest(context, fetch, settings) {
  const storage = storageFixture()
  if (settings) storage.values.set(SETTINGS_KEY, settings)
  globalThis.chrome = storage.chrome
  context.mock.method(globalThis, 'fetch', fetch)
  const handlers = createHttpRequestHandlers(withoutHeaderRules)
  const {port, result} = requestPort()
  handlers.handleHttpPort(port)
  const saved = savedFixture()
  const message = {type: 'send', id: saved.id, editor: saved.editor, request: saved.request}
  port.onMessage.emit(message)
  return {storage, handlers, port, result, key: HISTORY_KEY_PREFIX + saved.id}
}

/** Check storage before fetch, detach the panel, and ensure the complete response still reaches history. */
async function completionAfterPanelClose(context) {
  const network = Promise.withResolvers()
  const started = Promise.withResolvers()
  let fixture
  /** Pause the network after confirming that the send attempt already exists in storage. */
  function fetch(_url, options) {
    assert.ok(fixture.storage.values.get(fixture.key))
    assert.equal(options.headers.get('Authorization'), 'Bearer test-token')
    started.resolve(options.signal)
    return network.promise
  }
  fixture = startRequest(context, fetch)
  const signal = await started.promise
  fixture.port.disconnect()
  assert.equal(signal.aborted, false)
  network.resolve(new Response('{"ok":true}', {status: 201, headers: {'Content-Type': 'application/json'}}))
  /** Wait until the detached request's result is persisted. */
  function completed() { return Boolean(fixture.storage.values.get(fixture.key)?.result) }
  await fixture.storage.waitFor(completed)
  const saved = fixture.storage.values.get(fixture.key)
  assert.equal(saved.result.response.body, '{"ok":true}')
  assert.equal(saved.result.response.status, 201)
  assert.equal(saved.result.response.size, 11)
  assert.equal(saved.name, 'api.example.test')
}
test('saves before sending and completes after the panel disconnects', completionAfterPanelClose)

/** Cancel a detached request through a new panel's control message and save the cancellation. */
async function cancelAfterReopen(context) {
  const started = Promise.withResolvers()
  /** Reject only when explicit cancellation reaches the network signal. */
  function fetch(_url, options) {
    const network = Promise.withResolvers()
    /** Convert the abort into fetch's usual cancellation failure. */
    function aborted() { network.reject(new DOMException('Aborted', 'AbortError')) }
    options.signal.addEventListener('abort', aborted, {once: true})
    started.resolve()
    return network.promise
  }
  const fixture = startRequest(context, fetch)
  await started.promise
  fixture.port.disconnect()
  let acknowledged = false
  /** Record that the restored panel's cancel command was accepted. */
  function acknowledge() { acknowledged = true }
  fixture.handlers.handleControlMessage({type: 'cancel-http-request', id: 'request-1'}, fixture.port.sender, acknowledge)
  /** Observe the saved cancellation even though no original reply port remains. */
  function canceled() { return Boolean(fixture.storage.values.get(fixture.key)?.result) }
  await fixture.storage.waitFor(canceled)
  assert.equal(acknowledged, true)
  assert.equal(fixture.storage.values.get(fixture.key).result.message, 'Request canceled.')
}
test('supports cancellation from a reopened panel', cancelAfterReopen)

/** Remove a running request and ensure network completion cannot bring its data back. */
async function deleteWhileRunning(context) {
  const network = Promise.withResolvers()
  const started = Promise.withResolvers()
  /** Hold the response until the history item is deleted. */
  function fetch() { started.resolve(); return network.promise }
  const fixture = startRequest(context, fetch)
  await started.promise
  const deletion = Promise.withResolvers()
  fixture.handlers.handleControlMessage({type: 'delete-saved-request', id: 'request-1'}, fixture.port.sender, deletion.resolve)
  assert.deepEqual(await deletion.promise, {})
  assert.equal(fixture.storage.values.has(fixture.key), false)
  network.resolve(new Response('finished'))
  assert.equal((await fixture.result).type, 'response')
  assert.equal(fixture.storage.values.has(fixture.key), false)
}
test('does not restore a saved item deleted while its request runs', deleteWhileRunning)

/** Refuse to send when the request cannot be saved, instead of silently losing its history. */
async function saveBeforeSendFailure(context) {
  let called = false
  /** Detect an unexpected network operation after a failed persistence operation. */
  function fetch() { called = true; return Promise.resolve(new Response('unexpected')) }
  const fixture = startRequest(context, fetch)
  fixture.storage.failNextWrite = true
  const result = await fixture.result
  assert.equal(called, false)
  assert.match(result.message, /not sent/)
}
test('does not send when the history write fails', saveBeforeSendFailure)

/** Return the actual response with a warning and avoid a permanent running entry after a response write fails. */
async function responseStorageFailure(context) {
  const network = Promise.withResolvers()
  const started = Promise.withResolvers()
  /** Hold the response until storage failure can be injected after the initial save. */
  function fetch() { started.resolve(); return network.promise }
  const fixture = startRequest(context, fetch)
  await started.promise
  fixture.storage.failNextWrite = true
  network.resolve(new Response('response remains visible'))
  const result = await fixture.result
  assert.equal(result.type, 'response')
  assert.equal(result.response.body, 'response remains visible')
  assert.match(result.storageError, /Could not save/)
  const saved = fixture.storage.values.get(fixture.key)
  assert.equal(saved.result.type, 'error')
  assert.match(saved.result.message, /Could not save/)
  assert.equal(fixture.port.onMessage.listeners.size, 0)
  assert.equal(fixture.port.onDisconnect.listeners.size, 0)
}
test('reports response persistence failures and clears the saved running state', responseStorageFailure)

/** Keep request deadlines active after closure and stop worker keepalive calls after completion. */
async function detachedTimeout(context) {
  context.mock.timers.enable({apis: ['setTimeout', 'setInterval']})
  const started = Promise.withResolvers()
  /** Wait indefinitely until the request's deadline aborts the network. */
  function fetch(_url, options) {
    const network = Promise.withResolvers()
    /** Reject fetch when the deadline fires. */
    function aborted() { network.reject(new DOMException('Aborted', 'AbortError')) }
    options.signal.addEventListener('abort', aborted, {once: true})
    started.resolve(options.signal)
    return network.promise
  }
  const fixture = startRequest(context, fetch)
  const signal = await started.promise
  context.mock.timers.tick(REQUEST_TIMEOUT_MS)
  const result = await fixture.result
  assert.equal(signal.aborted, true)
  assert.match(result.message, /timed out/)
  const keepAliveCalls = fixture.storage.runtime.keepAliveCalls
  assert.ok(keepAliveCalls > 0)
  context.mock.timers.tick(REQUEST_TIMEOUT_MS)
  assert.equal(fixture.storage.runtime.keepAliveCalls, keepAliveCalls)
}
test('enforces the timeout and cleans up worker keepalive calls', detachedTimeout)

/** Reject webpage-originated control messages before they can delete or cancel extension data. */
function untrustedSender() {
  const storage = storageFixture()
  globalThis.chrome = storage.chrome
  const handlers = createHttpRequestHandlers(withoutHeaderRules)
  const {port} = requestPort()
  port.sender.url = 'https://example.test'
  handlers.handleHttpPort(port)
  assert.equal(port.disconnected, true)
  /** A rejected control message must not produce an acknowledgment. */
  function unexpectedReply() { assert.fail('Untrusted sender must not receive a reply.') }
  const handled = handlers.handleControlMessage({type: 'delete-saved-request', id: 'request-1'}, port.sender, unexpectedReply)
  assert.equal(handled, false)
}
test('rejects request ports and control messages from webpages', untrustedSender)

/** Return a completed response from the simulated network. */
function respondWith(response) {
  /** Resolve fetch with the given response. */
  function fetch() { return Promise.resolve(response) }
  return fetch
}

/** Wait until the background saves a result for the started request. */
async function savedResult(fixture) {
  /** Check for a stored result. */
  function completed() { return Boolean(fixture.storage.values.get(fixture.key)?.result) }
  await fixture.storage.waitFor(completed)
  return fixture.storage.values.get(fixture.key).result
}

/** Stop reading at the maximum response size, and keep a large body out of history. */
async function cutOffLargeBody(context) {
  const bytes = 1.5 * 1024 * 1024
  const response = new Response('a'.repeat(bytes), {headers: {'Content-Type': 'text/plain'}})
  const settings = {maxResponseMb: 1, historyBodyLimitMb: 0.5}
  const fixture = startRequest(context, respondWith(response), settings)
  const result = await fixture.result
  assert.equal(result.response.isTruncated, true)
  assert.equal(result.response.size, 1024 * 1024)
  assert.equal(result.response.body.length, 1024 * 1024)
  const saved = await savedResult(fixture)
  assert.equal(saved.response.body, '')
  assert.equal(saved.response.isBodyOmitted, true)
  assert.equal(saved.response.isTruncated, true)
  assert.equal(saved.response.status, 200)
}
test('cuts off a body at the maximum size and omits a large body from history', cutOffLargeBody)

/** Keep a body that fits both limits in history, with the default limits. */
async function keepSmallBody(context) {
  const response = new Response('{"small":true}', {headers: {'Content-Type': 'application/json'}})
  const fixture = startRequest(context, respondWith(response))
  const result = await fixture.result
  assert.equal(result.response.isTruncated, false)
  const saved = await savedResult(fixture)
  assert.equal(saved.response.body, '{"small":true}')
  assert.equal(saved.response.isBodyOmitted, undefined)
}
test('saves a body within the default limits in history', keepSmallBody)

/** Send the full body to the panel even when history saves no bodies. */
async function zeroHistoryLimit(context) {
  const response = new Response('kept for the panel')
  const fixture = startRequest(context, respondWith(response), {maxResponseMb: 10, historyBodyLimitMb: 0})
  const result = await fixture.result
  assert.equal(result.response.body, 'kept for the panel')
  const saved = await savedResult(fixture)
  assert.equal(saved.response.body, '')
  assert.equal(saved.response.isBodyOmitted, true)
}
test('sends the full body to the panel when history omits it', zeroHistoryLimit)

/** Do not decode or save binary bodies, but report their size. */
async function binaryBody(context) {
  const response = new Response(new Uint8Array([137, 80, 78, 71]), {headers: {'Content-Type': 'image/png'}})
  const fixture = startRequest(context, respondWith(response))
  const result = await fixture.result
  assert.equal(result.response.isBinary, true)
  assert.equal(result.response.body, '')
  assert.equal(result.response.size, 4)
  const saved = await savedResult(fixture)
  assert.equal(saved.response.isBinary, true)
  assert.equal(saved.response.isBodyOmitted, undefined)
}
test('does not decode or save binary response bodies', binaryBody)

/** Treat text, structured text, and missing types as text, and other media types as binary. */
function contentTypes() {
  assert.equal(isTextContentType(null), true)
  assert.equal(isTextContentType('text/html; charset=utf-8'), true)
  assert.equal(isTextContentType('application/problem+json'), true)
  assert.equal(isTextContentType('application/x-ndjson'), true)
  assert.equal(isTextContentType('image/svg+xml'), true)
  assert.equal(isTextContentType('application/x-www-form-urlencoded'), true)
  assert.equal(isTextContentType('image/png'), false)
  assert.equal(isTextContentType('application/octet-stream'), false)
  assert.equal(isTextContentType('application/pdf'), false)
}
test('detects text and binary content types', contentTypes)
