/** Check Firefox package conversion, rejected inputs, private key reuse, and preserved outputs after packaging failures. */
import assert from 'node:assert/strict'
import {createPrivateKey} from 'node:crypto'
import {mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'
import {strToU8, zipSync} from 'fflate'
import {packageChromeBuild, packageFirefoxZip} from '../scripts/package-extensions.mjs'

/** Create an isolated working directory and remove all package files and private keys after the test. */
async function fixture(context) {
  const prefix = join(tmpdir(), 'browsercurl-package-test-')
  const directory = await mkdtemp(prefix)
  /** Remove this test's files after its assertions, including failed package attempts. */
  async function cleanup() {
    await rm(directory, {recursive: true, force: true})
  }
  context.after(cleanup)
  return directory
}

/** Return a minimal Firefox manifest with the ID required for installation outside a temporary session. */
function firefoxManifest() {
  return {
    manifest_version: 2, name: 'Test extension', version: '1.2.3',
    browser_specific_settings: {gecko: {id: 'test@example.com'}}
  }
}

/** Create a Firefox ZIP with overridable entries for malformed and signed input cases. */
function firefoxZip(entries = {}) {
  const manifestText = JSON.stringify(firefoxManifest())
  const manifestBytes = strToU8(manifestText)
  return zipSync({'manifest.json': manifestBytes, ...entries})
}

/** Preserve every ZIP byte and append the unsigned suffix without changing the original archive. */
async function convertFirefox(context) {
  const directory = await fixture(context)
  const source = join(directory, 'browsercurl-1.2.3-firefox.zip')
  const outputDirectory = join(directory, 'packages')
  const entries = {'sidebar/index.html': strToU8('<p>Test extension</p>')}
  const bytes = firefoxZip(entries)
  await writeFile(source, bytes)
  const output = await packageFirefoxZip(source, outputDirectory)
  assert.equal(output, join(outputDirectory, 'browsercurl-1.2.3-firefox-unsigned.xpi'))
  assert.deepEqual(await readFile(output), Buffer.from(bytes))
  assert.deepEqual(await readFile(source), Buffer.from(bytes))
  assert.deepEqual(await readdir(outputDirectory), ['browsercurl-1.2.3-firefox-unsigned.xpi'])
}
test('copies Firefox ZIP bytes into an explicitly unsigned XPI', convertFirefox)

/** Reject a nested manifest and keep a previously created XPI intact. */
async function rejectNestedManifest(context) {
  const directory = await fixture(context)
  const source = join(directory, 'firefox.zip')
  const previousOutput = join(directory, 'firefox-unsigned.xpi')
  const manifestText = JSON.stringify(firefoxManifest())
  const bytes = zipSync({'extension/manifest.json': strToU8(manifestText)})
  await writeFile(source, bytes)
  await writeFile(previousOutput, 'previous package')
  await assert.rejects(packageFirefoxZip(source, directory), /manifest.json at its root/)
  assert.equal(await readFile(previousOutput, 'utf8'), 'previous package')
}
test('rejects a ZIP with a nested manifest without replacing an existing XPI', rejectNestedManifest)

/** Reject signing metadata rather than label a signed package as unsigned. */
async function rejectSignedInput(context) {
  const directory = await fixture(context)
  const source = join(directory, 'firefox.zip')
  const bytes = firefoxZip({'META-INF/mozilla.rsa': strToU8('signature metadata')})
  await writeFile(source, bytes)
  await assert.rejects(packageFirefoxZip(source, directory), /signing metadata/)
  assert.deepEqual(await readdir(directory), ['firefox.zip'])
}
test('rejects Firefox ZIPs containing signing metadata', rejectSignedInput)

/** Reject a Chromium manifest instead of creating a misleading Firefox package. */
async function rejectChromeZip(context) {
  const directory = await fixture(context)
  const source = join(directory, 'chrome.zip')
  const manifestText = JSON.stringify({manifest_version: 3, version: '1.2.3'})
  const bytes = zipSync({'manifest.json': strToU8(manifestText)})
  await writeFile(source, bytes)
  await assert.rejects(packageFirefoxZip(source, directory), /Firefox ZIP with browser_specific_settings/)
}
test('rejects Chromium ZIPs passed to Firefox packaging', rejectChromeZip)

/** Reject a corrupt ZIP before writing an XPI. */
async function rejectCorruptZip(context) {
  const directory = await fixture(context)
  const source = join(directory, 'firefox.zip')
  await writeFile(source, 'not a ZIP')
  await assert.rejects(packageFirefoxZip(source, directory), /invalid zip/i)
  assert.deepEqual(await readdir(directory), ['firefox.zip'])
}
test('rejects corrupt Firefox ZIPs without creating output', rejectCorruptZip)

/** Keep a generated key private and reuse it after Chrome launch failures, without replacing an earlier CRX. */
async function preserveKeyAndPackage(context) {
  const directory = await fixture(context)
  const build = join(directory, 'build')
  const outputDirectory = join(directory, 'packages')
  const keyPath = join(directory, 'keys', 'chromium.pem')
  const output = join(outputDirectory, 'browsercurl-1.2.3-chromium-self-signed.crx')
  const missingBinary = join(directory, 'no-chrome')
  await mkdir(build)
  await mkdir(outputDirectory)
  const manifestText = JSON.stringify({manifest_version: 3, version: '1.2.3'})
  await writeFile(join(build, 'manifest.json'), manifestText)
  await writeFile(output, 'previous CRX')
  await assert.rejects(packageChromeBuild(build, outputDirectory, keyPath, missingBinary), /Set CHROME_BINARY/)
  const firstKey = await readFile(keyPath)
  const privateKey = createPrivateKey(firstKey)
  assert.equal(privateKey.asymmetricKeyType, 'rsa')
  const keyInfo = await stat(keyPath)
  assert.equal(keyInfo.mode & 0o777, 0o600)
  await assert.rejects(packageChromeBuild(build, outputDirectory, keyPath, missingBinary), /Set CHROME_BINARY/)
  assert.deepEqual(await readFile(keyPath), firstKey)
  assert.equal(await readFile(output, 'utf8'), 'previous CRX')
}
test('preserves the private signing key and existing CRX after Chrome failures', preserveKeyAndPackage)

/** Reject keys in build or release folders before creating private files that could be published with a package. */
async function rejectPublishedKeyLocations(context) {
  const directory = await fixture(context)
  const build = join(directory, 'build')
  const outputDirectory = join(directory, 'packages')
  await mkdir(build)
  const manifestText = JSON.stringify({manifest_version: 3, version: '1.2.3'})
  await writeFile(join(build, 'manifest.json'), manifestText)
  const keyLocations = [join(build, 'signing.key'), join(outputDirectory, 'signing.key')]
  for (const keyPath of keyLocations) {
    const packaging = packageChromeBuild(build, outputDirectory, keyPath, 'unused-chrome')
    await assert.rejects(packaging, /outside the build and release output directories/)
    await assert.rejects(readFile(keyPath), {code: 'ENOENT'})
  }
}
test('rejects private key locations inside build and release folders', rejectPublishedKeyLocations)

/** Resolve a custom key symlink before packaging so its private target cannot be included in the CRX. */
async function rejectKeySymlink(context) {
  const directory = await fixture(context)
  const build = join(directory, 'build')
  const outputDirectory = join(directory, 'packages')
  await mkdir(build)
  const manifestText = JSON.stringify({manifest_version: 3, version: '1.2.3'})
  await writeFile(join(build, 'manifest.json'), manifestText)
  const original = join(build, 'signing.key')
  const alias = join(directory, 'signing.key')
  await writeFile(original, 'private key fixture')
  await symlink(original, alias, 'file')
  const packaging = packageChromeBuild(build, outputDirectory, alias, 'unused-chrome')
  await assert.rejects(packaging, /outside the build and release output directories/)
  assert.equal(await readFile(original, 'utf8'), 'private key fixture')
}
test('rejects key symlinks pointing into the packaged build', rejectKeySymlink)
