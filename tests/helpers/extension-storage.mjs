/** Callback-based extension storage and events for persistence and background lifecycle unit tests. */
import {EventEmitter} from 'node:events'

/** Make a listener collection with the same add/remove behavior as an extension event. */
export function extensionEvent() {
  const listeners = new Set()
  return {
    /** Register one listener. */
    addListener(listener) { listeners.add(listener) },
    /** Remove one listener after request cleanup. */
    removeListener(listener) { listeners.delete(listener) },
    /** Deliver an event to the currently registered listeners. */
    emit(...args) {
      for (const listener of listeners) listener(...args)
    },
    listeners
  }
}

/** Simulate persisted JSON data and callback-scoped storage failures without loading any environment files. */
export function storageFixture() {
  const values = new Map()
  const writes = new EventEmitter()
  const onChanged = extensionEvent()
  const runtime = {id: 'test-extension', lastError: undefined, keepAliveCalls: 0,
    /** Return a trusted extension URL for the port authorization check. */
    getURL(path) { return `chrome-extension://test-extension/${path}` },
    /** Count worker keepalive calls while a request is active. */
    async getPlatformInfo() { runtime.keepAliveCalls += 1; return {os: 'linux'} }
  }
  const fixture = {values, runtime, failNextWrite: false, failNextRead: false, failNextRemove: false,
    chrome: {runtime, storage: {onChanged, local: {
      /** Read a snapshot of selected keys, with errors available only during the callback. */
      get(keys, callback) {
        /** Deliver the read after the calling code installs its listeners. */
        function deliver() {
          if (fixture.failNextRead) {
            fixture.failNextRead = false
            runtime.lastError = {message: 'Storage unavailable'}
          }
          const items = {}
          const selected = keys === null ? values.keys() : [keys]
          for (const key of selected) {
            if (values.has(key)) items[key] = structuredClone(values.get(key))
          }
          callback(items)
          runtime.lastError = undefined
        }
        queueMicrotask(deliver)
      },
      /** Store a cloned snapshot, or fail without changing persisted data. */
      set(items, callback) {
        const snapshot = structuredClone(items)
        /** Complete the asynchronous write and publish storage changes. */
        function deliver() {
          if (fixture.failNextWrite) {
            fixture.failNextWrite = false
            runtime.lastError = {message: 'Storage full'}
            callback()
            runtime.lastError = undefined
            return
          }
          const changes = {}
          for (const [key, value] of Object.entries(snapshot)) {
            changes[key] = {oldValue: values.get(key), newValue: value}
            values.set(key, value)
          }
          callback()
          onChanged.emit(changes, 'local')
          writes.emit('change')
        }
        queueMicrotask(deliver)
      },
      /** Remove a whole record and publish the same deletion shape as extension storage. */
      remove(key, callback) {
        /** Complete removal after earlier queued storage callbacks. */
        function deliver() {
          if (fixture.failNextRemove) {
            fixture.failNextRemove = false
            runtime.lastError = {message: 'Storage unavailable'}
            callback()
            runtime.lastError = undefined
            return
          }
          const oldValue = values.get(key)
          values.delete(key)
          callback()
          onChanged.emit({[key]: {oldValue}}, 'local')
          writes.emit('change')
        }
        queueMicrotask(deliver)
      }
    }}},
    /** Wait for an observable write condition and fail rather than leave a hanging test. */
    waitFor(check) {
      if (check()) return Promise.resolve()
      /** Observe writes until the requested condition becomes true. */
      function observe(resolve, reject) {
        /** Remove the listener after a condition succeeds or times out. */
        function cleanup() { clearTimeout(timeout); writes.off('change', changed) }
        /** Resolve only when the caller's saved-data condition passes. */
        function changed() { if (check()) { cleanup(); resolve() } }
        /** Fail a missing background completion with a bounded wait. */
        function expired() { cleanup(); reject(new Error('Expected storage update did not arrive.')) }
        const timeout = setTimeout(expired, 2000)
        writes.on('change', changed)
      }
      return new Promise(observe)
    }
  }
  return fixture
}

/** Include disabled entries and inactive credentials so round-trip tests detect incomplete snapshots. */
export function editorFixture() {
  return {
    name: '', method: 'POST', url: 'https://api.example.test/items?tag=one',
    params: [
      {enabled: true, key: 'tag', value: 'one'},
      {enabled: false, key: 'tag', value: 'two'},
      {enabled: true, key: '', value: 'unfinished'}
    ],
    headers: [{enabled: false, key: 'X-Draft', value: 'kept'}],
    body: '{"hello":"world"}', bodyType: 'json', authType: 'bearer',
    authValues: {'bearer-token': 'test-token', 'basic-password': 'inactive-password', 'api-key-location': 'query'}
  }
}

/** Create a send attempt with its original editor values and its effective HTTP payload. */
export function savedFixture(id = 'request-1') {
  const editor = editorFixture()
  return {
    id, name: 'api.example.test', sentAt: 100,
    editor,
    request: {method: 'POST', url: editor.url, headers: [['Authorization', 'Bearer test-token']], body: editor.body}
  }
}
