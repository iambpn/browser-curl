/** Browser workflows with real panel DOM, production bundles, and simulated extension storage, ports, and fetch. */
const values = new Map()
const network = []
const connections = new Set()
let panel
let failDraftWrite = false
let failHistoryWrite = false
let failDeletion = false
let failWorkspaceRead = false

/** Create the event listener interface used by the extension APIs. */
function extensionEvent() {
  const listeners = new Set()
  return {
    /** Register a listener. */
    addListener(listener) { listeners.add(listener) },
    /** Remove a listener after a panel or request closes. */
    removeListener(listener) { listeners.delete(listener) },
    /** Deliver an event to the current listeners. */
    emit(...args) { for (const listener of listeners) listener(...args) }
  }
}

const storageChanged = extensionEvent()
const connected = extensionEvent()
const messages = extensionEvent()
const sender = {id: 'browser-test', url: 'chrome-extension://browser-test/sidebar/index.html'}

/** Simulate a fetch that remains pending until the browser scenario supplies a response. */
window.fetch = function simulatedFetch(url, init) {
  const pending = Promise.withResolvers()
  /** Convert explicit cancellation into the same rejection that fetch produces. */
  function abort() { pending.reject(new DOMException('Aborted', 'AbortError')) }
  if (init.signal.aborted) abort()
  else init.signal.addEventListener('abort', abort, {once: true})
  network.push({url, init, ...pending})
  return pending.promise
}

window.chrome = {
  runtime: {
    id: sender.id, onConnect: connected, onMessage: messages,
    /** Return an extension URL without contacting the browser's real extension manager. */
    getURL(path) { return `chrome-extension://browser-test/${path}` },
    /** Resolve the worker's bounded keepalive call. */
    async getPlatformInfo() { return {os: 'linux'} },
    /** Connect the real client and background bundles using a paired asynchronous port. */
    connect({name}) {
      const client = {name, onMessage: extensionEvent(), onDisconnect: extensionEvent()}
      const server = {name, sender, onMessage: extensionEvent(), onDisconnect: extensionEvent()}
      const connection = {panel, client, server}
      /** Deliver a message from the panel to the background on the next task. */
      client.postMessage = function sendToBackground(message) {
        const snapshot = structuredClone(message)
        /** Deliver the cloned request to the server port. */
        function deliver() { server.onMessage.emit(snapshot) }
        queueMicrotask(deliver)
      }
      /** Deliver the saved result back to a live panel. */
      server.postMessage = function sendToPanel(message) {
        const snapshot = structuredClone(message)
        /** Deliver the cloned result to the client port. */
        function deliver() { client.onMessage.emit(snapshot) }
        queueMicrotask(deliver)
      }
      /** Close both ends without changing the background request's controller. */
      function disconnect() {
        if (!connections.delete(connection)) return
        client.onDisconnect.emit()
        server.onDisconnect.emit()
      }
      client.disconnect = disconnect
      server.disconnect = disconnect
      connections.add(connection)
      connected.emit(server)
      return client
    },
    /** Deliver cancellation and deletion to the production background listener. */
    sendMessage(message, respond) {
      /** Deliver a control message to the background listener. */
      function deliver() { messages.emit(message, sender, respond) }
      queueMicrotask(deliver)
    }
  },
  storage: {onChanged: storageChanged, local: {
    /** Read a cloned snapshot so browser code cannot mutate persisted data by reference. */
    get(keys, callback) {
      const result = {}
      for (const key of keys === null ? values.keys() : [keys]) {
        if (values.has(key)) result[key] = structuredClone(values.get(key))
      }
      /** Return the requested snapshot on the next microtask. */
      function deliver() {
        if (keys === 'browsercurl.workspace' && failWorkspaceRead) {
          failWorkspaceRead = false
          chrome.runtime.lastError = {message: 'Storage unavailable'}
          callback({})
          chrome.runtime.lastError = undefined
          return
        }
        callback(result)
      }
      queueMicrotask(deliver)
    },
    /** Persist snapshots and emit the browser's storage-change event shape. */
    set(items, callback) {
      const snapshot = structuredClone(items)
      /** Complete a write or expose its simulated error only during the callback. */
      function storeValues() {
        const isDraft = Object.hasOwn(snapshot, 'browsercurl.workspace')
        if ((isDraft && failDraftWrite) || (!isDraft && failHistoryWrite)) {
          failDraftWrite = false
          failHistoryWrite = false
          chrome.runtime.lastError = {message: 'Storage unavailable'}
          callback()
          chrome.runtime.lastError = undefined
          return
        }
        const changes = {}
        for (const [key, value] of Object.entries(snapshot)) {
          changes[key] = {oldValue: values.get(key), newValue: value}
          values.set(key, value)
        }
        callback()
        storageChanged.emit(changes, 'local')
      }
      queueMicrotask(storeValues)
    },
    /** Delete an entire saved item and notify the real sidebar code. */
    remove(key, callback) {
      /** Confirm deletion or retain the entry if storage fails. */
      function removeValue() {
        if (failDeletion) {
          failDeletion = false
          chrome.runtime.lastError = {message: 'Storage unavailable'}
          callback()
          chrome.runtime.lastError = undefined
          return
        }
        const oldValue = values.get(key)
        values.delete(key)
        callback()
        storageChanged.emit({[key]: {oldValue}}, 'local')
      }
      queueMicrotask(removeValue)
    }
  }},
  sidePanel: {
    /** Ignore toolbar configuration in the simulated browser. */
    setPanelBehavior() {}
  },
  declarativeNetRequest: {
    HeaderOperation: {SET: 'set', REMOVE: 'remove'},
    ResourceType: {XMLHTTPREQUEST: 'xmlhttprequest', OTHER: 'other'},
    RuleActionType: {MODIFY_HEADERS: 'modifyHeaders'},
    /** Start with no browser rules. The scenario tests UI and request lifetime rather than real network rewriting. */
    async getSessionRules() { return [] },
    /** Accept the production background's temporary header rules. */
    async updateSessionRules() {}
  }
}

