/** Unit tests for local drafts, full history snapshots, the history index and limit, failed writes, and deletion races. */
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {
  HISTORY_INDEX_KEY, HISTORY_KEY_PREFIX, HISTORY_LIMIT, createSavedRequest, deleteSavedRequest, finishSavedRequest,
  listHistorySummaries, loadSavedRequest, loadWorkspace, recoverInterruptedRequests, saveWorkspace
} from '../src/shared/request-store.ts'
import {resolveRequestName} from '../src/shared/request-state.ts'
import {editorFixture, savedFixture, storageFixture} from './helpers/extension-storage.mjs'

/** Start each test with independent simulated persistent storage. */
function storage() {
  const fixture = storageFixture()
  globalThis.chrome = fixture.chrome
  return fixture
}

/** Use hostnames only when a user did not enter a name. */
function automaticNames() {
  assert.equal(resolveRequestName('', 'https://api.example.test:8443/items?q=1'), 'api.example.test')
  assert.equal(resolveRequestName('  My request  ', 'https://other.example.test'), 'My request')
  assert.equal(resolveRequestName('', 'unfinished'), 'Untitled request')
  assert.equal(resolveRequestName('', 'https://new.example.test'), 'new.example.test')
}
test('resolves custom and automatic request names', automaticNames)

/** Preserve all typed values across a fresh read, without adding an unsent draft to history. */
async function draftRoundTrip() {
  storage()
  const workspace = {draft: {editor: editorFixture()}, preview: {editor: editorFixture(), responseId: 'saved-1'}}
  await saveWorkspace(workspace)
  assert.deepEqual(await loadWorkspace(), workspace)
  assert.deepEqual(await listHistorySummaries(), [])
  workspace.draft.editor.body = 'changed only in memory'
  assert.notEqual((await loadWorkspace()).draft.editor.body, workspace.draft.editor.body)
}
test('restores complete drafts and history previews without creating sent history', draftRoundTrip)

/** Retain full request payloads, inactive editor values, response headers, metadata, and text. */
async function responseRoundTrip() {
  storage()
  const saved = savedFixture()
  await createSavedRequest(saved)
  const result = {type: 'response', response: {
    status: 201, statusText: 'Created', url: 'https://api.example.test/items/1',
    headers: [['content-type', 'application/json'], ['x-test', 'value']],
    body: '{"id":1}', size: 8, durationMs: 42, skippedHeaders: ['host']
  }}
  await finishSavedRequest(saved.id, result)
  assert.deepEqual(await loadSavedRequest(saved.id), {...saved, result})
  const second = {...savedFixture('request-2'), sentAt: 200}
  await createSavedRequest(second)
  const listed = await listHistorySummaries()
  assert.deepEqual(listed, [
    {id: 'request-2', name: 'api.example.test', method: 'POST', url: saved.request.url, sentAt: 200, state: 'running'},
    {id: 'request-1', name: 'api.example.test', method: 'POST', url: saved.request.url, sentAt: 100, state: 'response', httpStatus: 201}
  ])
}
test('keeps separate send attempts and complete response data', responseRoundTrip)

/** Test both completion/deletion orderings so a response cannot restore a deleted request. */
async function deletionRaces() {
  storage()
  await createSavedRequest(savedFixture())
  const result = {type: 'error', message: 'Request canceled.'}
  await Promise.all([finishSavedRequest('request-1', result), deleteSavedRequest('request-1')])
  assert.equal(await loadSavedRequest('request-1'), undefined)
  await createSavedRequest(savedFixture())
  await Promise.all([deleteSavedRequest('request-1'), finishSavedRequest('request-1', result)])
  assert.equal(await loadSavedRequest('request-1'), undefined)
  assert.deepEqual(await listHistorySummaries(), [])
}
test('deletes full records without late-response resurrection', deletionRaces)

/** Keep failed operations visible to callers and let later operations proceed without data loss. */
async function storageErrors() {
  const fixture = storage()
  fixture.failNextWrite = true
  await assert.rejects(createSavedRequest(savedFixture()), /Storage full/)
  await createSavedRequest(savedFixture())
  fixture.failNextRemove = true
  await assert.rejects(deleteSavedRequest('request-1'), /Storage unavailable/)
  assert.ok(await loadSavedRequest('request-1'))
  assert.equal((await listHistorySummaries()).length, 1)
  fixture.failNextRead = true
  await assert.rejects(loadWorkspace(), /Storage unavailable/)
  await deleteSavedRequest('request-1')
  assert.deepEqual(await listHistorySummaries(), [])
}
test('reports storage failures and recovers the mutation queue', storageErrors)

/** Mark old unfinished requests as interrupted while preserving completed responses and drafts. */
async function interruptedRequests() {
  storage()
  const workspace = {draft: {editor: editorFixture()}}
  await saveWorkspace(workspace)
  await createSavedRequest(savedFixture())
  await createSavedRequest(savedFixture('finished'))
  const result = {type: 'error', message: 'Server unavailable'}
  await finishSavedRequest('finished', result)
  await recoverInterruptedRequests()
  assert.equal((await loadSavedRequest('request-1')).result.type, 'error')
  assert.deepEqual((await loadSavedRequest('finished')).result, result)
  assert.deepEqual(await loadWorkspace(), workspace)
  const states = []
  for (const summary of await listHistorySummaries()) states.push(summary.state)
  assert.deepEqual(states, ['error', 'error'])
}
test('recovers interrupted attempts without losing completed results or drafts', interruptedRequests)

/** Keep only the newest requests, and delete the entries that no longer fit. */
async function historyLimit() {
  const fixture = storage()
  for (let index = 0; index <= HISTORY_LIMIT; index += 1) {
    await createSavedRequest({...savedFixture(`request-${index}`), sentAt: index})
  }
  const listed = await listHistorySummaries()
  assert.equal(listed.length, HISTORY_LIMIT)
  assert.equal(listed[0].id, `request-${HISTORY_LIMIT}`)
  assert.equal(listed.at(-1).id, 'request-1')
  assert.equal(await loadSavedRequest('request-0'), undefined)
  let entryCount = 0
  for (const key of fixture.values.keys()) if (key.startsWith(HISTORY_KEY_PREFIX)) entryCount += 1
  assert.equal(entryCount, HISTORY_LIMIT)
}
test('keeps the newest 100 requests and deletes older entries', historyLimit)

/** Remove entries without an index, such as the earlier storage format, and keep the draft. */
async function unindexedEntries() {
  const fixture = storage()
  const workspace = {draft: {editor: editorFixture()}}
  fixture.values.set('browsercurl.workspace', workspace)
  fixture.values.set(`${HISTORY_KEY_PREFIX}old-format`, savedFixture('old-format'))
  await recoverInterruptedRequests()
  assert.equal(fixture.values.has(`${HISTORY_KEY_PREFIX}old-format`), false)
  assert.deepEqual(fixture.values.get(HISTORY_INDEX_KEY), [])
  assert.deepEqual(await loadWorkspace(), workspace)
}
test('removes history entries that have no index at startup', unindexedEntries)
