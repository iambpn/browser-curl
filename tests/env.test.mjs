/** Public env operations and resolution, independent of extension APIs. */
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {addBaseName, createEnv, createFork, removeBaseName, setForkValue, pickerOptions, resolveEditor} from '../src/env/env.ts'
import {editorFixture} from './helpers/extension-storage.mjs'

test('adding a base name gives every fork an empty value', () => {
  const env = createEnv()
  createFork(env, 'one', 'local')
  createFork(env, 'two', 'staging')
  addBaseName(env, ' token ')
  assert.deepEqual(env.baseNames, ['token'])
  assert.deepEqual(env.forks.map(({variables}) => variables), [
    [{name: 'token', value: ''}], [{name: 'token', value: ''}]
  ])
})

test('new forks copy base names and removing a base name keeps fork values', () => {
  const env = createEnv()
  addBaseName(env, 'token')
  createFork(env, 'one', 'local')
  setForkValue(env, 'one', 'token', 'kept')
  removeBaseName(env, 'token')
  assert.deepEqual(env.baseNames, [])
  assert.deepEqual(env.forks[0].variables, [{name: 'token', value: 'kept'}])
  addBaseName(env, 'token')
  assert.equal(env.forks[0].variables[0].value, 'kept')
})

test('variable and fork names are trimmed, unique and case-sensitive, and invalid edits change nothing', () => {
  const env = createEnv()
  for (const invalid of ['', '  ', 'a{b', 'a}b']) assert.throws(() => addBaseName(env, invalid))
  addBaseName(env, ' token ')
  assert.throws(() => addBaseName(env, 'token '))
  addBaseName(env, 'Token')
  for (const invalid of ['', '  ']) assert.throws(() => createFork(env, 'invalid', invalid))
  createFork(env, 'one', ' local ')
  assert.throws(() => createFork(env, 'duplicate', 'local '))
  createFork(env, 'two', 'Local')
  assert.deepEqual(env.baseNames, ['token', 'Token'])
  assert.deepEqual(env.forks.map(({name}) => name), ['local', 'Local'])
})

test('picker starts with No env and lists unique fork names sorted across the supplied levels', () => {
  const outer = createEnv()
  const inner = createEnv()
  createFork(outer, 'one', 'staging')
  createFork(outer, 'two', 'local')
  createFork(inner, 'three', 'local')
  assert.deepEqual(pickerOptions([inner, undefined, outer]), [
    {name: null, label: 'No env'}, {name: 'local', label: 'local'}, {name: 'staging', label: 'staging'}
  ])
  assert.deepEqual(pickerOptions([]), [{name: null, label: 'No env'}])
})

function valuesEnv(values, name = 'local') {
  return {baseNames: [], forks: [{id: name, name, variables: Object.entries(values).map(([name, value]) => ({name, value}))}]}
}

test('raw URL query mirrors do not resolve disabled rows or change missing-name order', () => {
  const editor = {...editorFixture(), url: 'https://example.com/echo?skip={{missing}}&value={{second}}',
    params: [{enabled: false, key: 'skip', value: '{{missing}}'}, {enabled: true, key: '{{first}}', value: '{{second}}'}],
    authType: 'none'}
  assert.deepEqual(resolveEditor([], null, editor), {missing: ['first', 'second']})
  editor.params[1].enabled = false
  const result = resolveEditor([], null, editor)
  assert.ok(result.editor)
  assert.deepEqual(result.editor.params, editor.params)
  assert.equal(result.editor.url, 'https://example.com/echo')
})

test('query strings introduced by URL values become params without resolving inserted references again', () => {
  const editor = {...editorFixture(), url: '{{fullUrl}}', params: [], authType: 'none'}
  const result = resolveEditor([valuesEnv({fullUrl: 'https://example.com/echo?foo=bar&foo=a%26b&literal={{other}}'})], 'local', editor)
  assert.deepEqual(result.editor.params, [
    {enabled: true, key: 'foo', value: 'bar'},
    {enabled: true, key: 'foo', value: 'a&b'},
    {enabled: true, key: 'literal', value: '{{other}}'}
  ])
  assert.deepEqual(editor.params, [])
})

