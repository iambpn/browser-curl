/** Provision the pinned browser in this sandbox's cache before starting any extension tests. */
import {access} from 'node:fs/promises'
import {execFileSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {chromium} from '@playwright/test'

/** Dependency copies do not include Playwright's per-user browser cache. */
export default async function setup() {
  try {
    await access(chromium.executablePath())
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    execFileSync(process.execPath, [
      fileURLToPath(import.meta.resolve('@playwright/test/cli')),
      'install', 'chromium', '--no-shell'
    ], {stdio: 'inherit'})
  }
}
