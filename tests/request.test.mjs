/** Unit tests for request validation, headers, bodies, and response formatting. */
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {
  buildRequest,
  formatResponse,
  formatSize,
  parseRequestUrl
} from '../src/sidebar/request.ts'

/** Create an isolated request draft with optional field overrides. */
function draft(overrides = {}) {
  return {
    method: 'GET',
    url: 'https://example.com/api',
    params: [],
    headers: [],
    body: '',
    bodyType: 'json',
    authorization: {type: 'none'},
    ...overrides
  }
}

/** Check query encoding, duplicate keys, and disabled or blank rows. */
function queryParameters() {
  const request = buildRequest(draft({
    url: 'https://example.com/api?old=value#fragment',
    params: [
      {enabled: true, key: 'tag', value: 'hello world'},
      {enabled: true, key: 'tag', value: 'a&b'},
      {enabled: false, key: 'secret', value: 'ignored'},
      {enabled: true, key: '', value: 'ignored'}
    ]
  }))
  assert.equal(request.url.href, 'https://example.com/api?tag=hello+world&tag=a%26b')
  assert.equal(request.init.body, undefined)
  assert.equal(request.init.credentials, 'omit')
}
test('encodes enabled parameters and preserves duplicate keys', queryParameters)

/** Check headers and the explicit bearer token override. */
function requestHeaders() {
  const request = buildRequest(draft({
    headers: [
      {enabled: true, key: ' X-Test ', value: 'present'},
      {enabled: false, key: 'X-Skip', value: 'absent'},
      {enabled: true, key: 'Authorization', value: 'old'}
    ],
    authorization: {type: 'bearer', token: ' test-token '}
  }))
  assert.equal(request.init.headers.get('X-Test'), 'present')
  assert.equal(request.init.headers.has('X-Skip'), false)
  assert.equal(request.init.headers.get('Authorization'), 'Bearer test-token')
}
test('uses enabled headers and the bearer token', requestHeaders)

/** Check JSON validation and automatic content type for a request body. */
function jsonBody() {
  const request = buildRequest(draft({method: 'POST', body: '{"name":"Ada"}'}))
  assert.equal(request.init.body, '{"name":"Ada"}')
  assert.equal(request.init.headers.get('Content-Type'), 'application/json')
  const invalid = draft({method: 'POST', body: '{broken'})
  /** Build an invalid JSON body to check the validation failure. */
  function buildInvalidJson() {
    buildRequest(invalid)
  }
  assert.throws(buildInvalidJson, SyntaxError)
}
test('validates JSON bodies before sending', jsonBody)

/** Check that bodyless methods retain invalid JSON drafts without sending them. */
function bodylessMethods() {
  for (const method of ['GET', 'HEAD']) {
    const request = buildRequest(draft({method, body: '{unfinished'}))
    assert.equal(request.init.body, undefined)
    assert.equal(request.init.headers.has('Content-Type'), false)
  }
}
test('omits request bodies for GET and HEAD', bodylessMethods)

/** Check raw text bodies and explicitly selected content types. */
function textBody() {
  const request = buildRequest(draft({
    method: 'PATCH',
    body: '<message>Hello</message>',
    bodyType: 'text',
    headers: [{enabled: true, key: 'Content-Type', value: 'application/xml'}]
  }))
  assert.equal(request.init.body, '<message>Hello</message>')
  assert.equal(request.init.headers.get('Content-Type'), 'application/xml')
  const plain = buildRequest(draft({method: 'PUT', body: 'hello', bodyType: 'text'}))
  assert.equal(plain.init.headers.get('Content-Type'), 'text/plain')
}
test('sends text and respects an explicit content type', textBody)

/** Reject unsupported protocols, malformed URLs, and embedded credentials. */
function invalidAddresses() {
  for (const address of ['not a URL', 'file:///tmp/a', 'javascript:alert(1)', 'https://user:pass@example.com']) {
    /** Attempt the invalid address without performing any network request. */
    function parseInvalidAddress() {
      parseRequestUrl(address)
    }
    assert.throws(parseInvalidAddress)
  }
  const valid = parseRequestUrl(' http://localhost:3000/api ')
  assert.equal(valid.href, 'http://localhost:3000/api')
}
test('accepts only HTTP URLs without embedded credentials', invalidAddresses)

