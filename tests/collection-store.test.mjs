/** Imported envs and migration use the same public persistence paths as the real panel. */
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {COLLECTION_INDEX_KEY, COLLECTION_KEY_PREFIX, exportCollection, loadCollection, saveImportedCollection, editCollectionEnv, deleteCollectionItem} from '../src/collections/collection-store.ts'
import {importPostmanCollection} from '../src/collections/postman-converter.ts'
import {addBaseName, setForkValue} from '../src/env/env.ts'
import {storageFixture} from './helpers/extension-storage.mjs'

function storage() {
  const fixture = storageFixture()
  globalThis.chrome = fixture.chrome
  return fixture
}

test('saving imported collections retains envs at every level, chosen env, and independent local IDs', async () => {
  storage()
  const {collection} = importPostmanCollection(JSON.stringify({
    info: {name: 'Imported API', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'},
    variable: [{key: 'url', value: 'https://example.com'}],
    item: [{name: 'Folder', variable: [{key: 'token', value: 'folder-token'}], item: [
      {name: 'Request', variable: [{key: 'body', value: 'request-body'}], request: {url: '{{url}}/echo'}}
    ]}]
  }))
  const id = await saveImportedCollection(collection)
  collection.env.forks[0].variables[0].value = 'later unsaved edit'
  const saved = await loadCollection(id)
  assert.equal(saved.chosenEnv, 'imported')
  assert.equal(saved.env.forks[0].variables[0].value, 'https://example.com')
  assert.deepEqual(saved.requests[0].env, collection.requests[0].env)
  assert.deepEqual(saved.requests[0].requests[0].env, collection.requests[0].requests[0].env)
  const second = await loadCollection(await saveImportedCollection(collection))
  assert.notEqual(saved.id, second.id)
  assert.notEqual(saved.requests[0].id, second.requests[0].id)
  assert.notEqual(saved.requests[0].requests[0].id, second.requests[0].requests[0].id)
})

for (const valued of [false, true]) {
  test(`first read migrates hidden collection variables ${valued ? 'with an imported fork' : 'without a fork for empty and disabled values'}`, async () => {
    const fixture = storage()
    const key = COLLECTION_KEY_PREFIX + 'legacy'
    const original = {id: 'legacy', name: 'Old import', postmanId: 'old-postman-id', requests: [], variables: [
      {key: ' url ', value: valued ? 'https://example.com' : ''},
      {key: 'disabled', value: 'disabled-secret', disabled: true},
      {key: 'url', value: ''}, {key: 'bad{key', value: 'invalid'}, {key: ' ', value: 'invalid'}
    ]}
    fixture.values.set(key, structuredClone(original))
    const migrated = await loadCollection('legacy')
    assert.deepEqual(migrated.env.baseNames, ['url', 'disabled'])
    assert.equal(migrated.chosenEnv, valued ? 'imported' : null)
    assert.equal(migrated.env.forks.length, valued ? 1 : 0)
    if (valued) {
      assert.equal(migrated.env.forks[0].name, 'imported')
      assert.deepEqual(migrated.env.forks[0].variables, [
        {name: 'url', value: 'https://example.com'}, {name: 'disabled', value: ''}
      ])
      await editCollectionEnv('legacy', env => setForkValue(env, env.forks[0].id, 'url', 'https://edited.example.com'))
    }
    assert.equal('variables' in migrated, false)
    assert.equal('variables' in fixture.values.get(key), false)
    assert.equal(migrated.postmanId, original.postmanId)
    assert.deepEqual(migrated.requests, original.requests)
    const again = await loadCollection('legacy')
    assert.deepEqual(again, fixture.values.get(key))
    if (valued) assert.equal(again.env.forks[0].variables[0].value, 'https://edited.example.com')
    const exported = JSON.parse((await exportCollection('legacy')).json)
    assert.deepEqual(exported.variable, [{key: 'url', value: ''}, {key: 'disabled', value: ''}])
  })
}

test('a failed migration write keeps the hidden list for retry', async () => {
  const fixture = storage()
  const key = COLLECTION_KEY_PREFIX + 'legacy'
  const original = {id: 'legacy', name: 'Old import', requests: [], variables: [{key: 'token', value: 'kept'}]}
  fixture.values.set(key, structuredClone(original))
  fixture.failNextWrite = true
  await assert.rejects(loadCollection('legacy'), /Storage full/)
  assert.deepEqual(fixture.values.get(key), original)
  assert.equal((await loadCollection('legacy')).env.forks[0].variables[0].value, 'kept')
})

test('migration preserves env edits made before hidden variables were migrated', async () => {
  const fixture = storage()
  const env = {baseNames: ['existing'], forks: [{id: 'local', name: 'local', variables: [{name: 'existing', value: 'local-value'}]}]}
  fixture.values.set(COLLECTION_KEY_PREFIX + 'legacy', {
    id: 'legacy', name: 'Old import', requests: [], env, chosenEnv: 'local', variables: [{key: 'token', value: 'imported-token'}]
  })
  const saved = await loadCollection('legacy')
  assert.deepEqual(saved.env.baseNames, ['existing', 'token'])
  assert.deepEqual(saved.env.forks[0], {...env.forks[0], variables: [...env.forks[0].variables, {name: 'token', value: ''}]})
  assert.equal(saved.chosenEnv, 'local')
  assert.equal(saved.env.forks[1].name, 'imported')
  assert.deepEqual(saved.env.forks[1].variables, [{name: 'existing', value: ''}, {name: 'token', value: 'imported-token'}])
})

test('concurrent first reads and env edits retain all changes without resurrecting a deleted collection', async () => {
  const fixture = storage()
  fixture.values.set(COLLECTION_KEY_PREFIX + 'legacy', {
    id: 'legacy', name: 'Old import', requests: [], variables: [{key: 'token', value: 'kept'}]
  })
  await Promise.all([
    loadCollection('legacy'), loadCollection('legacy'),
    editCollectionEnv('legacy', env => addBaseName(env, 'new'))
  ])
  const saved = await loadCollection('legacy')
  assert.deepEqual(saved.env.baseNames, ['token', 'new'])
  assert.deepEqual(saved.env.forks[0].variables, [{name: 'token', value: 'kept'}, {name: 'new', value: ''}])
  await Promise.all([loadCollection('legacy'), deleteCollectionItem('legacy', 'legacy')])
  assert.equal(await loadCollection('legacy'), undefined)
})

test('reading an already migrated collection stays available while a collection write is held', async () => {
  const fixture = storage()
  const collection = {id: 'current', name: 'Current', requests: [], env: {baseNames: [], forks: []}, chosenEnv: null}
  fixture.values.set(COLLECTION_KEY_PREFIX + 'current', collection)
  await navigator.locks.request(COLLECTION_INDEX_KEY, async () => {
    assert.deepEqual(await loadCollection('current'), collection)
  })
})
