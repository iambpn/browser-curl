/** Unit tests for the response height preference with simulated browser storage. */
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {loadResponseHeight, saveResponseHeight} from '../src/responses/response-height.ts'

/** Run a check with isolated browser storage and restore the original global. */
function withStorage(storage, check) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', {configurable: true, value: storage})
  try {
    check()
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original)
    else delete globalThis.localStorage
  }
}

/** Save a chosen height and restore it using a fresh read of the same storage. */
function savedHeight() {
  const values = new Map()
  const storage = {
    /** Read a preference from simulated persistent storage. */
    getItem(key) { return values.get(key) ?? null },
    /** Write a preference without retaining state inside the preference module. */
    setItem(key, value) { values.set(key, value) }
  }
  /** Restore the saved height and preserve it until another user resize. */
  function checkSavedHeight() {
    assert.equal(loadResponseHeight(), undefined)
    saveResponseHeight(375.6)
    assert.equal(loadResponseHeight(), 376)
    assert.equal(loadResponseHeight(), 376)
    saveResponseHeight(240)
    assert.equal(loadResponseHeight(), 240)
  }
  withStorage(storage, checkSavedHeight)
}
test('restores the last saved response height', savedHeight)

/** Ignore missing, corrupt, non-finite, or undersized stored preferences. */
function invalidStoredHeight() {
  for (const value of [null, '', 'garbage', '-100', '139', 'Infinity', 'NaN']) {
    const storage = {
      /** Return the current corrupt preference fixture. */
      getItem() { return value }
    }
    /** Use the default response size for this invalid preference. */
    function checkInvalidHeight() {
      assert.equal(loadResponseHeight(), undefined)
    }
    withStorage(storage, checkInvalidHeight)
  }
}
test('ignores invalid stored response heights', invalidStoredHeight)

/** Keep the saved preference when an invalid replacement is supplied. */
function invalidHeightWrite() {
  const storage = {
    /** Fail if an invalid value reaches browser storage. */
    setItem() { assert.fail('Invalid heights must not be stored.') }
  }
  /** Reject each invalid height before attempting a write. */
  function checkInvalidWrites() {
    for (const height of [0, -1, 139, NaN, Infinity]) saveResponseHeight(height)
  }
  withStorage(storage, checkInvalidWrites)
}
test('does not overwrite preferences with invalid heights', invalidHeightWrite)

/** Keep the sidebar usable when browser storage throws on reads or writes. */
function unavailableStorage() {
  const storage = {
    /** Simulate a browser storage read failure. */
    getItem() { throw new Error('Storage unavailable') },
    /** Simulate a browser storage write failure. */
    setItem() { throw new Error('Storage unavailable') }
  }
  /** Fall back to the default height and tolerate failed persistence. */
  function checkStorageFailure() {
    assert.equal(loadResponseHeight(), undefined)
    saveResponseHeight(400)
  }
  withStorage(storage, checkStorageFailure)
}
test('handles unavailable browser storage', unavailableStorage)
