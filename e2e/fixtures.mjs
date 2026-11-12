/** Real extension installation, isolated disk profiles, and a local HTTP server for each test. */
import {test as base, chromium} from '@playwright/test'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {TestHttpServer} from './http-server.mjs'

/** The folder that receives one `.webm` video for each browser page when `FACTORY_EVIDENCE=1` is set. */
const EVIDENCE_VIDEO_DIR = fileURLToPath(new URL('../.factory-evidence/videos', import.meta.url))

/**
 * Build the video option of the browser session.
 *
 * @returns A Playwright `recordVideo` option when `FACTORY_EVIDENCE=1` is set, so a factory agent can record proof.
 * Otherwise an empty object, so normal test runs record nothing.
 */
function evidenceVideoOptions() {
  if (process.env.FACTORY_EVIDENCE !== '1') return {}
  return {recordVideo: {dir: EVIDENCE_VIDEO_DIR, size: {width: 1100, height: 1000}}}
}

/** Launch and restart the built extension while retaining only this test's private browser profile. */
class ExtensionSession {
  context
  extensionId
  profile
  extensionPath = fileURLToPath(new URL('../dist/chromium', import.meta.url))

  /** Bind the temporary profile path. The fixture owns its deletion. */
  constructor(profile) {
    this.profile = profile
  }

  /** Load the actual manifest and background worker in Playwright's full Chromium browser. */
  async start() {
    this.context = await chromium.launchPersistentContext(this.profile, {
      channel: 'chromium',
      headless: true,
      viewport: {width: 1100, height: 1000},
      ...evidenceVideoOptions(),
      args: [
        `--disable-extensions-except=${this.extensionPath}`,
        `--load-extension=${this.extensionPath}`
      ]
    })
    let [worker] = this.context.serviceWorkers()
    if (!worker) worker = await this.context.waitForEvent('serviceworker')
    const workerUrl = new URL(worker.url())
    this.extensionId = workerUrl.hostname
  }

  /** Open the production sidebar document with real extension APIs, storage, ports, and permissions. */
  async openPanel() {
    const page = await this.context.newPage()
    await page.goto(`chrome-extension://${this.extensionId}/sidebar/index.html`)
    await page.waitForFunction(panelRestored)
    return page
  }

  /** Open the production options page and wait until it loads the saved settings. */
  async openOptions() {
    const page = await this.context.newPage()
    await page.goto(`chrome-extension://${this.extensionId}/options/index.html`)
    await page.waitForFunction(optionsLoaded)
    return page
  }

  /** End the browser process and relaunch the same profile to verify on-disk persistence. */
  async restart() {
    await this.context.close()
    this.context = undefined
    await this.start()
  }

  /** Close the current browser, including any panels and real worker processes. */
  async close() {
    await this.context?.close()
    this.context = undefined
  }
}

/** Check the production sidebar's startup guard before interacting with restored fields. */
function panelRestored() {
  const root = document.querySelector('#root')
  return root && !root.inert
}

/** Check that the options page loaded the saved settings and enabled its form. */
function optionsLoaded() {
  const form = document.querySelector('#settings-form')
  return form && !form.inert
}

/** Create a unique profile and always close its browser before removing its files. */
async function extensionFixture({}, use) {
  const prefix = join(tmpdir(), 'browsercurl-e2e-')
  const profile = await mkdtemp(prefix)
  const extension = new ExtensionSession(profile)
  try {
    await extension.start()
    await use(extension)
  } finally {
    await extension.close()
    await rm(profile, {recursive: true, force: true})
  }
}

/** Start and stop the real HTTP service, including pending sockets, for each requesting test. */
async function serverFixture({}, use) {
  const api = new TestHttpServer()
  try {
    await api.start()
    await use(api)
  } finally {
    await api.close()
  }
}

/** Use extension for an isolated browser and disk profile. Use api for a loopback HTTP service owned by the test. */
export const test = base.extend({extension: extensionFixture, api: serverFixture})

/** Use Playwright's assertions for automatic browser waits and readable failure reports. */
export {expect} from '@playwright/test'
