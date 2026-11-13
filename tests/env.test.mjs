/** Public env operations and resolution, independent of extension APIs. */
import assert from 'node:assert/strict'
import {test} from 'node:test'
import * as edits from '../src/env/env.ts'
import {addBaseName, createEnv, createFork, removeBaseName, setForkValue, pickerOptions, resolveEditor, collectionEnvs, requestEnvChain} from '../src/env/env.ts'
import {editorFixture} from './helpers/extension-storage.mjs'

test('renaming a base name keeps each old value and adds the trimmed new name empty', () => {
  const env = createEnv()
  addBaseName(env, 'old')
  createFork(env, 'one', 'local')
  createFork(env, 'two', 'staging')
  setForkValue(env, 'one', 'old', 'kept')
  edits.renameBaseName(env, 'old', ' new ')
  assert.deepEqual(env.baseNames, ['new'])
  assert.deepEqual(env.forks.map(({variables}) => variables), [
    [{name: 'old', value: 'kept'}, {name: 'new', value: ''}],
    [{name: 'old', value: ''}, {name: 'new', value: ''}]
  ])
})

test('base rename rejects invalid and duplicate names without changing anything; same name is a no-op', () => {
  const env = createEnv()
  addBaseName(env, 'old')
  addBaseName(env, 'taken')
  createFork(env, 'one', 'local')
  const before = structuredClone(env)
  for (const invalid of ['', '  ', '{new', 'new}', ' taken ']) {
    assert.throws(() => edits.renameBaseName(env, 'old', invalid))
    assert.deepEqual(env, before)
  }
  assert.throws(() => edits.renameBaseName(env, 'absent', 'new'))
  edits.renameBaseName(env, 'old', ' old ')
  assert.deepEqual(env, before)
})

test('fork variables list base order and computed marks before fork-only insertion order', () => {
  const env = createEnv()
  createFork(env, 'one', 'local')
  edits.addForkVariable(env, 'one', ' extra ')
  setForkValue(env, 'one', 'extra', 'kept')
  addBaseName(env, 'second')
  addBaseName(env, 'extra')
  edits.addForkVariable(env, 'one', 'tail')
  assert.deepEqual(edits.forkVariables(env, 'one'), [
    {name: 'second', value: '', fromBase: true},
    {name: 'extra', value: 'kept', fromBase: true},
    {name: 'tail', value: '', fromBase: false}
  ])
  assert.throws(() => edits.deleteForkVariable(env, 'one', 'extra'), /base/)
  removeBaseName(env, 'extra')
  assert.deepEqual(edits.forkVariables(env, 'one'), [
    {name: 'second', value: '', fromBase: true},
    {name: 'extra', value: 'kept', fromBase: false},
    {name: 'tail', value: '', fromBase: false}
  ])
  edits.deleteForkVariable(env, 'one', 'extra')
  assert.deepEqual(env.forks[0].variables, [{name: 'second', value: ''}, {name: 'tail', value: ''}])
})

test('fork-only names follow variable name rules and renaming a base can adopt an existing fork-only value', () => {
  const env = createEnv()
  addBaseName(env, 'old')
  createFork(env, 'one', 'local')
  edits.addForkVariable(env, 'one', ' new ')
  setForkValue(env, 'one', 'new', 'retained')
  const before = structuredClone(env)
  for (const invalid of ['', '  ', '{bad', 'bad}', ' new ', 'old']) {
    assert.throws(() => edits.addForkVariable(env, 'one', invalid))
    assert.deepEqual(env, before)
  }
  edits.addForkVariable(env, 'one', 'New')
  edits.renameBaseName(env, 'old', 'new')
  assert.deepEqual(edits.forkVariables(env, 'one'), [
    {name: 'new', value: 'retained', fromBase: true},
    {name: 'old', value: '', fromBase: false},
    {name: 'New', value: '', fromBase: false}
  ])
  assert.throws(() => edits.addForkVariable(env, 'absent', 'name'))
  assert.throws(() => edits.deleteForkVariable(env, 'one', 'absent'))
})

test('fork rename trims names, preserves IDs, order and values, and rejects empty and duplicate names', () => {
  const env = createEnv()
  addBaseName(env, 'token')
  createFork(env, 'one', 'local')
  createFork(env, 'two', 'staging')
  setForkValue(env, 'one', 'token', 'kept')
  const before = structuredClone(env)
  for (const invalid of ['', '  ', ' staging ']) {
    assert.throws(() => edits.renameFork(env, 'one', invalid))
    assert.deepEqual(env, before)
  }
  assert.throws(() => edits.renameFork(env, 'absent', 'new'))
  edits.renameFork(env, 'one', ' local ')
  assert.deepEqual(env, before)
  edits.renameFork(env, 'one', ' Staging ')
  assert.deepEqual(env.forks, [{...before.forks[0], name: 'Staging'}, before.forks[1]])
})

