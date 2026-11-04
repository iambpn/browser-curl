/** The options page: read, validate, and save the response size limits. */
import {DEFAULT_SETTINGS, SETTING_RANGES, loadSettings, saveSettings} from '../shared/settings'
import type {SizeSettings} from '../shared/settings'
import './styles.css'

/** The input element ID for each setting. */
const INPUT_IDS: Record<keyof SizeSettings, string> = {
  maxResponseMb: 'max-response-mb',
  historyBodyLimitMb: 'history-body-limit-mb'
}

/** Find a required element in the options page. */
function element<T extends HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector)
  if (!node) throw new Error(`Missing settings element: ${selector}`)
  return node
}

const form = element<HTMLFormElement>('#settings-form')
const status = element('#settings-status')
const settingNames = Object.keys(INPUT_IDS) as (keyof SizeSettings)[]

/** Return the input element for one setting. */
function settingInput(name: keyof SizeSettings): HTMLInputElement {
  return element<HTMLInputElement>(`#${INPUT_IDS[name]}`)
}

/** Set each input's permitted range and add the range and default value to its hint. */
function describeRanges(): void {
  for (const name of settingNames) {
    const input = settingInput(name)
    const range = SETTING_RANGES[name]
    input.min = String(range.min)
    input.max = String(range.max)
    const hint = element(`#${INPUT_IDS[name]}-hint`)
    hint.textContent += ` Allowed: ${range.min} to ${range.max} MB. Default: ${DEFAULT_SETTINGS[name]} MB.`
  }
}

/** Show the given settings in the form. */
function fillForm(settings: SizeSettings): void {
  for (const name of settingNames) settingInput(name).value = String(settings[name])
}

/** Read the form values. Call this only after the form passes validation. */
function readForm(): SizeSettings {
  const settings = {...DEFAULT_SETTINGS}
  for (const name of settingNames) settings[name] = settingInput(name).valueAsNumber
  return settings
}

/** Show a save or load result below the buttons. */
function showStatus(message: string): void {
  status.textContent = message
}

/** Save the given settings and report the result. */
async function storeSettings(settings: SizeSettings, message: string): Promise<void> {
  try {
    await saveSettings(settings)
    showStatus(message)
  } catch {
    showStatus('Could not save the settings. Try again.')
  }
}

/** Validate and save the entered values. The browser shows a message next to an invalid field. */
async function handleSubmit(event: SubmitEvent): Promise<void> {
  event.preventDefault()
  if (!form.reportValidity()) return
  await storeSettings(readForm(), 'Saved. New requests use these limits.')
}

/** Fill and save the default values. */
async function handleReset(): Promise<void> {
  fillForm(DEFAULT_SETTINGS)
  await storeSettings(DEFAULT_SETTINGS, 'Saved the default limits. New requests use them.')
}

/** Clear an old result message when the user changes a value. */
function handleInput(): void {
  showStatus('')
}

/** Load the saved settings into the form, and then let the user edit them. */
async function start(): Promise<void> {
  describeRanges()
  try {
    const settings = await loadSettings()
    fillForm(settings)
    form.inert = false
  } catch {
    showStatus('Could not read the saved settings. Reload this page to try again.')
  }
}

form.addEventListener('submit', handleSubmit)
form.addEventListener('input', handleInput)
element('#reset-settings').addEventListener('click', handleReset)
void start()
