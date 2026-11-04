/** Unit tests for local drafts, full history snapshots, failed writes, and deletion races. */
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {
  createSavedRequest, deleteSavedRequest, finishSavedRequest, listSavedRequests,
  loadSavedRequest, loadWorkspace, recoverInterruptedRequests, saveWorkspace
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
  assert.deepEqual(await listSavedRequests(), [])
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
  const listed = await listSavedRequests()
  const ids = []
  for (const item of listed) ids.push(item.id)
  assert.deepEqual(ids, ['request-2', 'request-1'])
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
  fixture.failNextRead = true
  await assert.rejects(loadWorkspace(), /Storage unavailable/)
  await deleteSavedRequest('request-1')
  assert.deepEqual(await listSavedRequests(), [])
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
}
test('recovers interrupted attempts without losing completed results or drafts', interruptedRequests)
