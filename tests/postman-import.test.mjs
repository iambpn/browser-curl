/** Postman import exposes editor values, ordered items, metadata, and warnings without browser APIs. */
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {importPostmanCollection} from '../src/collections/postman-converter.ts'
import {buildRequest} from '../src/requests/request.ts'

function file(item = [], extra = {}, version = '2.1.0') {
  return JSON.stringify({
    info: {name: 'Example API', _postman_id: 'postman-id', schema: `https://schema.getpostman.com/json/collection/v${version}/collection.json`},
    item, ...extra
  })
}

function importedRequest(request) {
  return importPostmanCollection(file([{name: 'Send request', request}])).collection.requests[0].editor
}

test('imports collection, nested folder, and request variables as base names and imported forks', () => {
  const {collection, warnings} = importPostmanCollection(file([
    {name: 'Folder', variable: [{key: ' folder ', value: 'folder-value'}], item: [
      {name: 'Nested', item: [{name: 'Request', variable: [{key: 'request', value: 'request-value'}], request: {url: '{{collection}}'}}]}
    ]}
  ], {variable: [{key: 'collection', value: 'collection-value'}]}))
  const folder = collection.requests[0]
  const request = folder.requests[0].requests[0]
  for (const [level, name, value] of [[collection, 'collection', 'collection-value'], [folder, 'folder', 'folder-value'], [request, 'request', 'request-value']]) {
    assert.deepEqual(level.env.baseNames, [name])
    assert.equal(level.env.forks.length, 1)
    assert.ok(level.env.forks[0].id)
    assert.equal(level.env.forks[0].name, 'imported')
    assert.deepEqual(level.env.forks[0].variables, [{name, value}])
    assert.equal(level.variables, undefined)
  }
  assert.equal(collection.chosenEnv, 'imported')
  assert.deepEqual(warnings, [])
})

test('trims and merges keys in first-name order, skips invalid keys with their paths, and ignores disabled values', () => {
  const variable = [
    {key: ' token ', value: 'first'}, {key: 'empty', value: ''},
    {key: 'disabled', value: 'disabled-secret', disabled: true},
    {key: 'token', value: 'last'}, {key: ' token ', value: ''},
    {key: 'token', value: 'ignored', disabled: true}, {key: 'Token', value: 'case-sensitive'},
    {key: 'zero', value: 0}, {key: 'false', value: false}, {key: 'space', value: ' '},
    {key: '', value: 'invalid'}, {key: '  ', value: 'invalid'},
    {key: 'bad{key', value: 'invalid'}, {key: 'bad}key', value: 'invalid'}
  ]
  const {collection, warnings} = importPostmanCollection(file([
    {name: 'Folder', variable, item: [{name: 'Request', variable, request: {url: '{{token}}'}}]}
  ], {variable}))
  for (const level of [collection, collection.requests[0], collection.requests[0].requests[0]]) {
    assert.deepEqual(level.env.baseNames, ['token', 'empty', 'disabled', 'Token', 'zero', 'false', 'space'])
    assert.deepEqual(level.env.forks[0].variables, [
      {name: 'token', value: 'last'}, {name: 'empty', value: ''}, {name: 'disabled', value: ''},
      {name: 'Token', value: 'case-sensitive'}, {name: 'zero', value: '0'},
      {name: 'false', value: 'false'}, {name: 'space', value: ' '}
    ])
  }
  assert.equal(warnings.length, 4)
  for (const key of ['', '  ', 'bad{key', 'bad}key']) {
    const warning = warnings.find((warning) => warning.includes(JSON.stringify(key)))
    assert.ok(warning, `Warning must identify ${JSON.stringify(key)}`)
    assert.ok(warning.includes('Example API / Folder / Request'))
    assert.ok(warning.includes('skipped'))
  }
})

test('chooses No env for only empty or disabled variables, and imported for a fork only on a descendant', () => {
  const emptyVariables = [{key: 'empty'}, {key: 'null', value: null}, {key: 'disabled', value: 'secret', disabled: true}]
  for (const variable of [undefined, [], emptyVariables]) {
    const {collection, warnings} = importPostmanCollection(file([
      {name: 'Folder', variable, item: [{name: 'Request', variable, request: {url: '{{empty}}'}}]}
    ], {variable}))
    assert.equal(collection.chosenEnv, null)
    for (const level of [collection, collection.requests[0], collection.requests[0].requests[0]]) {
      assert.deepEqual(level.env.forks, [])
      assert.deepEqual(level.env.baseNames, variable ? variable.map(({key}) => key) : [])
    }
    assert.deepEqual(warnings, [])
  }
  for (const onRequest of [false, true]) {
    const variable = [{key: 'child', value: 'value'}]
    const {collection} = importPostmanCollection(file([
      {name: 'Folder', variable: onRequest ? [] : variable, item: [
        {name: 'Request', variable: onRequest ? variable : [], request: {url: '{{child}}'}}
      ]}
    ]))
    assert.deepEqual(collection.env.forks, [])
    assert.equal(collection.chosenEnv, 'imported')
  }
})

