/** Exercise the real background fetch, browser header rules, and response viewer against a loopback service. */
import {test, expect} from './fixtures.mjs'
import {
  addEntry, click, echoedRequest, expectText, expectVisible, fill, send, sessionRules, storedHistory
} from './panel-helpers.mjs'

/** Verify the wire request, including browser-controlled headers and the absence of an automatic Origin header. */
async function actualRequest({extension, api}) {
  const panel = await extension.openPanel()
  await fill(panel, '#request-url', `${api.origin}/echo?tag=one&tag=two`)
  await panel.locator('#request-method').selectOption('POST')
  await click(panel, '#body-tab')
  await fill(panel, '#request-body', '{"message":"héllo"}')
  await addEntry(panel, 'headers', 'X-Test', 'first')
  await addEntry(panel, 'headers', 'X-Test', 'second')
  await addEntry(panel, 'headers', 'X-Disabled', 'not sent', false)
  await addEntry(panel, 'params', 'disabled', 'not sent', false)
  await send(panel)

  const received = await echoedRequest(panel)
  expect(received.method).toBe('POST')
  expect(received.url).toBe('/echo?tag=one&tag=two')
  expect(received.body).toBe('{"message":"héllo"}')
  expect(received.headers['content-type']).toBe('application/json')
  expect(received.headers['x-test']).toBe('first, second')
  expect(received.headers['x-disabled']).toBeUndefined()
  expect(received.headers.origin).toBeUndefined()
  expect(received.headers['content-length']).toBe('20')
  expect(api.requests).toHaveLength(1)
  const saved = await panel.evaluate(storedHistory)
  expect(saved).toHaveLength(1)
  expect(saved[0].result.response.status).toBe(200)
  const rules = await panel.evaluate(sessionRules)
  expect(rules).toEqual([])
}
test('sends a real request with its method, body, duplicate parameters, and headers', actualRequest)

/** Verify the locked headers at the server, rather than only checking how the extension classifies them. */
async function lockedHeaders({extension, api}) {
  const panel = await extension.openPanel()
  await fill(panel, '#request-url', `${api.origin}/echo`)
  await panel.locator('#request-method').selectOption('POST')
  await click(panel, '#body-tab')
  await panel.locator('#body-type').selectOption('text')
  await fill(panel, '#request-body', 'wire body')
  await addEntry(panel, 'headers', 'Cookie', 'session=test; theme=dark')
  await addEntry(panel, 'headers', 'Origin', 'https://origin.example.test')
  await addEntry(panel, 'headers', 'Referer', 'https://referrer.example.test/from')
  await addEntry(panel, 'headers', 'User-Agent', 'browsercurl-e2e/1')
  await addEntry(panel, 'headers', 'Sec-Fetch-Site', 'same-origin')
  await addEntry(panel, 'headers', 'Host', 'invalid.example.test')
  await addEntry(panel, 'headers', 'Content-Length', '999')
  await send(panel)
  const received = await echoedRequest(panel)
  expect(received.headers.cookie).toBe('session=test; theme=dark')
  expect(received.headers.origin).toBe('https://origin.example.test')
  expect(received.headers.referer).toBe('https://referrer.example.test/from')
  expect(received.headers['user-agent']).toBe('browsercurl-e2e/1')
  expect(received.headers['sec-fetch-site']).toBe('same-origin')
  const host = new URL(api.origin).host
  expect(received.headers.host).toBe(host)
  expect(received.headers['content-length']).toBe('9')
  const note = panel.locator('#response-note')
  await expect(note).toContainText('Host')
  await expect(note).toContainText('Content-Length')
}
test('applies locked headers with real browser rules and preserves browser-owned headers', lockedHeaders)

/** Display HTTP failures as responses, follow redirects, and decode compressed response bodies. */
async function responseKinds({extension, api}) {
  const panel = await extension.openPanel()
  await fill(panel, '#request-url', `${api.origin}/status/418`)
  await send(panel)
  const status = panel.locator('#response-status')
  await expect(status).toContainText('418')
  const errorBody = await echoedRequest(panel)
  expect(errorBody).toEqual({error: 'test status'})

  await fill(panel, '#request-url', `${api.origin}/redirect`)
  await send(panel)
  await expectText(panel, '#response-url', `${api.origin}/echo?redirected=yes`)
  const redirected = await echoedRequest(panel)
  expect(redirected.url).toBe('/echo?redirected=yes')

  await fill(panel, '#request-url', `${api.origin}/gzip`)
  await send(panel)
  const decompressed = await echoedRequest(panel)
  expect(decompressed).toEqual({compressed: true})
  await expectText(panel, '#response-size', '19 B')
  const saved = await panel.evaluate(storedHistory)
  expect(saved).toHaveLength(3)
}
test('renders real HTTP errors, final redirect URLs, and decompressed bodies', responseKinds)

