/** Export uses only supported collection data and can be imported again without losing it. */
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'
import postman from 'postman-collection'
import {exportPostmanCollection, importPostmanCollection} from '../src/collections/postman-converter.ts'

const schema = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'

function collection(item = [], extra = {}) {
  return importPostmanCollection(JSON.stringify({info: {name: 'Example API', schema}, item, ...extra})).collection
}

function exported(source) {
  return JSON.parse(exportPostmanCollection(source).json)
}

test('Postman SDK imports exported URL components and reconstructs the enabled URL without changing variables', () => {
  for (const address of [
    'https://example.com/health?kept=yes',
    'http://localhost:8080/a%20b/nested/?kept=yes#section',
    '{{baseUrl}}/v1/{{resource}}?kept={{value}}',
    '{{protocol}}://{{sub.domain}}.example.com:{{port}}/{{path}}?kept={{value}}#{{fragment}}',
    'https://[::1]:8443/health?kept=yes',
    'https://example.com',
    'https://example.com/'
  ]) {
    const source = collection([{name: 'URL', request: {url: address}}])
    source.requests[0].editor.params.push({enabled: false, key: 'off', value: 'not-sent'})
    const result = exported(source)
    const url = new postman.Collection(result).items.idx(0).request.url
    assert.equal(url.toString(), address)
    assert.ok(url.getHost(), 'Postman must receive the host, not only raw text')
    assert.equal(result.item[0].request.url.raw, address)
    assert.equal(url.query.idx(url.query.count() - 1).disabled, true)
  }
})

test('ignores blank Params placeholders just like sending a saved request', () => {
  const source = collection([{name: 'Health', request: {url: 'https://example.com/health'}}])
  source.requests[0].editor.params = [
    {enabled: true, key: '', value: ''},
    {enabled: true, key: '  ', value: 'ignored'},
    {enabled: false, key: 'off', value: 'kept'}
  ]
  const result = exported(source)
  assert.equal(result.item[0].request.url.raw, 'https://example.com/health')
  assert.deepEqual(result.item[0].request.url.query, [{key: 'off', value: 'kept', disabled: true}])
  assert.equal(new postman.Collection(result).items.idx(0).request.url.toString(), 'https://example.com/health')
})

test('preserves URL delimiters inside variable names when replacing the saved query', () => {
  const source = collection([{name: 'Variables', request: {url: '{{baseUrl}}'}}])
  source.requests[0].editor.url = '{{protocol}}://{{host.name}}:{{#port}}/{{p?ath}}?old=value#{{hash#}}'
  source.requests[0].editor.params = [{enabled: true, key: 'kept', value: '{{v#?&}}'}]
  const result = exported(source)
  const expected = '{{protocol}}://{{host.name}}:{{#port}}/{{p?ath}}?kept={{v#?&}}#{{hash#}}'
  assert.equal(result.item[0].request.url.raw, expected)
  assert.equal(new postman.Collection(result).items.idx(0).request.url.toString(), expected)
})

test('exports v2.1 JSON with collection metadata, nested folders, and request order', () => {
  const source = collection([
    {name: 'First', request: {method: 'POST', url: '{{baseUrl}}/first'}},
    {name: 'Folder', item: [{name: 'Nested', item: [{name: 'Last', request: {url: '{{baseUrl}}/last'}}]}]},
    {name: 'After folder', request: {url: '{{baseUrl}}/after'}}
  ])
  source.postmanId = 'saved-postman-id'
  const {json, fileName} = exportPostmanCollection(source)
  const result = JSON.parse(json)
  assert.deepEqual(result.info, {name: 'Example API', _postman_id: 'saved-postman-id', schema})
  assert.equal(fileName, 'Example API.postman_collection.json')
  assert.deepEqual(result.item.map(({name}) => name), ['First', 'Folder', 'After folder'])
  assert.equal(result.item[0].request.method, 'POST')
  assert.equal(result.item[1].item[0].item[0].name, 'Last')
  assert.equal(result.item[1].item[0].item[0].request.url.raw, '{{baseUrl}}/last')
  assert.deepEqual(importPostmanCollection(json).warnings, [])
})

