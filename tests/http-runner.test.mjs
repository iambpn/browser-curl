/** Unit tests for request persistence, cancellation, disconnection, and deletion with simulated fetch and storage. */
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createHttpRequestHandlers} from '../src/background/http-runner.ts'
import {HTTP_REQUEST_PORT, REQUEST_TIMEOUT_MS} from '../src/shared/http-messages.ts'
import {HISTORY_KEY_PREFIX} from '../src/shared/request-store.ts'
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

/** Start a persisted send with isolated extension APIs and an injected network implementation. */
function startRequest(context, fetch) {
  const storage = storageFixture()
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