/** Save actual network failures and recover with a successful send using the same panel. */
async function networkFailure({extension, api}) {
  const panel = await extension.openPanel()
  await fill(panel, '#request-url', `${api.origin}/disconnect`)
  await click(panel, '#send-request')
  await expectVisible(panel, '#request-error')
  await expectText(panel, '#send-request', 'Send')
  const saved = await panel.evaluate(storedHistory)
  expect(saved).toHaveLength(1)
  expect(saved[0].result.type).toBe('error')
  await fill(panel, '#request-url', `${api.origin}/echo`)
  await send(panel)
}
test('saves a live network failure and allows a later successful request', networkFailure)

/** Send every authorization type through the actual form and verify the exact server-received credentials. */
async function authorizationTypes({extension, api}) {
  const panel = await extension.openPanel()
  const cases = [
    {name: 'manual header', type: 'none', fields: [], authorization: 'Manual original'},
    {name: 'bearer', type: 'bearer', fields: [['#bearer-token', '  test-token  ']], authorization: 'Bearer test-token'},
    {name: 'basic UTF-8', type: 'basic', fields: [['#basic-username', 'usér'], ['#basic-password', 'páss']], authorization: 'Basic dXPDqXI6cMOhc3M='},
    {name: 'API key header', type: 'api-key', fields: [['#api-key-name', 'X-API-Key'], ['#api-key-value', 'header-secret']], authorization: 'Manual original', location: 'header'},
    {name: 'API key query', type: 'api-key', fields: [['#api-key-name', 'api_key'], ['#api-key-value', 'query-secret']], authorization: 'Manual original', location: 'query'},
    {name: 'custom scheme', type: 'custom', fields: [['#custom-authorization', 'Token exact']], authorization: 'Token exact'}
  ]
  for (const authorization of cases) {
    /** Apply one authorization scheme without bypassing any form or request-building behavior. */
    async function sendAuthorizationCase() {
      await click(panel, '#clear-request')
      await fill(panel, '#request-url', `${api.origin}/echo?api_key=old`)
      await addEntry(panel, 'headers', 'Authorization', 'Manual original')
      await click(panel, '#auth-tab')
      await panel.locator('#auth-type').selectOption(authorization.type)
      for (const [selector, value] of authorization.fields) await fill(panel, selector, value)
      if (authorization.location) {
        await panel.locator('#api-key-location').selectOption(authorization.location)
      }
      await send(panel)
      const received = await echoedRequest(panel)
      expect(received.headers.authorization).toBe(authorization.authorization)
      if (authorization.location === 'header') expect(received.headers['x-api-key']).toBe('header-secret')
      if (authorization.location === 'query') expect(received.url).toBe('/echo?api_key=query-secret')
    }
    await test.step(authorization.name, sendAuthorizationCase)
  }
  expect(api.requests).toHaveLength(cases.length)
}
test('sends manual, bearer, Basic, API-key, and custom authorization to the real server', authorizationTypes)

/** Keep invalid URLs, JSON, and authorization in the editor without creating sent history or network traffic. */
async function invalidDrafts({extension, api}) {
  const panel = await extension.openPanel()
  await fill(panel, '#request-url', 'ftp://example.test/file')
  await click(panel, '#send-request')
  const error = panel.locator('#request-error')
  await expect(error).toContainText('http:// or https://')
  await fill(panel, '#request-url', 'http://user:pass@example.test')
  await click(panel, '#send-request')
  await expect(error).toContainText('Remove credentials')
  await fill(panel, '#request-url', `${api.origin}/echo`)
  await panel.locator('#request-method').selectOption('POST')
  await click(panel, '#body-tab')
  await fill(panel, '#request-body', '{"unfinished":')
  await click(panel, '#send-request')
  await expect(error).toBeVisible()
  await fill(panel, '#request-body', '{"valid":true}')
  await click(panel, '#auth-tab')
  await panel.locator('#auth-type').selectOption('basic')
  await fill(panel, '#basic-username', 'invalid:name')
  await click(panel, '#send-request')
  await expect(error).toContainText('colon')
  await panel.locator('#auth-type').selectOption('api-key')
  await click(panel, '#send-request')
  await expect(error).toContainText('key name')
  const saved = await panel.evaluate(storedHistory)
  expect(saved).toEqual([])
  expect(api.requests).toEqual([])
  await fill(panel, '#api-key-name', 'X-Valid')
  await send(panel)
  expect(api.requests).toHaveLength(1)
}
test('keeps invalid requests unsent and recovers after correcting the form', invalidDrafts)