test('fork deletion needs confirmation for any nonempty value, including fork-only values and whitespace', () => {
  const env = createEnv()
  addBaseName(env, 'token')
  createFork(env, 'empty', 'empty')
  createFork(env, 'valued', 'valued')
  edits.addForkVariable(env, 'valued', 'extra')
  setForkValue(env, 'valued', 'extra', ' ')
  const before = structuredClone(env)
  assert.equal(edits.deleteFork(env, 'valued'), false)
  assert.deepEqual(env, before)
  assert.equal(edits.deleteFork(env, 'empty'), true)
  assert.equal(edits.deleteFork(env, 'valued', true), true)
  assert.deepEqual(env.forks, [])
})

for (const action of ['rename', 'delete']) {
  test(`chosen env resets only when the last fork with that name is ${action === 'rename' ? 'renamed' : 'deleted'}`, () => {
    const tree = {id: 'collection', env: createEnv(), chosenEnv: 'local', requests: [
      {id: 'folder', env: createEnv(), requests: [{id: 'request', env: createEnv()}]}
    ]}
    const folder = tree.requests[0].env
    const request = tree.requests[0].requests[0].env
    createFork(folder, 'folder-fork', 'local')
    createFork(request, 'request-fork', 'local')
    const change = (env, id) => action === 'rename' ? edits.renameFork(env, id, 'staging') : edits.deleteFork(env, id)
    change(folder, 'folder-fork')
    edits.resetMissingChosenEnv(tree)
    assert.equal(tree.chosenEnv, 'local')
    change(request, 'request-fork')
    edits.resetMissingChosenEnv(tree)
    assert.equal(tree.chosenEnv, null)
  })
}

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

test('missing names follow URL address, enabled query rows, fragment, then headers in first-use order', () => {
  const editor = {...editorFixture(), url: 'https://example.com/{{path}}?q={{first}}&skip={{disabled}}#{{second}}/{{first}}',
    params: [{enabled: true, key: 'q', value: '{{first}}'}, {enabled: false, key: 'skip', value: '{{disabled}}'}],
    headers: [{enabled: true, key: '{{header}}', value: '{{second}}'}], authType: 'none'}
  assert.deepEqual(resolveEditor([], null, editor), {missing: ['path', 'first', 'second', 'header']})
  assert.deepEqual(resolveEditor([valuesEnv({path: 'echo', first: '', second: ''})], 'local', editor),
    {missing: ['first', 'second', 'header']})
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

function envTree() {
  return {id: 'collection', env: valuesEnv({value: 'collection', outer: 'collection'}), requests: [
    {id: 'outside', env: valuesEnv({outside: 'outside'}, 'zebra')},
    {id: 'outer', env: valuesEnv({value: 'outer', outer: 'outer'}), requests: [
      {id: 'inner', env: valuesEnv({value: 'inner'}), requests: [
        {id: 'request', env: valuesEnv({value: 'request'})},
        {id: 'empty', env: valuesEnv({value: ''})},
        {id: 'other', env: valuesEnv({value: 'ignored'}, 'folder-only')},
        {id: 'legacy'}
      ]}
    ]}
  ]}
}

function resolveTree(tree, requestId) {
  return resolveEditor(requestEnvChain(tree, requestId), 'local',
    {...editorFixture(), url: '{{value}}/{{outer}}', authType: 'none'}).editor.url
}

test('request env overrides its folder while missing names continue through the ancestors', () => {
  assert.equal(resolveTree(envTree(), 'request'), 'request/outer')
})

test('inner folder overrides the outer folder and collection, including legacy requests with no env', () => {
  assert.equal(resolveTree(envTree(), 'legacy'), 'inner/outer')
})

test('request levels without the chosen fork are skipped', () => {
  assert.equal(resolveTree(envTree(), 'other'), 'inner/outer')
})

test('empty request and inner folder values fall through to the nearest nonempty ancestor', () => {
  const tree = envTree()
  tree.requests[1].requests[0].env.forks[0].variables[0].value = ''
  assert.equal(resolveTree(tree, 'empty'), 'outer/outer')
})

test('picker includes unique sorted fork names from the entire tree, including other request branches', () => {
  const tree = envTree()
  assert.deepEqual(pickerOptions(collectionEnvs(tree)).map(({name}) => name), [null, 'folder-only', 'local', 'zebra'])
  assert.equal(requestEnvChain(tree, 'deleted'), undefined)
  assert.equal(requestEnvChain(tree, 'inner'), undefined, 'folders are not linked requests')
})