/** Fail a browser assertion with a readable workflow step. */
function check(condition, message) {
  if (!condition) throw new Error(message)
}

/** Compare a browser value without hiding reads or conditions inside a compound assertion. */
function expectEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(message)
}

/** Compare a control's value with the expected persisted or cleared text. */
function expectValue(selector, expected, message) {
  const actual = find(selector).value
  expectEqual(actual, expected, message)
}

/** Compare visible text with an expected label. */
function expectText(selector, expected, message) {
  const actual = find(selector).textContent
  expectEqual(actual, expected, message)
}

/** Check saved response content without relying on exact pretty-print whitespace. */
function expectTextContains(selector, expected, message) {
  const actual = find(selector).textContent
  const containsText = actual.includes(expected)
  check(containsText, message)
}

/** Wait for asynchronous UI or storage changes with a bounded browser deadline. */
async function until(checkReady, message) {
  const deadline = Date.now() + 3000
  while (!checkReady()) {
    if (Date.now() > deadline) throw new Error(message)
    /** Yield to the next browser task without depending on frame animation timing. */
    function nextTask(resolve) { setTimeout(resolve, 5) }
    await new Promise(nextTask)
  }
}

/** Load a fresh panel against the same background and persisted storage. */
async function openPanel() {
  panel = document.createElement('iframe')
  panel.style = 'width: 500px; height: 900px; border: 0'
  const loaded = Promise.withResolvers()
  panel.onload = loaded.resolve
  panel.srcdoc = panelHtml
  document.body.append(panel)
  await loaded.promise
  panel.contentWindow.chrome = window.chrome
  const style = panel.contentDocument.createElement('style')
  style.textContent = panelCss
  panel.contentDocument.head.append(style)
  const script = panel.contentDocument.createElement('script')
  script.textContent = panelCode
  panel.contentDocument.body.append(script)
  await until(panelReady, 'Panel did not restore its workspace.')
}