test('keeps disabled rows and builds raw URL from enabled query rows without changing variables', () => {
  const source = collection([{name: 'Query', request: {url: '{{baseUrl}}/search?stale=1#section'}}])
  const editor = source.requests[0].editor
  editor.params = [
    {enabled: true, key: 'q', value: '{{term}}'},
    {enabled: false, key: 'off', value: '{{secret}}'},
    {enabled: true, key: 'tag', value: 'a&b=c #✓'},
    {enabled: true, key: 'tag', value: 'second'},
    {enabled: true, key: 'literal+percent', value: '%20'}
  ]
  editor.headers = [{enabled: true, key: 'X-On', value: '{{on}}'}, {enabled: false, key: 'X-Off', value: 'kept'}]
  const before = structuredClone(editor)
  const request = exported(source).item[0].request
  assert.deepEqual(request.url.query, [
    {key: 'q', value: '{{term}}', disabled: false},
    {key: 'off', value: '{{secret}}', disabled: true},
    {key: 'tag', value: 'a%26b%3Dc%20%23%E2%9C%93', disabled: false},
    {key: 'tag', value: 'second', disabled: false},
    {key: 'literal%2Bpercent', value: '%2520', disabled: false}
  ])
  assert.equal(request.url.raw, '{{baseUrl}}/search?q={{term}}&tag=a%26b%3Dc%20%23%E2%9C%93&tag=second&literal%2Bpercent=%2520#section')
  assert.equal(new postman.Collection(exported(source)).items.idx(0).request.url.toString(), request.url.raw)
  assert.deepEqual(request.header, [{key: 'X-On', value: '{{on}}', disabled: false}, {key: 'X-Off', value: 'kept', disabled: true}])
  assert.deepEqual(importPostmanCollection(exportPostmanCollection(source).json).collection.requests[0].editor, {...before, url: request.url.raw})
  assert.deepEqual(editor, before)
  editor.params.forEach(row => { row.enabled = false })
  assert.equal(exported(source).item[0].request.url.raw, '{{baseUrl}}/search#section')
})

test('writes raw JSON and text bodies with their format and unchanged contents', () => {
  for (const language of ['json', 'text']) {
    const body = {mode: 'raw', raw: '{"name":"{{name}}"}\n', options: {raw: {language}}}
    const source = collection([{name: 'Body', request: {url: '{{url}}', method: 'PATCH', body}}])
    assert.deepEqual(exported(source).item[0].request.body, body)
  }
})

for (const [authType, type, attributes] of [
  ['none', 'noauth', undefined],
  ['bearer', 'bearer', {token: '{{token}}'}],
  ['basic', 'basic', {username: '{{user}}', password: '{{password}}'}],
  ['api-key', 'apikey', {key: 'X-Key', value: '{{key}}', in: 'header'}],
  ['api-key', 'apikey', {key: 'X-Key', value: '{{key}}', in: 'query'}]
]) {
  test(`exports only selected ${authType} ${attributes?.in ?? ''} authorization`, () => {
    const source = collection([{name: 'Auth', request: {url: '{{url}}'}}])
    const editor = source.requests[0].editor
    editor.authType = authType
    editor.authValues = {
      'bearer-token': '{{token}}', 'basic-username': '{{user}}', 'basic-password': '{{password}}',
      'api-key-name': 'X-Key', 'api-key-value': '{{key}}', 'api-key-location': attributes?.in ?? 'header',
      'custom-authorization': 'inactive-secret'
    }
    const result = exported(source).item[0].request.auth
    assert.deepEqual(result, {type, ...(attributes ? {[type]: Object.entries(attributes).map(([key, value]) => ({key, value, type: 'string'}))} : {})})
    assert.ok(!JSON.stringify(exported(source)).includes('inactive-secret'))
  })
}

test('custom auth becomes noauth and one enabled Authorization header, replacing all case variants', () => {
  const source = collection([{name: 'Custom', request: {url: '{{url}}', header: [
    {key: 'authorization', value: 'old'}, {key: 'AUTHORIZATION', value: 'disabled', disabled: true},
    {key: ' Authorization ', value: 'spaced'}, {key: 'X-Keep', value: '{{keep}}', disabled: true}
  ]}}])
  const editor = source.requests[0].editor
  editor.authType = 'custom'
  editor.authValues['custom-authorization'] = 'Token {{custom}}'
  editor.authValues['bearer-token'] = 'inactive-token'
  const result = exported(source).item[0].request
  assert.deepEqual(result.auth, {type: 'noauth'})
  assert.deepEqual(result.header, [
    {key: 'X-Keep', value: '{{keep}}', disabled: true},
    {key: 'Authorization', value: 'Token {{custom}}', disabled: false}
  ])
  const again = importPostmanCollection(exportPostmanCollection(source).json).collection.requests[0].editor
  assert.equal(again.authType, 'none')
  assert.equal(again.headers.at(-1).value, 'Token {{custom}}')
  assert.equal(editor.headers.length, 4)
})

