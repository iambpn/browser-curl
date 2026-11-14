/** Run real Chromium extension workflows separately from the unit and simulated browser suites. */
import {defineConfig} from '@playwright/test'

/** Keep real extension tests isolated, run once without retries, and put failure output in the ignored test directory. */
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/setup.mjs',
  timeout: 75000,
  expect: {timeout: 10000},
  workers: 1,
  retries: 0,
  reporter: 'list',
  outputDir: '.playwright/results',
  use: {trace: 'off', screenshot: 'off', video: 'off'}
})
