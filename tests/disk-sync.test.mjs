/** Configuration writes preserve the last disk filenames and reject invalid choices without changing saved settings. */
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {DISK_SYNC_KEY, DISK_SYNC_LOCK, loadDiskSyncSettings, saveDiskSyncSettings} from '../src/collections/disk-sync.ts'
import {storageFixture} from './helpers/extension-storage.mjs'

/** Bind isolated browser storage and Web Locks before testing shared sync settings. */
function storage() {
  const fixture = storageFixture()
  globalThis.chrome = fixture.chrome
  return fixture
}

/** Create representative settings, including successful progress that must survive rejected configuration changes. */
function savedSettings() {
  return {
    enabled: true, directoryKey: 'folder', directoryName: 'Backups',
    collectionIds: ['collection'], fileNames: {collection: 'original.postman_collection.json'},
    fingerprints: {collection: 'completed-hash'}, lastSyncedAt: 90
  }
}

/** Reject missing folders and empty selections while preserving the currently enabled backups. */
async function rejectInvalidChoices() {
  const fixture = storage()
  const original = savedSettings()
  fixture.values.set(DISK_SYNC_KEY, original)
  /** Attempt to enable backups without a persistent folder handle. */
  function saveMissingFolder() { return saveDiskSyncSettings({...original, directoryKey: ''}) }
  assert.throws(saveMissingFolder, /Choose a folder/)
  /** Attempt to enable a selected scope with no collections. */
  function saveEmptySelection() {
    return saveDiskSyncSettings({...original, collectionIds: []})
  }
  assert.throws(saveEmptySelection, /Select at least one collection/)
  assert.deepEqual(await loadDiskSyncSettings(), original)
  fixture.failNextWrite = true
  await assert.rejects(saveDiskSyncSettings({...original, enabled: false}), /Storage full/)
  assert.deepEqual(await loadDiskSyncSettings(), original)
}
test('invalid or failed configuration saves keep existing disk backups enabled', rejectInvalidChoices)

/** Read filenames after acquiring the shared lock, including progress written by an earlier batch. */
async function preserveQueuedFileNames() {
  const fixture = storage()
  const original = savedSettings()
  fixture.values.set(DISK_SYNC_KEY, original)
  let saving
  /** Model an in-flight batch that reserves a filename before a queued configuration save. */
  async function finishEarlierBatch() {
    saving = saveDiskSyncSettings({...original, collectionIds: null, fileNames: {}, fingerprints: {}})
    const fileNames = {...original.fileNames, another: 'reserved.postman_collection.json'}
    const fingerprints = {...original.fingerprints, another: 'new-completed-hash'}
    fixture.values.set(DISK_SYNC_KEY, {...original, fileNames, fingerprints})
  }
  await navigator.locks.request(DISK_SYNC_LOCK, finishEarlierBatch)
  await saving
  const settings = await loadDiskSyncSettings()
  assert.equal(settings.collectionIds, null)
  assert.deepEqual(settings.fileNames, {
    collection: 'original.postman_collection.json', another: 'reserved.postman_collection.json'
  })
  assert.deepEqual(settings.fingerprints, {collection: 'completed-hash', another: 'new-completed-hash'})
  // A different folder starts independent filenames while the earlier disk files remain untouched.
  await saveDiskSyncSettings({...settings, directoryKey: 'new-folder'})
  assert.deepEqual((await loadDiskSyncSettings()).fileNames, {})
  assert.deepEqual((await loadDiskSyncSettings()).fingerprints, {})
}
test('queued configuration changes retain filenames from the latest completed batch', preserveQueuedFileNames)