/** Check that asynchronous restoration finished before typing into a panel. */
function panelReady() { return !find('#root').inert }

/** Check that a network request reached the simulated transport. */
function networkStarted(count) { return network.length === count }

/** Check that a history control appears after an asynchronous render. */
function elementExists(selector) { return Boolean(find(selector)) }

/** Check that a stored request now has a response or failure. */
function requestFinished() { return Boolean(history()[0]?.result) }

/** Check that selecting a history entry closed its modal. */
function historyClosed() { return !find('#history-dialog').open }

/** Check that returning to the draft removed the history navigation control. */
function draftRestored() { return find('#back-to-draft').hidden }

/** Check that deleting an entry removed its persisted data. */
function historyDeleted() { return history().length === 0 }

/** Check that resending a saved request creates a distinct completed attempt. */
function replayFinished() {
  const saved = history()
  return saved.length === 2 && saved.every(hasResult)
}

/** Identify a completed saved attempt without depending on its HTTP status. */
function hasResult(saved) { return Boolean(saved.result) }

/** Check that removing the replay leaves the original saved request. */
function originalRemains() { return history().length === 1 }

/** Check that a status or error is visible after an asynchronous action. */
function elementVisible(selector) { return !find(selector).hidden }

/** Close a panel and disconnect its ports while the shared background stays alive. */
function closePanel() {
  panel.contentWindow.dispatchEvent(new Event('pagehide'))
  for (const connection of connections) {
    if (connection.panel === panel) connection.client.disconnect()
  }
  panel.remove()
}

/** Find a control inside the active panel. */
function find(selector) { return panel.contentDocument.querySelector(selector) }

/** Enter a value and dispatch the input/change events produced by browser controls. */
function enter(selector, value) {
  const control = find(selector)
  control.value = value
  control.dispatchEvent(new Event('input', {bubbles: true}))
  control.dispatchEvent(new Event('change', {bubbles: true}))
}

/** Read only sent history entries from the simulated extension storage. */
function history() {
  const saved = []
  for (const [key, value] of values) {
    if (key.startsWith('browsercurl.history.')) saved.push(value)
  }
  return saved
}

/** Complete one pending network request with stable response metadata and a body. */
function completeRequest(index) {
  const response = new Response('{"saved":true}', {status: 201, headers: {'Content-Type': 'application/json', 'X-Result': 'stored'}})
  Object.defineProperty(response, 'url', {value: network[index].url.href})
  network[index].resolve(response)
}