test('reads string URLs and raw object URLs as text and keeps disabled query and header rows', () => {
  for (const url of ['{{baseUrl}}/search?q={{term}}&tag=a%20b', {raw: '{{baseUrl}}/search?q={{term}}&tag=a%20b'}]) {
    const editor = importedRequest({url})
    assert.equal(editor.url, '{{baseUrl}}/search?q={{term}}&tag=a%20b')
    assert.deepEqual(editor.params, [
      {enabled: true, key: 'q', value: '{{term}}'}, {enabled: true, key: 'tag', value: 'a b'}
    ])
  }
  const editor = importedRequest({
    url: {raw: '{{baseUrl}}/search?q=yes', query: [{key: 'q', value: 'yes'}, {key: 'off', value: '{{off}}', disabled: true}]},
    header: [{key: 'X-On', value: '{{on}}'}, {key: 'X-Off', value: 'kept', disabled: true}]
  })
  assert.deepEqual(editor.params, [{enabled: true, key: 'q', value: 'yes'}, {enabled: false, key: 'off', value: '{{off}}'}])
  assert.deepEqual(editor.headers, [{enabled: true, key: 'X-On', value: '{{on}}'}, {enabled: false, key: 'X-Off', value: 'kept'}])
})

test('builds object URLs without raw from protocol, host, port, path, and enabled query text', () => {
  const editor = importedRequest({url: {
    protocol: 'https', host: ['{{subdomain}}', 'example', 'com'], port: '{{port}}', path: ['v1', '{{resource}}'],
    query: [{key: 'q', value: '{{term}}'}, {key: 'off', value: 'kept', disabled: true}]
  }})
  assert.equal(editor.url, 'https://{{subdomain}}.example.com:{{port}}/v1/{{resource}}?q={{term}}')
  assert.equal(editor.params[1].enabled, false)
  assert.equal(importedRequest({url: {host: '{{baseUrl}}', path: '/echo'}}).url, '{{baseUrl}}/echo')
  assert.equal(importedRequest('https://example.com/short?q=yes').params[0].value, 'yes')
})

test('normalizes query keys and values consistently across string and object URLs before sending', () => {
  const query = [
    {key: 'search%20term', value: 'hello%20world'},
    {key: 'plus+key', value: 'a%2Bb+c'},
    {key: 'reserved', value: 'a%26b%3Dc%23d'},
    {key: 'unicode', value: '%E2%9C%93'},
    {key: 'percent', value: '%2520'},
    {key: 'malformed', value: '%ZZ'},
    {key: 'template', value: '{{term}}'},
    {key: 'search%20term', value: 'second'}
  ]
  const raw = `https://example.com/echo?${query.map(({key, value}) => `${key}=${value}`).join('&')}`
  const expected = importedRequest({url: raw})
  const disabled = {key: 'off%20key', value: 'off%20value', disabled: true}
  for (const url of [
    {raw},
    {raw, query: [...query, disabled]},
    {protocol: 'https', host: 'example.com', path: ['echo'], query: [...query, disabled]}
  ]) {
    const editor = importedRequest({url})
    assert.equal(editor.url, raw)
    assert.deepEqual(editor.params.filter((row) => row.enabled), expected.params)
    if (url.query) assert.deepEqual(editor.params.at(-1), {enabled: false, key: 'off key', value: 'off value'})
    const sent = buildRequest({...editor, authorization: {type: 'none'}}).url
    assert.equal(sent.href, buildRequest({...expected, authorization: {type: 'none'}}).url.href)
    assert.equal(sent.searchParams.get('search term'), 'hello world')
    assert.equal(sent.searchParams.get('reserved'), 'a&b=c#d')
    assert.equal(sent.searchParams.get('percent'), '%20')
    assert.equal(sent.searchParams.get('template'), '{{term}}')
    assert.equal(sent.searchParams.has('off key'), false)
  }
})

