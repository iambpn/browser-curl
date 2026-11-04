/** Cover user interactions with the installed extension, native clipboard, keyboard, pointer, and WebAssembly parser. */
import {test, expect} from './fixtures.mjs'
import {
  addEntry, click, clipboardText, echoedRequest, expectHidden, expectText, expectValue,
  expectVisible, fill, savedWorkspaceWith, send, storedHistory, storedWorkspace
} from './panel-helpers.mjs'

/** Copy actual body and header text, and report a native clipboard refusal from an unfocused document. */
async function realClipboard({extension, api}) {
  const panel = await extension.openPanel()
  await fill(panel, '#request-url', `${api.origin}/gzip`)
  await send(panel)
  await click(panel, '#copy-response')
  await expectText(panel, '#copy-response-label', 'Copied')
  await extension.context.grantPermissions(['clipboard-read'])
  let copied = await panel.evaluate(clipboardText)
  expect(copied).toBe('{\n  "compressed": true\n}')

  await panel.locator('#response-format').selectOption('raw')
  await expectText(panel, '#copy-response-label', 'Copy')
  await click(panel, '#copy-response')
  await expectText(panel, '#copy-response-label', 'Copied')
  copied = await panel.evaluate(clipboardText)
  expect(copied).toBe('{"compressed":true}')
  await click(panel, '#response-headers-tab')
  await expectHidden(panel, '#response-format')
  await click(panel, '#copy-response')
  await expectText(panel, '#copy-response-label', 'Copied')
  copied = await panel.evaluate(clipboardText)
  expect(copied).toContain('content-encoding: gzip')
  expect(copied).toContain('x-test-response: preserved')
  const icon = panel.locator('#copy-response svg')
  await expect(icon).toBeVisible()
  await extension.context.grantPermissions([])
  const session = await extension.context.newCDPSession(panel)
  const otherPage = await extension.context.newPage()
  try {
    await session.send('Emulation.setFocusEmulationEnabled', {enabled: false})
    await otherPage.goto('about:blank')
    await otherPage.bringToFront()
    /** Invoke the real handler while the document lacks focus, so Chromium refuses the clipboard write. */
    function copyWithoutFocus() { document.querySelector('#copy-response').click() }
    await panel.evaluate(copyWithoutFocus)
    await expectText(panel, '#copy-response-label', 'Copy failed')
    await expect(icon).toBeVisible()
  } finally {
    await session.detach()
    await otherPage.close()
  }
}
test('copies pretty, raw, and header responses using the real clipboard', realClipboard)

/** Navigate tabs and rename with keyboard events, then send using each supported modifier key. */
async function keyboardActions({extension, api}) {
  const panel = await extension.openPanel()
  await fill(panel, '#request-url', `${api.origin}/echo`)
  await expectText(panel, '#request-name', '127.0.0.1')
  await click(panel, '#request-name')
  await fill(panel, '#request-name-input', 'Saved with Enter')
  await panel.keyboard.press('Enter')
  await expectText(panel, '#request-name', 'Saved with Enter')
  expect(api.requests).toEqual([])
  await click(panel, '#request-name')
  await fill(panel, '#request-name-input', 'Discard with Escape')
  await panel.keyboard.press('Escape')
  await expectText(panel, '#request-name', 'Saved with Enter')
  await click(panel, '#request-name')
  await fill(panel, '#request-name-input', '')
  await panel.keyboard.press('Enter')
  await expectText(panel, '#request-name', '127.0.0.1')

  const params = panel.locator('#params-tab')
  await params.focus()
  await panel.keyboard.press('ArrowRight')
  const headers = panel.locator('#headers-tab')
  await expect(headers).toBeFocused()
  await expect(headers).toHaveAttribute('aria-selected', 'true')
  await panel.keyboard.press('End')
  const auth = panel.locator('#auth-tab')
  await expect(auth).toBeFocused()
  await expectVisible(panel, '#auth-panel')
  await panel.keyboard.press('Home')
  await expect(params).toBeFocused()
  await panel.keyboard.press('Control+Enter')
  await expectVisible(panel, '#response-stats')
  await expectText(panel, '#send-request', 'Send')
  await panel.keyboard.press('Meta+Enter')
  /** Count real requests rather than relying on a response left over from the first shortcut. */
  function sentTwice() { return api.requests.length }
  await expect.poll(sentTwice).toBe(2)
  await expectText(panel, '#send-request', 'Send')

  await click(panel, '#response-body-tab')
  const responseBody = panel.locator('#response-body-tab')
  await responseBody.focus()
  await panel.keyboard.press('ArrowRight')
  const responseHeaders = panel.locator('#response-headers-tab')
  await expect(responseHeaders).toBeFocused()
  await expectVisible(panel, '#response-headers-panel')
  await click(panel, '#show-history')
  await expectVisible(panel, '#history-dialog')
  await panel.keyboard.press('Escape')
  await expectHidden(panel, '#history-dialog')
}
test('supports tab navigation, rename Enter and Escape, and Control/Command send shortcuts', keyboardActions)