test('resolves URL, enabled parameter and header keys and values, and body without changing editor values', () => {
  const editor = {...editorFixture(), url: '{{ baseUrl }}/{{id}}',
    params: [{enabled: true, key: '{{key}}', value: '{{id}}'}, {enabled: false, key: '{{missing}}', value: '{{missing}}'}],
    headers: [{enabled: true, key: '{{key}}', value: '{{id}}'}, {enabled: false, key: '{{missing}}', value: '{{missing}}'}],
    body: '{"id":"{{id}}"}', authType: 'none'}
  const original = structuredClone(editor)
  const result = resolveEditor([valuesEnv({baseUrl: 'https://example.com', id: '42', key: 'X-Key'})], 'local', editor)
  assert.equal(result.editor.url, 'https://example.com/42')
  for (const group of ['params', 'headers']) assert.deepEqual(result.editor[group], [
    {enabled: true, key: 'X-Key', value: '42'}, editor[group][1]
  ])
  assert.equal(result.editor.body, '{"id":"42"}')
  assert.deepEqual(editor, original)
})

for (const [authType, fields] of Object.entries({
  bearer: ['bearer-token'], basic: ['basic-username', 'basic-password'],
  'api-key': ['api-key-name', 'api-key-value', 'api-key-location'], custom: ['custom-authorization'], none: []
})) {
  test(`resolves every selected ${authType} authorization value and skips inactive types`, () => {
    const authValues = Object.fromEntries([
      'bearer-token', 'basic-username', 'basic-password', 'api-key-name', 'api-key-value', 'api-key-location', 'custom-authorization'
    ].map((field) => [field, fields.includes(field) ? '{{value}}' : '{{missing}}']))
    const result = resolveEditor([valuesEnv({value: 'resolved'})], 'local', {...editorFixture(), authType, authValues})
    assert.deepEqual(result.editor.authValues, Object.fromEntries(Object.entries(authValues).map(([field, value]) => [
      field, fields.includes(field) ? 'resolved' : value
    ])))
  })
}

test('replacement is one pass, trims names, and recognizes only references without braces inside', () => {
  const editor = {...editorFixture(), url: 'https://example.com/{{ name }}/{{name}}/{{{name}}}', authType: 'none'}
  assert.equal(resolveEditor([valuesEnv({name: '{{other}}'})], 'local', editor).editor.url,
    'https://example.com/{{other}}/{{other}}/{{{other}}}')
})

test('missing names are unique in first-use order, including empty values and No env', () => {
  const editor = {...editorFixture(), url: '{{z}}/{{ a }}/{{z}}',
    params: [{enabled: true, key: '{{p}}', value: '{{a}}'}], headers: [{enabled: true, key: '{{h}}', value: '{{v}}'}],
    body: '{{b}}', authType: 'basic', authValues: {'basic-username': '{{u}}', 'basic-password': '{{pw}}'}}
  assert.deepEqual(resolveEditor([valuesEnv({z: '', a: 'present'})], 'local', editor), {missing: ['z', 'p', 'h', 'v', 'b', 'u', 'pw']})
  assert.deepEqual(resolveEditor([valuesEnv({z: 'present'})], null, editor), {missing: ['z', 'a', 'p', 'h', 'v', 'b', 'u', 'pw']})
})

test('a request without references is unchanged with No env', () => {
  const editor = editorFixture()
  assert.deepEqual(resolveEditor([], null, editor), {editor})
})

test('resolution walks inner to outer, skipping absent forks and empty values', () => {
  const editor = {...editorFixture(), url: '{{a}}/{{b}}/{{c}}', authType: 'none'}
  assert.equal(resolveEditor([
    valuesEnv({a: 'request', b: ''}), valuesEnv({b: 'ignored'}, 'other'),
    valuesEnv({a: 'folder', b: 'folder'}), valuesEnv({b: 'outer', c: 'collection'})
  ], 'local', editor).editor.url, 'request/folder/collection')
})