test('preserves every path array segment when reconstructing object URLs', () => {
  for (const [path, expectedPath] of [
    [['', 'v1', 'widgets'], '//v1/widgets'],
    [['', '', 'v1', '', 'widgets', ''], '///v1//widgets/'],
    [[''], '/'],
    [['', ''], '//'],
    [[], '/'],
    [['v1', '{{resource}}', ''], '/v1/{{resource}}/']
  ]) {
    const editor = importedRequest({url: {protocol: 'https', host: 'example.com', path}})
    assert.equal(editor.url, `https://example.com${expectedPath}`)
    if (!expectedPath.includes('{{')) {
      assert.equal(buildRequest({...editor, authorization: {type: 'none'}}).url.pathname, expectedPath)
    }
  }
})

test('imports JSON and text raw bodies without replacing variable text', () => {
  for (const [language, bodyType] of [['json', 'json'], ['text', 'text'], ['xml', 'text'], [undefined, 'text']]) {
    const editor = importedRequest({url: '{{url}}', method: 'POST', body: {mode: 'raw', raw: '{"name":"{{name}}"}', options: {raw: {language}}}})
    assert.equal(editor.body, '{"name":"{{name}}"}')
    assert.equal(editor.bodyType, bodyType)
  }
})

test('drops each unsupported body mode with an empty body and one warning naming all affected requests', () => {
  for (const mode of ['urlencoded', 'formdata', 'file', 'graphql']) {
    const {collection, warnings} = importPostmanCollection(file(['First', 'Second'].map((name) => ({
      name, request: {url: 'https://example.com', body: {mode, [mode]: ['dropped']}}
    }))))
    assert.ok(collection.requests.every(({editor}) => editor.body === ''))
    assert.equal(warnings.length, 1)
    for (const word of [mode, 'First', 'Second']) assert.ok(warnings[0].includes(word))
  }
})

test('imports v2.1 and v2.0 into the same named collection with metadata and ordered nested items', () => {
  const items = [
    {name: 'First', request: {method: 'POST', url: '{{baseUrl}}/first'}},
    {name: 'Folder', item: [{name: 'Nested', item: [{name: 'Last', request: {url: 'https://example.com'}}]}]},
    {name: 'After folder', request: {url: 'https://example.com/after'}}
  ]
  const variable = [{key: 'baseUrl', value: 'https://example.com', type: 'string', disabled: true, extra: {kept: true}}]
  const result = importPostmanCollection(file(items, {variable}))
  assert.deepEqual(result, importPostmanCollection(file(items, {variable}, '2.0.0')))
  assert.equal(result.collection.name, 'Example API')
  assert.equal(result.collection.postmanId, 'postman-id')
  assert.deepEqual(result.collection.env, {baseNames: ['baseUrl'], forks: []})
  assert.equal(result.collection.variables, undefined)
  assert.deepEqual(result.collection.requests.map((item) => item.name ?? item.editor.name), ['First', 'Folder', 'After folder'])
  assert.equal(result.collection.requests[1].requests[0].requests[0].editor.name, 'Last')
  assert.equal(result.collection.requests[0].editor.url, '{{baseUrl}}/first')
  assert.deepEqual(result.warnings, [])
})

/** Use the credential shape specified by each Postman schema version. */
function auth(type, values = {}, version = '2.1.0') {
  return {type, [type]: version === '2.0.0' ? values : Object.entries(values).map(([key, value]) => ({key, value, type: 'string'}))}
}

for (const [type, values, expectedType, expectedValues] of [
  ['bearer', {token: '{{token}}'}, 'bearer', {'bearer-token': '{{token}}'}],
  ['basic', {username: '{{user}}', password: '{{password}}'}, 'basic', {'basic-username': '{{user}}', 'basic-password': '{{password}}'}],
  ['apikey', {key: 'X-Key', value: '{{key}}', in: 'header'}, 'api-key', {'api-key-name': 'X-Key', 'api-key-value': '{{key}}', 'api-key-location': 'header'}],
  ['apikey', {key: 'key', value: '{{key}}', in: 'query'}, 'api-key', {'api-key-name': 'key', 'api-key-value': '{{key}}', 'api-key-location': 'query'}],
  ['noauth', {}, 'none', {}]
]) {
  test(`maps ${type} ${values.in ?? ''} auth in both schema versions`, () => {
    const results = ['2.1.0', '2.0.0'].map((version) => importPostmanCollection(file([
      {name: 'Authorized', request: {url: '{{url}}', auth: auth(type, values, version)}}
    ], {}, version)))
    assert.deepEqual(results[0], results[1])
    const editor = results[0].collection.requests[0].editor
    assert.equal(editor.authType, expectedType)
    for (const [field, value] of Object.entries(expectedValues)) assert.equal(editor.authValues[field], value)
    assert.deepEqual(results[0].warnings, [])
  })
}