/** Exercise persistence, history previews, running state, clearing, deletion, and cancellation across panel lifetimes. */
async function run() {
  const background = document.createElement('script')
  background.textContent = backgroundCode
  document.body.append(background)
  await openPanel()
  enter('#request-url', 'https://api.example.test/items?tag=one')
  expectText('#request-name', 'api.example.test', 'Unnamed requests must use the hostname.')
  enter('#request-method', 'POST')
  enter('#request-body', '{"draft":')
  enter('#bearer-token', 'test-bearer')
  enter('#basic-password', 'inactive-test-password')
  enter('#api-key-name', 'inactive-api-key')
  enter('#api-key-location', 'query')
  find('[data-add="params"]').click()
  enter('#params-rows .entry-row:last-child [data-field="key"]', 'tag')
  enter('#params-rows .entry-row:last-child [data-field="value"]', 'two')
  const disabledParam = find('#params-rows .entry-row:last-child [data-field="enabled"]')
  disabledParam.checked = false
  disabledParam.dispatchEvent(new Event('input', {bubbles: true}))
  find('[data-add="headers"]').click()
  enter('#headers-rows .entry-row [data-field="key"]', 'X-Test')
  enter('#headers-rows .entry-row [data-field="value"]', 'header-value')
  const enabled = find('#headers-rows .entry-row [data-field="enabled"]')
  enabled.checked = false
  enabled.dispatchEvent(new Event('input', {bubbles: true}))
  closePanel()
  await openPanel()
  expectValue('#request-body', '{"draft":', 'Unsent partial bodies must survive closing.')
  expectValue('#bearer-token', 'test-bearer', 'Authorization must survive closing.')
  expectValue('#basic-password', 'inactive-test-password', 'Inactive authorization fields must survive closing.')
  expectValue('#api-key-name', 'inactive-api-key', 'Inactive authorization fields must restore.')
  expectValue('#api-key-location', 'query', 'Inactive authorization selections must restore.')
  expectEqual(find('#params-rows .entry-row:last-child [data-field="enabled"]').checked, false, 'Disabled URL parameters must restore.')
  expectEqual(find('#headers-rows [data-field="enabled"]').checked, false, 'Disabled headers must survive closing.')
  expectEqual(history().length, 0, 'Typing must not add sent history.')
  enter('#request-body', '{"draft":true}')
  find('#send-request').click()
  await until(networkStarted.bind(null, 1), 'Send did not reach the background.')
  const pendingHistory = history()
  check(pendingHistory.length === 1 && !pendingHistory[0].result, 'A sent request must be saved while running.')
  expectText('#workspace-status-label', 'Running', 'The panel must label a running request.')
  find('#show-history').click()
  await until(elementExists.bind(null, '[data-history-status-label]'), 'History did not render.')
  expectText('[data-history-status-label]', 'Running', 'History must label a running request.')
  const spinner = find('[data-history-status] .running-spinner')
  const spinnerDisplay = panel.contentWindow.getComputedStyle(spinner).display
  check(spinnerDisplay !== 'none', 'The running icon must be visible.')
  find('#close-history').click()
  closePanel()
  completeRequest(0)
  await until(requestFinished, 'Closing the panel prevented background completion.')
  await openPanel()
  expectTextContains('#response-content', '"saved": true', 'The saved response must restore.')
  expectTextContains('#response-status', '201', 'The saved response status must restore.')
  expectText('#response-header-count', '2', 'The saved response headers must restore.')
  find('#response-headers-tab').click()
  expectTextContains('#response-headers-panel', 'x-result: stored', 'The full saved response headers must be available.')
  find('#response-body-tab').click()
  find('#clear-request').click()
  expectValue('#request-url', '', 'Clear form must empty the URL.')
  expectValue('#request-body', '', 'Clear form must empty the body.')
  expectValue('#bearer-token', '', 'Clear form must empty the bearer token.')
  expectValue('#basic-password', '', 'Clear form must empty inactive credentials.')
  expectValue('#api-key-name', '', 'Clear form must empty inactive API keys.')
  expectValue('#auth-type', 'none', 'Clear form must reset authorization selection.')
  expectValue('#request-method', 'GET', 'Clear form must reset the HTTP method.')
  expectValue('#params-rows [data-field="key"]', '', 'Clear form must empty parameters.')
  expectValue('#headers-rows [data-field="key"]', '', 'Clear form must empty headers.')
  expectEqual(find('#response-content').hidden, true, 'Clear form must clear the visible response.')
  expectEqual(history().length, 1, 'Clear form must keep saved history.')
  enter('#request-url', 'https://draft.example.test/unsent')
  enter('#request-method', 'PATCH')
  enter('#request-body', 'unfinished draft')
  find('#show-history').click()
  await until(elementExists.bind(null, '[data-open-history]'), 'Saved entry did not appear.')
  find('[data-open-history]').click()
  await until(historyClosed, 'History entry did not open.')
  expectValue('#request-body', '{"draft":true}', 'History must restore the original request body.')
  expectValue('#bearer-token', 'test-bearer', 'History must restore original authorization.')
  expectEqual(find('#back-to-draft').hidden, false, 'History must provide a route back to the draft.')
  closePanel()
  await openPanel()
  expectValue('#request-body', '{"draft":true}', 'The current history preview must restore after closure.')
  find('#send-request').click()
  await until(networkStarted.bind(null, 2), 'Resending history did not start a new request.')
  completeRequest(1)
  await until(replayFinished, 'Resending must save a separate completed history entry.')
  find('#show-history').click()
  await until(elementExists.bind(null, '[data-delete-history]'), 'The replay did not appear in history.')
  find('[data-delete-history]').click()
  await until(originalRemains, 'Deleting the replay must retain the original saved request.')
  find('#close-history').click()
  find('#back-to-draft').click()
  await until(draftRestored, 'The original draft did not reopen.')
  expectValue('#request-url', 'https://draft.example.test/unsent', 'History must preserve the unsent draft URL.')
  expectValue('#request-body', 'unfinished draft', 'History must preserve the unsent draft body.')
  failDraftWrite = true
  enter('#request-body', 'draft kept after a storage failure')
  await until(elementVisible.bind(null, '#storage-error'), 'Draft write failures must be visible.')
  expectValue('#request-body', 'draft kept after a storage failure', 'A storage failure must not clear entered text.')
  find('#show-history').click()
  await until(elementExists.bind(null, '[data-delete-history]'), 'Delete control did not render.')
  failDeletion = true
  find('[data-delete-history]').click()
  await until(elementVisible.bind(null, '#history-error'), 'Deletion failures must be visible.')
  expectEqual(history().length, 1, 'A failed deletion must retain the saved request and response.')
  find('[data-delete-history]').click()
  await until(historyDeleted, 'Delete must remove the entire saved request and response.')
  await until(elementVisible.bind(null, '#history-empty'), 'Deleted items must disappear from history.')
  find('#close-history').click()
  find('#clear-request').click()
  enter('#request-url', 'https://slow.example.test')
  find('#request-name').click()
  enter('#request-name-input', 'My slow request')
  find('#request-name-input').blur()
  failHistoryWrite = true
  find('#send-request').click()
  await until(elementVisible.bind(null, '#request-error'), 'A failed initial history write must be visible.')
  expectEqual(network.length, 2, 'A failed initial history write must prevent sending.')
  expectEqual(history().length, 0, 'A failed initial history write must not create a saved item.')
  find('#send-request').click()
  await until(networkStarted.bind(null, 3), 'The slow request did not start.')
  expectEqual(history()[0].name, 'My slow request', 'An explicit name must override the hostname in history.')
  closePanel()
  await openPanel()
  expectText('#request-name', 'My slow request', 'Custom request names must survive closing.')
  expectText('#send-request', 'Cancel', 'A reopened running request must remain cancelable.')
  find('#send-request').click()
  await until(requestFinished, 'Cancellation did not save a failure result.')
  expectEqual(history()[0].result.message, 'Request canceled.', 'The saved result must identify cancellation.')
  panel.style.width = '280px'
  find('#show-history').click()
  await until(elementExists.bind(null, '[data-open-history]'), 'Narrow history did not render.')
  const dialog = find('#history-dialog')
  check(dialog.scrollWidth <= dialog.clientWidth, 'History must fit a narrow panel.')
  closePanel()
  failWorkspaceRead = true
  await openPanel()
  expectEqual(find('#storage-error').hidden, false, 'A failed draft restoration must be visible.')
  enter('#request-url', 'https://must-not-overwrite.example.test')
  closePanel()
  await openPanel()
  expectValue('#request-url', 'https://slow.example.test', 'A failed restoration must not let a blank editor overwrite the saved draft.')
  expectText('#request-name', 'My slow request', 'A failed restoration must not overwrite the saved request name.')
  closePanel()
  return 'PASS: draft and credential persistence, hostname naming, complete history restore, running icons, background completion, preserved drafts, clear form, deletion, restored cancellation, and narrow history layout.'
}

/** Report workflow results to the command-line runner without exposing saved request contents. */
function passed(message) { document.querySelector('#result').textContent = message }

/** Include the failed workflow step and its stack for diagnosis. */
function failed(error) { document.querySelector('#result').textContent = `FAIL: ${error.stack}` }

void run().then(passed, failed)
