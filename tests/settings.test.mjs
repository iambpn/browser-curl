/** Unit tests for the size settings: defaults, validation, and storage. */
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {
  DEFAULT_SETTINGS, SETTINGS_KEY, loadSettings, megabytesToBytes, normalizeSettings, saveSettings
} from '../src/settings/settings.ts'
import {storageFixture} from './helpers/extension-storage.mjs'

/** Use the 10 MB and 2 MB defaults when nothing is saved. */
async function defaults() {
  const fixture = storageFixture()
  globalThis.chrome = fixture.chrome
  assert.deepEqual(await loadSettings(), {maxResponseMb: 10, historyBodyLimitMb: 2})
  assert.deepEqual(DEFAULT_SETTINGS, {maxResponseMb: 10, historyBodyLimitMb: 2})
}
test('uses the default limits when no settings are saved', defaults)

/** Save and read valid values, including 0 for the history limit. */
async function roundTrip() {
  const fixture = storageFixture()
  globalThis.chrome = fixture.chrome
  await saveSettings({maxResponseMb: 25.5, historyBodyLimitMb: 0})
  assert.deepEqual(fixture.values.get(SETTINGS_KEY), {maxResponseMb: 25.5, historyBodyLimitMb: 0})
  assert.deepEqual(await loadSettings(), {maxResponseMb: 25.5, historyBodyLimitMb: 0})
}
test('saves and reads valid settings', roundTrip)

/** Replace each missing, out-of-range, or non-number value with its default. */
function invalidValues() {
  assert.deepEqual(normalizeSettings(undefined), DEFAULT_SETTINGS)
  assert.deepEqual(normalizeSettings({maxResponseMb: 0, historyBodyLimitMb: 3}), {maxResponseMb: 10, historyBodyLimitMb: 3})
  assert.deepEqual(normalizeSettings({maxResponseMb: 101, historyBodyLimitMb: -1}), DEFAULT_SETTINGS)
  assert.deepEqual(normalizeSettings({maxResponseMb: '5', historyBodyLimitMb: Number.NaN}), DEFAULT_SETTINGS)
}
test('uses defaults for invalid saved values', invalidValues)

/** Convert megabytes with 1024-based units. */
function conversion() {
  assert.equal(megabytesToBytes(1), 1048576)
  assert.equal(megabytesToBytes(0.5), 524288)
  assert.equal(megabytesToBytes(0), 0)
}
test('converts megabytes to bytes', conversion)
