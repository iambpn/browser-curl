/** Unit tests for the text that the Request tab shows for a sent request. */
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {formatRequestLog, requestLogHeaders, sentRequestHeaders} from '../src/requests/request-log.ts'

/** A browser User-Agent value for the tests. */
const BROWSER_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) TestBrowser/1'

/** Add the browser's User-Agent when the editor has none, and drop headers that the browser controls. */
function browserUserAgentAdded() {
  const headers = sentRequestHeaders(
    {
      method: 'GET',
      url: 'https://api.example.test/items',
      headers: [['Accept', 'application/json'], ['Host', 'other.example.test'], ['X-Trace', 'one, two']]
    },
    BROWSER_USER_AGENT
  )
  assert.deepEqual(headers, [
    ['accept', 'application/json'],
    ['x-trace', 'one, two'],
    ['user-agent', BROWSER_USER_AGENT]
  ])
}
test('adds the browser User-Agent and leaves out browser-controlled headers', browserUserAgentAdded)

/** Keep a User-Agent from the editor, because the header rule sends that value instead of the browser's. */
function editorUserAgentKept() {
  const headers = sentRequestHeaders(
    {method: 'GET', url: 'https://api.example.test/', headers: [['User-Agent', 'curl/8.5.0']]},
    BROWSER_USER_AGENT
  )
  assert.deepEqual(headers, [['user-agent', 'curl/8.5.0']])
}
test('keeps the User-Agent that the editor sets', editorUserAgentKept)

/** Show the request line, the headers, and the body, separated like an HTTP message. */
function fullLog() {
  const log = formatRequestLog(
    {
      method: 'POST',
      url: 'https://api.example.test/items?tag=one',
      headers: [['content-type', 'application/json']],
      body: '{"name":"first"}'
    },
    BROWSER_USER_AGENT
  )
  assert.equal(
    log,
    [
      'POST https://api.example.test/items?tag=one',
      '',
      'content-type: application/json',
      `user-agent: ${BROWSER_USER_AGENT}`,
      '',
      '{"name":"first"}'
    ].join('\n')
  )
}
test('formats the request line, headers, and body', fullLog)

/** Leave out the body section when the request has no body. */
function logWithoutBody() {
  const log = formatRequestLog({method: 'GET', url: 'https://api.example.test/', headers: []}, BROWSER_USER_AGENT)
  assert.equal(log, `GET https://api.example.test/\n\nuser-agent: ${BROWSER_USER_AGENT}`)
}
test('omits the body section for a request without a body', logWithoutBody)

/** Put the browser's reported headers first, then add editor headers that the browser did not report. */
function reportedHeadersFirst() {
  const headers = requestLogHeaders(
    {
      method: 'GET',
      url: 'https://api.example.test/',
      headers: [['authorization', 'Bearer token'], ['x-trace', 'one']]
    },
    BROWSER_USER_AGENT,
    [['x-trace', 'one'], ['user-agent', BROWSER_USER_AGENT], ['accept-language', 'en-US']]
  )
  assert.deepEqual(headers, [
    ['x-trace', 'one'],
    ['user-agent', BROWSER_USER_AGENT],
    ['accept-language', 'en-US'],
    ['authorization', 'Bearer token']
  ])
}
test('shows the reported headers and adds editor headers that the browser did not report', reportedHeadersFirst)

/** Use the reported value when the browser changed a header, such as a User-Agent set by a header rule. */
function reportedValueWins() {
  const log = formatRequestLog(
    {method: 'GET', url: 'https://api.example.test/', headers: [['User-Agent', 'curl/8.5.0']]},
    BROWSER_USER_AGENT,
    [['user-agent', 'curl/8.5.0'], ['accept', '*/*']]
  )
  assert.equal(log, 'GET https://api.example.test/\n\nuser-agent: curl/8.5.0\naccept: */*')
}
test('keeps one line per header when the editor and the browser report the same name', reportedValueWins)