/** Preserve text responses and support both raw and formatted JSON views. */
function responseFormatting() {
  assert.equal(formatResponse('{"ok":true}', true), '{\n  "ok": true\n}')
  assert.equal(formatResponse('{"ok":true}', false), '{"ok":true}')
  assert.equal(formatResponse('<h1>Server error</h1>', true), '<h1>Server error</h1>')
  assert.equal(formatResponse('', true), '')
}
test('formats JSON and preserves non-JSON responses', responseFormatting)

/** Check byte units at the display boundaries. */
function responseSizes() {
  assert.equal(formatSize(0), '0 B')
  assert.equal(formatSize(1023), '1023 B')
  assert.equal(formatSize(1024), '1.0 KB')
  assert.equal(formatSize(1048576), '1.0 MB')
}
test('formats response byte counts', responseSizes)

/** Encode Basic credentials and preserve non-ASCII characters as UTF-8. */
function basicAuthorization() {
  const basicDraft = draft({
    authorization: {type: 'basic', username: 'Aladdin', password: 'open sesame'}
  })
  const basic = buildRequest(basicDraft)
  assert.equal(basic.init.headers.get('Authorization'), 'Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==')

  const unicodeDraft = draft({
    authorization: {type: 'basic', username: 'René', password: '秘密'}
  })
  const unicode = buildRequest(unicodeDraft)
  const encoded = Buffer.from('René:秘密', 'utf8').toString('base64')
  assert.equal(unicode.init.headers.get('Authorization'), `Basic ${encoded}`)
}
test('encodes Basic credentials, including Unicode', basicAuthorization)

/** Reject a Basic username whose colon would change the credential fields. */
function invalidBasicUsername() {
  const invalid = draft({
    authorization: {type: 'basic', username: 'user:another', password: 'secret'}
  })
  /** Build the invalid credentials without making a network request. */
  function buildInvalidCredentials() {
    buildRequest(invalid)
  }
  assert.throws(buildInvalidCredentials, /username cannot contain a colon/)
}
test('rejects colons in Basic usernames', invalidBasicUsername)

/** Replace a matching manual header with the selected API key. */
function apiKeyHeader() {
  const apiDraft = draft({
    headers: [{enabled: true, key: 'X-API-Key', value: 'old-key'}],
    authorization: {type: 'api-key', key: ' X-API-Key ', value: 'new-key', location: 'header'}
  })
  const request = buildRequest(apiDraft)
  assert.equal(request.init.headers.get('X-API-Key'), 'new-key')
  assert.equal(request.init.headers.has('Authorization'), false)
  assert.equal(request.url.search, '')
}
test('sends an API key in the selected header', apiKeyHeader)

/** Encode query API keys and retain other parameters without duplicate credentials. */
function apiKeyQuery() {
  const apiDraft = draft({
    params: [
      {enabled: true, key: 'api_key', value: 'old-key'},
      {enabled: true, key: 'page', value: '2'}
    ],
    authorization: {type: 'api-key', key: 'api_key', value: 'a+b & c', location: 'query'}
  })
  const request = buildRequest(apiDraft)
  assert.deepEqual(request.url.searchParams.getAll('api_key'), ['a+b & c'])
  assert.equal(request.url.searchParams.get('page'), '2')
  assert.equal(request.init.headers.has('api_key'), false)
}
test('sends query API keys without duplicating existing keys', apiKeyQuery)

/** Stop sending when an API key has no name. */
function missingApiKeyName() {
  const invalid = draft({
    authorization: {type: 'api-key', key: ' ', value: 'secret', location: 'header'}
  })
  /** Build an API key without a name to check the validation error. */
  function buildUnnamedKey() {
    buildRequest(invalid)
  }
  assert.throws(buildUnnamedKey, /Enter a key name/)
}
test('requires an API key name', missingApiKeyName)

/** Preserve the full custom scheme instead of forcing a Bearer prefix. */
function customAuthorization() {
  const customDraft = draft({
    authorization: {type: 'custom', value: ' Token custom-secret '}
  })
  const request = buildRequest(customDraft)
  assert.equal(request.init.headers.get('Authorization'), 'Token custom-secret')
}
test('sends a custom Authorization value unchanged', customAuthorization)

/** Keep manual headers with No auth and omit empty custom or bearer values. */
function optionalAuthorization() {
  for (const authorization of [{type: 'none'}, {type: 'bearer', token: ''}, {type: 'custom', value: ' '}]) {
    const manualDraft = draft({
      headers: [{enabled: true, key: 'Authorization', value: 'Manual secret'}],
      authorization
    })
    const request = buildRequest(manualDraft)
    assert.equal(request.init.headers.get('Authorization'), 'Manual secret')
  }
}
test('keeps manual headers when no authorization value is added', optionalAuthorization)
