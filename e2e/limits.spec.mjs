/** Check the options page, the response size limit, the history body limit, and binary bodies with the real extension. */
import {test, expect} from './fixtures.mjs'
import {
  click, expectText, expectVisible, fill, saveSizeSettings, send, storedHistory, storedSettings
} from './panel-helpers.mjs'

/** Show the defaults, save valid values, reject invalid values, and restore the defaults. */
async function optionsPage({extension}) {
  const options = await extension.openOptions()
  await expect(options.locator('#max-response-mb')).toHaveValue('10')
  await expect(options.locator('#history-body-limit-mb')).toHaveValue('2')
  expect(await options.evaluate(storedSettings)).toBeUndefined()

  await fill(options, '#max-response-mb', '1')
  await fill(options, '#history-body-limit-mb', '0.5')
  await click(options, '#save-settings')
  await expectText(options, '#settings-status', 'Saved. New requests use these limits.')
  expect(await options.evaluate(storedSettings)).toEqual({maxResponseMb: 1, historyBodyLimitMb: 0.5})

  await fill(options, '#max-response-mb', '0')
  await click(options, '#save-settings')
  await expectText(options, '#settings-status', '')
  expect(await options.evaluate(storedSettings)).toEqual({maxResponseMb: 1, historyBodyLimitMb: 0.5})

  await click(options, '#reset-settings')
  await expectText(options, '#settings-status', 'Saved the default limits. New requests use them.')
  await expect(options.locator('#max-response-mb')).toHaveValue('10')
  expect(await options.evaluate(storedSettings)).toEqual({maxResponseMb: 10, historyBodyLimitMb: 2})
}
test('shows default limits and saves valid limits on the options page', optionsPage)

/** Open the options page from the panel's Settings button. */
async function settingsButton({extension}) {
  const panel = await extension.openPanel()
  const opened = extension.context.waitForEvent('page')
  await click(panel, '#open-settings')
  const options = await opened
  await options.waitForURL(/\/options\/index\.html$/)
  await expect(options.locator('h1')).toHaveText('Settings')
}
test('opens the options page from the panel', settingsButton)

/** Cut off a large body, show the live body, save history without the body, and show a note after reopening. */
async function largeResponse({extension, api}) {
  let panel = await extension.openPanel()
  await panel.evaluate(saveSizeSettings, {maxResponseMb: 1, historyBodyLimitMb: 0.5})
  await fill(panel, '#request-url', `${api.origin}/large?bytes=1572864`)
  await send(panel)
  await expectText(panel, '#response-size', '1.0 MB (cut off)')
  await expect(panel.locator('#response-note')).toContainText('larger than the 1.0 MB maximum response size')
  /** Read the length of the visible body text. */
  function bodyLength() { return document.querySelector('#response-content').textContent.length }
  expect(await panel.evaluate(bodyLength)).toBe(1048576)
  const history = await panel.evaluate(storedHistory)
  expect(history).toHaveLength(1)
  expect(history[0].result.response.body).toBe('')
  expect(history[0].result.response.isBodyOmitted).toBe(true)
  expect(history[0].result.response.isTruncated).toBe(true)

  await panel.close()
  panel = await extension.openPanel()
  await expectVisible(panel, '#response-stats')
  await expect(panel.locator('#response-content')).toContainText('body not saved in history')
}
test('cuts off a large response and keeps its body out of history', largeResponse)

/** Keep a body that is larger than the history limit visible in the live panel. */
async function liveBodyAboveHistoryLimit({extension, api}) {
  const panel = await extension.openPanel()
  await panel.evaluate(saveSizeSettings, {maxResponseMb: 10, historyBodyLimitMb: 0})
  await fill(panel, '#request-url', `${api.origin}/echo?live=yes`)
  await send(panel)
  await expect(panel.locator('#response-content')).toContainText('/echo?live=yes')
  const history = await panel.evaluate(storedHistory)
  expect(history[0].result.response.body).toBe('')
  await expect(panel.locator('#response-content')).toContainText('/echo?live=yes')
}
test('shows the live body when history omits it', liveBodyAboveHistoryLimit)

/** Show a note for a binary body and do not save its bytes as text. */
async function binaryResponse({extension, api}) {
  const panel = await extension.openPanel()
  await fill(panel, '#request-url', `${api.origin}/binary`)
  await send(panel)
  await expect(panel.locator('#response-content')).toContainText('binary body not shown: 8 B of image/png')
  const history = await panel.evaluate(storedHistory)
  expect(history[0].result.response.isBinary).toBe(true)
  expect(history[0].result.response.body).toBe('')
}
test('does not show or save binary response bodies', binaryResponse)
