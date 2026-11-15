/** Autocomplete names follow request resolution without returning secrets or changing collection data. */
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {requestEnvSuggestions, variableReferenceAt} from '../src/env/suggestions.ts'
import {destinationEnvChain} from '../src/env/env.ts'
import {suggestionsCollection} from './helpers/env-suggestions.mjs'

/** Check selected-fork overrides, empty fallback, source paths, and unrelated branch isolation. */
function selectedForkSuggestions() {
  const collection = suggestionsCollection()
  const before = structuredClone(collection)
  const suggestions = requestEnvSuggestions(collection, 'get-item')
  assert.deepEqual(suggestions, [
    {name: 'apiOnly', source: 'api', sourceName: 'Shop / Outer / Items / Get item', method: 'POST'},
    {name: 'baseUrl', source: 'collection', sourceName: 'Shop'},
    {name: 'folderOnly', source: 'folder', sourceName: 'Shop / Outer / Items'},
    {name: 'localOnly', source: 'collection', sourceName: 'Shop'},
    {name: 'outerOnly', source: 'folder', sourceName: 'Shop / Outer'},
    {name: 'shared', source: 'folder', sourceName: 'Shop / Outer / Items'},
    {name: 'token', source: 'api', sourceName: 'Shop / Outer / Items / Get item', method: 'POST'},
    {name: 'unfilled', source: 'collection', sourceName: 'Shop'}
  ])
  assert.deepEqual(collection, before)
  assert.doesNotMatch(JSON.stringify(suggestions), /secret|api-value|folder-value/)
  assert.deepEqual(requestEnvSuggestions(collection, 'deleted'), [])
}
test('suggestions show the effective source once per name and omit secrets and sibling names', selectedForkSuggestions)

/** Check Base-only names without a selected env and fork-only names after changing the selection. */
function changedForkSuggestions() {
  const collection = suggestionsCollection()
  collection.chosenEnv = null
  const base = requestEnvSuggestions(collection, 'get-item')
  const names = []
  let sharedSource
  for (const suggestion of base) {
    names.push(suggestion.name)
    if (suggestion.name === 'shared') sharedSource = suggestion.source
  }
  assert.deepEqual(names, ['baseUrl', 'folderOnly', 'outerOnly', 'shared', 'token', 'unfilled'])
  assert.equal(sharedSource, 'api')
  collection.chosenEnv = 'production'
  const production = requestEnvSuggestions(collection, 'get-item')
  const productionNames = new Set()
  for (const suggestion of production) productionNames.add(suggestion.name)
  assert.ok(productionNames.has('prodOnly'))
  assert.ok(!productionNames.has('localOnly'))
}
test('suggestions follow No env and changes to the selected fork', changedForkSuggestions)

/** Unsaved requests use only their chosen collection or folder and do not borrow saved API overrides. */
function destinationSuggestions() {
  const collection = suggestionsCollection()
  const outer = collection.requests[0]
  const inner = outer.requests[0]
  assert.deepEqual(destinationEnvChain(collection), [collection.env])
  assert.deepEqual(destinationEnvChain(collection, inner.id), [inner.env, outer.env, collection.env])
  assert.equal(destinationEnvChain(collection, 'get-item'), undefined)
  assert.equal(destinationEnvChain(collection, 'deleted'), undefined)
  const root = requestEnvSuggestions(collection, collection.id)
  assert.equal(root.length, 5)
  for (const suggestion of root) assert.equal(suggestion.source, 'collection')
  const folder = requestEnvSuggestions(collection, 'items')
  const folderNames = new Set()
  for (const suggestion of folder) {
    folderNames.add(suggestion.name)
    assert.notEqual(suggestion.source, 'api')
  }
  assert.ok(folderNames.has('folderOnly'))
  assert.ok(folderNames.has('outerOnly'))
  assert.ok(!folderNames.has('apiOnly'))
  assert.ok(!folderNames.has('siblingOnly'))
}
test('unsaved destinations suggest inherited names without API or sibling variables', destinationSuggestions)

/** Check incomplete references, edits inside closed references, selection ranges, and literal braces. */
function referenceRanges() {
  assert.deepEqual(variableReferenceAt('prefix {{', 9), {start: 7, end: 9, query: ''})
  assert.deepEqual(variableReferenceAt('x {{ ba}} suffix', 7), {start: 2, end: 9, query: 'ba'})
  assert.deepEqual(variableReferenceAt('{{one}}/{{tw', 12), {start: 8, end: 12, query: 'tw'})
  assert.deepEqual(variableReferenceAt('{"id": "{{to"}', 12), {start: 8, end: 12, query: 'to'})
  for (const text of ['', '{', 'plain', '{{closed}}', '{{line\nbreak', '{{a{b']) {
    assert.equal(variableReferenceAt(text, text.length), undefined)
  }
  assert.equal(variableReferenceAt('{{name}}', 2, 4), undefined)
  assert.equal(variableReferenceAt('{{name}}', 1), undefined)
}
test('reference ranges preserve surrounding text and reject closed or selected text', referenceRanges)
