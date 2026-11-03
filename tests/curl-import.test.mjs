/** Unit tests for converting pasted cURL commands into request editor values. */
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {describeImport, importCurlCommand} from '../src/sidebar/curl-import.ts'

/** Check a multi-line DevTools-style command with a JSON body, cookies, and Basic auth. */
function devToolsCommand() {
  const {draft, warnings} = importCurlCommand(`curl 'https://api.example.com/v1/users?page=2&tag=a%20b' \\
  -X POST \\
  -H 'Content-Type: application/json' \\
  -H 'X-Trace: 1' -H 'X-Trace: 2' \\
  -H 'Cookie: session=abc; theme=dark' \\
  --data-raw '{"name": "Ada"}' \\
  -u 'ada:pa:ss'`)
  assert.equal(draft.method, 'POST')
  assert.equal(draft.url, 'https://api.example.com/v1/users?page=2&tag=a+b')
  assert.deepEqual(draft.params, [
    {enabled: true, key: 'page', value: '2'},
    {enabled: true, key: 'tag', value: 'a b'}
  ])
  assert.deepEqual(draft.headers, [
    {enabled: true, key: 'Content-Type', value: 'application/json'},
    {enabled: true, key: 'X-Trace', value: '1'},
    {enabled: true, key: 'X-Trace', value: '2'},
    {enabled: true, key: 'Cookie', value: 'session=abc; theme=dark'}
  ])
  assert.equal(draft.body, '{"name": "Ada"}')
  assert.equal(draft.bodyType, 'json')
  assert.deepEqual(draft.authorization, {type: 'basic', username: 'ada', password: 'pa:ss'})
  assert.deepEqual(warnings, [])
}
test('imports a multi-line command with body, cookies, and Basic auth', devToolsCommand)

/** Check short options for data, cookies, agent, referer, and a Bearer header. */
function shortOptions() {
  const {draft} = importCurlCommand(
    "curl -d 'a=1' -d 'b=x y' -b 'c=d' -A 'Agent/1' -e https://ref.example https://x.example -H 'Authorization: Bearer tok'"
  )
  assert.equal(draft.method, 'POST')
  assert.equal(draft.body, 'a=1&b=x y')
  assert.equal(draft.bodyType, 'text')
  assert.deepEqual(draft.authorization, {type: 'bearer', token: 'tok'})
  const headerNames = draft.headers.map((entry) => entry.key)
  assert.deepEqual(headerNames, ['User-Agent', 'Referer', 'Content-Type', 'Cookie'])
}
test('imports short data, cookie, agent, and referer options', shortOptions)

/** Check that -G moves data into query parameters and keeps the GET method. */
function getWithData() {
  const {draft} = importCurlCommand('curl -G https://x.example/search -d q=books')
  assert.equal(draft.method, 'GET')
  assert.equal(draft.url, 'https://x.example/search?q=books')
  assert.equal(draft.body, '')
}
test('imports -G data as query parameters', getWithData)

/** Check that unknown Authorization schemes stay as custom values. */
function customAuthorization() {
  const {draft} = importCurlCommand("curl https://x.example -H 'Authorization: Token abc'")
  assert.deepEqual(draft.authorization, {type: 'custom', value: 'Token abc'})
  assert.deepEqual(draft.headers, [])
}
test('keeps unknown Authorization schemes as custom values', customAuthorization)

/** Check that unsupported options produce a warning instead of a silent loss. */
function unsupportedOptions() {
  const {warnings} = importCurlCommand('curl https://x.example -F a=b')
  assert.ok(warnings.some((warning) => warning.includes('-F')))
}
test('reports curl options that the editor cannot use', unsupportedOptions)

/** Check that text that is not a complete cURL command fails with an error. */
function invalidCommands() {
  for (const command of ['curl', 'echo hello']) {
    /** Import the invalid command so assert.throws can check the error. */
    function importInvalidCommand() {
      importCurlCommand(command)
    }
    assert.throws(importInvalidCommand)
  }
}
test('rejects commands without a URL or without curl', invalidCommands)

/** Check the one-sentence import summary. */
function importSummary() {
  const {draft} = importCurlCommand(
    "curl https://x.example?a=1 -H 'X-A: 1' --json '{\"a\":1}' -H 'Authorization: Bearer t'"
  )
  assert.equal(
    describeImport(draft),
    'Imported the POST request with 1 query parameter, 3 headers, a JSON body, and a Bearer token.'
  )
  const pair = importCurlCommand("curl https://x.example -H 'X-A: 1' -d 'text'")
  assert.equal(describeImport(pair.draft), 'Imported the POST request with 2 headers and a text body.')
  const plain = importCurlCommand('curl https://x.example')
  assert.equal(describeImport(plain.draft), 'Imported the GET request.')
}
test('describes the imported request', importSummary)