test('exports collection base names with empty values and a stable saved or generated Postman ID', () => {
  const variable = [{key: 'baseUrl', value: '{{host}}', type: 'string', disabled: true, extra: {kept: [1, 2]}}]
  const source = collection([], {variable})
  const first = exported(source)
  assert.match(first.info._postman_id, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/)
  assert.equal(source.postmanId, first.info._postman_id)
  assert.deepEqual(exported(structuredClone(source)), first)
  assert.deepEqual(first.variable, [{key: 'baseUrl', value: ''}])
  source.postmanId = 'imported-id'
  assert.equal(exported(source).info._postman_id, 'imported-id')
  assert.equal(exported(collection()).variable, undefined)
})

test('exports only base names in base order at each level, omitting all forks and empty lists', () => {
  const source = collection([
    {name: 'Folder', item: [{name: 'Request', request: {url: '{{url}}'}}]},
    {name: 'Empty folder', item: []}, {name: 'Empty request', request: {url: '{{url}}'}}
  ])
  const folder = source.requests[0]
  const request = folder.requests[0]
  for (const [level, names] of [[source, ['url', 'token']], [folder, ['folder']], [request, ['request', 'token']]]) {
    level.env = {baseNames: names, forks: ['local', 'staging'].map(name => ({
      id: `${name}-id`, name, variables: [...names, 'fork-only'].map(name => ({name, value: `secret-${name}`}))
    }))}
  }
  // A fork-only level has no base list to share.
  source.requests[1].env = {baseNames: [], forks: [{id: 'private', name: 'private', variables: [{name: 'private-name', value: 'private-value'}]}]}
  source.chosenEnv = 'local'
  const before = structuredClone(source)
  const result = exported(source)
  assert.deepEqual(result.variable, [{key: 'url', value: ''}, {key: 'token', value: ''}])
  assert.deepEqual(result.item[0].variable, [{key: 'folder', value: ''}])
  assert.deepEqual(result.item[0].item[0].variable, [{key: 'request', value: ''}, {key: 'token', value: ''}])
  assert.equal('variable' in result.item[1], false)
  assert.equal('variable' in result.item[2], false)
  for (const privateText of ['secret-', 'fork-only', 'private-name', 'private-value', 'forks', 'chosenEnv', 'staging', 'local-id']) {
    assert.ok(!JSON.stringify(result).includes(privateText), privateText)
  }
  assert.deepEqual(source, {...before, postmanId: result.info._postman_id})
})

test('import then export keeps variable names at the collection, nested folders, and request levels', () => {
  const variable = (key) => [{key, value: `secret-${key}`}]
  const source = collection([
    {name: 'Folder', variable: variable('folder'), item: [
      {name: 'Nested', variable: variable('nested'), item: [
        {name: 'Request', variable: variable('request'), request: {url: '{{url}}'}}
      ]}
    ]}
  ], {variable: [...variable('url'), {key: 'empty', value: ''}]})
  const first = exported(source)
  assert.deepEqual(first.variable, [{key: 'url', value: ''}, {key: 'empty', value: ''}])
  assert.deepEqual(first.item[0].variable, [{key: 'folder', value: ''}])
  assert.deepEqual(first.item[0].item[0].variable, [{key: 'nested', value: ''}])
  assert.deepEqual(first.item[0].item[0].item[0].variable, [{key: 'request', value: ''}])
  const again = importPostmanCollection(JSON.stringify(first))
  assert.equal(again.collection.chosenEnv, null)
  assert.deepEqual(exported(again.collection), first)
  assert.deepEqual(again.warnings, [])
})

test('replaces forbidden filename characters while keeping the collection name inside the JSON', () => {
  const source = collection()
  source.name = 'API<>:"/\\|?*\u0000\u001f✓'
  const {json, fileName} = exportPostmanCollection(source)
  assert.equal(fileName, 'API' + '_'.repeat(11) + '✓.postman_collection.json')
  assert.equal(JSON.parse(json).info.name, source.name)
})

test('importing then exporting a fixture keeps every supported part and omits dropped parts', () => {
  const fixture = readFileSync(new URL('../e2e/data/postman-v2.1.json', import.meta.url), 'utf8')
  const imported = importPostmanCollection(fixture)
  assert.ok(imported.warnings.length > 0)
  const {json} = exportPostmanCollection(imported.collection)
  const again = importPostmanCollection(json)
  const shared = structuredClone(imported.collection)
  shared.env.forks = []
  shared.chosenEnv = null
  assert.deepEqual(again.collection, shared)
  assert.deepEqual(again.warnings, [])
  const result = JSON.parse(json)
  assert.equal(result.info._postman_id, 'fixture-widget-api')
  assert.equal(result.auth, undefined)
  assert.equal(result.item[0].auth, undefined)
  for (const dropped of ['description', 'event', 'response', 'protocolProfileBehavior']) {
    assert.ok(!json.includes(`"${dropped}":`))
  }
})