/** Drag and resize with real pointer/keyboard events, then restore the chosen height from the disk profile. */
async function resizing({extension}) {
  let panel = await extension.openPanel()
  const separator = panel.locator('#response-resizer')
  const initialValue = await separator.getAttribute('aria-valuenow')
  const initial = Number(initialValue)
  const bounds = await separator.boundingBox()
  const x = bounds.x + bounds.width / 2
  const y = bounds.y + bounds.height / 2
  await panel.mouse.move(x, y)
  await panel.mouse.down()
  await panel.mouse.move(x, y - 60, {steps: 6})
  await panel.mouse.up()
  const draggedValue = await separator.getAttribute('aria-valuenow')
  const draggedHeight = Number(draggedValue)
  expect(draggedHeight).toBe(initial + 60)
  await separator.focus()
  await panel.keyboard.press('Shift+ArrowUp')
  const shiftedValue = await separator.getAttribute('aria-valuenow')
  const shiftedHeight = Number(shiftedValue)
  expect(shiftedHeight).toBe(initial + 100)
  await panel.keyboard.press('ArrowDown')
  const savedHeight = initial + 90
  await expect(separator).toHaveAttribute('aria-valuenow', String(savedHeight))
  await extension.restart()
  panel = await extension.openPanel()
  const restored = panel.locator('#response-resizer')
  await expect(restored).toHaveAttribute('aria-valuenow', String(savedHeight))
  await restored.focus()
  await panel.keyboard.press('Home')
  await expect(restored).toHaveAttribute('aria-valuenow', '140')
  await panel.keyboard.press('End')
  const maximum = await restored.getAttribute('aria-valuemax')
  await expect(restored).toHaveAttribute('aria-valuenow', maximum)
}
test('resizes by pointer and keyboard and retains the chosen height after a browser restart', resizing)

/** Enter a cURL command through the URL field, import without sending, and restore the complete earlier draft with Undo. */
async function typedCurlAndUndo({extension, api}) {
  const panel = await extension.openPanel()
  await fill(panel, '#request-url', `${api.origin}/echo?old=draft`)
  await panel.locator('#request-method').selectOption('PATCH')
  await click(panel, '#body-tab')
  await fill(panel, '#request-body', '{"old":')
  await click(panel, '#auth-tab')
  await fill(panel, '#bearer-token', 'previous-bearer')
  await addEntry(panel, 'headers', 'X-Previous', 'retained', false)
  const before = await panel.evaluate(storedWorkspace)
  const command = `curl '${api.origin}/echo?new=imported' -X POST -H 'X-Imported: yes' -u 'user:pass' --data-raw '{"imported":true}'`
  await fill(panel, '#request-url', command)
  await click(panel, '#send-request')
  await expectVisible(panel, '#import-notice')
  await expectValue(panel, '#request-method', 'POST')
  await expectValue(panel, '#request-url', `${api.origin}/echo?new=imported`)
  expect(api.requests).toEqual([])
  await click(panel, '#undo-import')
  const after = await panel.evaluate(storedWorkspace)
  const expected = structuredClone(before)
  expected.draft.editor.url = command
  expect(after).toEqual(expected)
  await expectValue(panel, '#request-method', 'PATCH')
  await click(panel, '#body-tab')
  await expectValue(panel, '#request-body', '{"old":')
  const history = await panel.evaluate(storedHistory)
  expect(history).toEqual([])
}
test('imports a typed cURL command without sending and supports complete Undo', typedCurlAndUndo)

/** Paste actual clipboard text, import the command, send its HTTP values, and undo without losing the earlier draft. */
async function pastedCurl({extension, api}) {
  const panel = await extension.openPanel()
  await fill(panel, '#request-url', `${api.origin}/echo?before=paste`)
  const before = await savedWorkspaceWith(panel, 'url', `${api.origin}/echo?before=paste`)
  await extension.context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const command = `curl '${api.origin}/echo?from=paste' -X POST -H 'Content-Type: application/json' -H 'X-Pasted: yes' --data-raw '{"pasted":true}'`
  /** Put the command on the system clipboard before a real keyboard paste. */
  function writeClipboard(text) { return navigator.clipboard.writeText(text) }
  await panel.evaluate(writeClipboard, command)
  const url = panel.locator('#request-url')
  await url.focus()
  await url.selectText()
  await panel.keyboard.press('Control+V')
  await expectValue(panel, '#request-url', `${api.origin}/echo?from=paste`)
  await expectVisible(panel, '#import-notice')
  await click(panel, '#undo-import')
  const restored = await panel.evaluate(storedWorkspace)
  expect(restored).toEqual(before)

  await url.focus()
  await url.selectText()
  await panel.keyboard.press('Control+V')
  await expectValue(panel, '#request-method', 'POST')
  await send(panel)
  const received = await echoedRequest(panel)
  expect(received.headers['x-pasted']).toBe('yes')
  expect(received.body).toBe('{"pasted":true}')
  expect(received.url).toBe('/echo?from=paste')
}
test('imports a real clipboard paste, restores the earlier draft, and sends the imported request', pastedCurl)
