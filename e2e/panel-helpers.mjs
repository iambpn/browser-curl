/** Shared user actions and observations against the real extension document. No browser APIs are replaced. */
import {expect} from '@playwright/test'

/** Fill one editor field using normal browser input events. */
export async function fill(page, selector, value) {
  await page.locator(selector).fill(value)
}

/** Select one request or response tab through its actual button. */
export async function click(page, selector) {
  await page.locator(selector).click()
}

/** Compare the current value of a real form control with an expected saved value. */
export async function expectValue(page, selector, value) {
  const field = page.locator(selector)
  await expect(field).toHaveValue(value)
}

/** Wait for exact visible text, including saved HTTP statuses and running indicators. */
export async function expectText(page, selector, text) {
  const element = page.locator(selector)
  await expect(element).toHaveText(text)
}

/** Wait for a control or message to be visible after asynchronous background work. */
export async function expectVisible(page, selector) {
  const element = page.locator(selector)
  await expect(element).toBeVisible()
}

/** Wait for a control or message to be hidden or absent. */
export async function expectHidden(page, selector) {
  const element = page.locator(selector)
  await expect(element).toBeHidden()
}

/** Add and fill a header or parameter row, retaining disabled rows as actual editor data. */
export async function addEntry(page, group, key, value, enabled = true) {
  const tab = group === 'headers' ? '#headers-tab' : '#params-tab'
  await click(page, tab)
  await click(page, `[data-add="${group}"]`)
  const row = page.locator(`#${group}-rows .entry-row`).last()
  await row.locator('[data-field="key"]').fill(key)
  await row.locator('[data-field="value"]').fill(value)
  await row.locator('[data-field="enabled"]').setChecked(enabled)
}

/** Send through the real form and wait for a response instead of reading a simulated transport. */
export async function send(page) {
  await click(page, '#send-request')
  await expectVisible(page, '#response-stats')
  await expectText(page, '#send-request', 'Send')
}

/** Read the response text as JSON after the real server echoes the transmitted request. */
export async function echoedRequest(page) {
  const text = await page.locator('#response-content').textContent()
  return JSON.parse(text)
}

/** Browser callback for page.evaluate(): return real saved requests from the extension page's trusted origin. */
export async function storedHistory() {
  const items = await chrome.storage.local.get(null)
  const saved = []
  for (const [key, value] of Object.entries(items)) {
    if (key.startsWith('browsercurl.history.')) saved.push(value)
  }
  return saved
}

/** Browser callback for page.evaluate(): return saved editor data independently of the rendered UI. */
export async function storedWorkspace() {
  const items = await chrome.storage.local.get('browsercurl.workspace')
  return items['browsercurl.workspace']
}

/** Browser callback for page.evaluate(): return the saved size settings, or undefined before the first save. */
export async function storedSettings() {
  const items = await chrome.storage.local.get('browsercurl.settings')
  return items['browsercurl.settings']
}

/** Browser callback for page.evaluate(): save size settings directly in extension storage. */
export function saveSizeSettings(settings) {
  return chrome.storage.local.set({'browsercurl.settings': settings})
}

/**
 * Wait until the delayed editor save stores the given value, and return the saved workspace.
 * field is an editor value name, such as url or body. The check uses the history preview when one is open.
 */
export async function savedWorkspaceWith(page, field, value) {
  /** Read the saved value of the editor that the panel shows. */
  async function savedValue() {
    const workspace = await page.evaluate(storedWorkspace)
    const snapshot = workspace?.preview ?? workspace?.draft
    return snapshot?.editor[field]
  }
  await expect.poll(savedValue).toBe(value)
  return page.evaluate(storedWorkspace)
}

/** Browser callback for page.evaluate(): return real temporary header rules for cleanup checks. */
export function sessionRules() {
  return chrome.declarativeNetRequest.getSessionRules()
}

/** Browser callback for page.evaluate(): read the actual clipboard after the production Copy button runs. */
export function clipboardText() {
  return navigator.clipboard.readText()
}

/** Browser callback for page.evaluate(): read collections and their index from real extension storage. */
export async function storedCollections() {
  const items = await chrome.storage.local.get(null)
  return {
    index: items['browsercurl.collectionIndex'] ?? [],
    collections: Object.entries(items).filter(([key]) => key.startsWith('browsercurl.collection.')).map(([, value]) => value)
  }
}

/** Fork Base into a new env: select Base, click the fork icon, then name the fork in its tab field. */
export async function forkBase(page, name) {
  await page.getByRole('tab', {name: 'Base', exact: true}).click()
  await page.locator('#env-new-fork').click()
  const field = page.locator('#env-rename-fork-name')
  await expect(field).toBeFocused()
  await field.fill(name)
  await field.press('Enter')
  await expect(page.getByRole('tab', {name: name.trim(), exact: true})).toHaveAttribute('aria-selected', 'true')
}

/** Delete the selected fork: the first click asks for confirmation in a tooltip, the second deletes. */
export async function deleteSelectedFork(page) {
  await page.locator('#env-delete-fork').click()
  await expect(page.locator('#env-delete-tooltip')).toBeVisible()
  await page.locator('#env-delete-fork').click()
}

/** The Save as label of a folder: indented once per level under the collection root, then its path. */
export function folderOption(...path) {
  const indent = '\u00a0'.repeat(4 * path.length)
  return `${indent}\u{1F4C1} ${path.join(' / ')}`
}