test('copies nearest folder or collection auth, with explicit noauth overriding inheritance', () => {
  const {collection, warnings} = importPostmanCollection(file([
    {name: 'Collection auth', request: {url: '{{url}}'}},
    {name: 'Folder', auth: auth('basic', {username: 'folder-user', password: 'folder-password'}), item: [
      {name: 'Nested', item: [{name: 'Folder auth', request: {url: '{{url}}', auth: null}}]},
      {name: 'Override', request: {url: '{{url}}', auth: auth('noauth')}}
    ]}
  ], {auth: auth('bearer', {token: 'collection-token'})}))
  assert.equal(collection.requests[0].editor.authValues['bearer-token'], 'collection-token')
  const folder = collection.requests[1]
  assert.equal(folder.requests[0].requests[0].editor.authValues['basic-username'], 'folder-user')
  assert.equal(folder.requests[1].editor.authType, 'none')
  assert.deepEqual(warnings, [])
})

test('maps supported methods and warns once per unsupported method or auth type with affected names', () => {
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
    assert.equal(importedRequest({url: 'https://example.com', method}).method, method)
  }
  const {collection, warnings} = importPostmanCollection(file(['First', 'Second'].map((name) => ({
    name, request: {url: '{{url}}', method: 'PROPFIND', auth: {type: 'oauth2'}}
  }))))
  assert.ok(collection.requests.every(({editor}) => editor.method === 'GET' && editor.authType === 'none'))
  assert.equal(warnings.length, 2)
  for (const word of ['PROPFIND', 'oauth2']) assert.ok(warnings.some((warning) => warning.includes(word)))
  for (const warning of warnings) for (const name of ['First', 'Second']) assert.ok(warning.includes(name))
})

test('drops scripts, descriptions, examples, and protocol settings with one warning per kind and affected paths', () => {
  const {collection, warnings} = importPostmanCollection(file([
    {name: 'Folder', description: 'folder notes', event: [{script: {exec: ['folder script']}}], item: [
      {name: 'First', description: 'item notes', event: [{script: {exec: ['script']}}], response: [{name: 'Example'}],
        protocolProfileBehavior: {disableBodyPruning: true}, request: {url: '{{url}}', description: 'request notes', header: [{key: 'X', value: '1', description: 'header notes'}]}}
    ]},
    {name: 'Second', response: [{name: 'Other example'}], request: {url: '{{url}}'}}
  ], {event: [{script: {exec: ['collection script']}}], protocolProfileBehavior: {followRedirects: false}}))
  assert.equal(warnings.length, 4)
  for (const kind of ['Scripts and events', 'Descriptions', 'Saved example responses', 'Protocol profile settings']) {
    assert.ok(warnings.some((warning) => warning.includes(kind)))
  }
  const examples = warnings.find((warning) => warning.includes('Saved example responses'))
  assert.ok(examples.includes('Folder / First') && examples.includes('Second'))
  assert.ok(warnings.find((warning) => warning.includes('Scripts and events')).includes('Example API'))
  assert.ok(warnings.find((warning) => warning.includes('Descriptions')).includes('Folder'))
  assert.equal(collection.requests[0].description, undefined)
  assert.equal(collection.requests[0].requests[0].response, undefined)
})

test('rejects invalid JSON, v1, unsupported schema versions, non-collections, and malformed item trees clearly', () => {
  assert.throws(() => importPostmanCollection('{no'), /not valid JSON/)
  for (const value of [null, [], {}, {name: 'v1', requests: []}, {info: {schema: 'https://example.com/v2.1.0/collection.json'}, item: []}]) {
    assert.throws(() => importPostmanCollection(JSON.stringify(value)), /Postman Collection v2\.0 or v2\.1/)
  }
  assert.throws(() => importPostmanCollection(file([], {}, '3.0.0')), /Unsupported file/)
  assert.throws(() => importPostmanCollection(file([], {item: 'not a list'})), /not a Postman collection/)
  for (const item of [null, {name: 'Broken'}, {name: 'Broken', item: {}}, {name: 'Broken', request: 5}]) {
    assert.throws(() => importPostmanCollection(file([item])), /Postman.*(?:item|request)/)
  }
})

test('imports headers stored as Postman header text, preserving colons and variables in values', () => {
  const editor = importedRequest({url: '{{url}}', header: 'X-Token: {{token}}\r\nX-Link: https://example.com:8080\r\n'})
  assert.deepEqual(editor.headers, [
    {enabled: true, key: 'X-Token', value: '{{token}}'},
    {enabled: true, key: 'X-Link', value: 'https://example.com:8080'}
  ])
})
