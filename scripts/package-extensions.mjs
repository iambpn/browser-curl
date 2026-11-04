/** Convert existing Firefox ZIPs to unsigned XPIs and package Chrome builds with a reusable local signing key. */
import {spawnSync} from 'node:child_process'
import {generateKeyPairSync} from 'node:crypto'
import {access, cp, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {basename, dirname, extname, isAbsolute, join, relative, resolve, sep} from 'node:path'
import {fileURLToPath} from 'node:url'
import {strFromU8, unzipSync} from 'fflate'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))

/** Validate the package version before including it in an output filename. Return the extension version string. */
function packageVersion(manifest) {
  const version = manifest?.version
  const isNumericVersion = typeof version === 'string' && /^\d+(?:\.\d+){0,3}$/.test(version)
  if (!isNumericVersion) {
    throw new Error('The extension manifest must contain a numeric version, such as 1.0.0.')
  }
  return version
}

/** Publish complete package bytes atomically. Keep an earlier output intact on failure and remove temporary files. */
async function writePackage(bytes, outputPath) {
  const directory = dirname(outputPath)
  await mkdir(directory, {recursive: true})
  const temporary = await mkdtemp(join(directory, '.package-'))
  try {
    const staged = join(temporary, 'package')
    await writeFile(staged, bytes)
    await rename(staged, outputPath)
  } finally {
    await rm(temporary, {recursive: true, force: true})
  }
  return outputPath
}

/** Validate an unsigned Firefox ZIP and copy its exact bytes to <zip-name>-unsigned.xpi in the output directory. */
export async function packageFirefoxZip(zipPath, outputDirectory) {
  if (extname(zipPath).toLowerCase() !== '.zip') throw new Error('The Firefox input must be a .zip file.')
  const bytes = await readFile(zipPath)
  const files = unzipSync(bytes)
  const manifestBytes = files['manifest.json']
  if (!manifestBytes) throw new Error('The Firefox ZIP must contain manifest.json at its root.')
  const manifestText = strFromU8(manifestBytes)
  const manifest = JSON.parse(manifestText)
  packageVersion(manifest)
  if (!manifest.browser_specific_settings?.gecko?.id) {
    throw new Error('Use a Firefox ZIP with browser_specific_settings.gecko.id in its manifest.')
  }
  for (const filename of Object.keys(files)) {
    if (filename.toLowerCase().startsWith('meta-inf/')) {
      throw new Error('The Firefox ZIP contains signing metadata. Use an unsigned build.')
    }
  }
  const extension = extname(zipPath)
  const name = basename(zipPath, extension)
  const outputPath = join(outputDirectory, `${name}-unsigned.xpi`)
  return writePackage(bytes, outputPath)
}

/** Resolve symlinks in existing path components, including parents of a key or output directory that does not exist yet. */
async function resolvePackagePath(path) {
  const absolute = resolve(path)
  try {
    return await realpath(absolute)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    const parent = dirname(absolute)
    if (parent === absolute) throw error
    const resolvedParent = await resolvePackagePath(parent)
    return join(resolvedParent, basename(absolute))
  }
}

/** Reject private keys inside package inputs or release outputs before creating a key or copying the build. */
async function validateSigningKeyLocation(buildDirectory, outputDirectory, keyPath) {
  const resolvedKey = await resolvePackagePath(keyPath)
  for (const directory of [buildDirectory, outputDirectory]) {
    const resolvedDirectory = await resolvePackagePath(directory)
    const keyLocation = relative(resolvedDirectory, resolvedKey)
    const isParentPath = keyLocation === '..' || keyLocation.startsWith(`..${sep}`)
    const isOtherDrive = isAbsolute(keyLocation)
    if (!isParentPath && !isOtherDrive) {
      throw new Error('Store the Chrome signing key outside the build and release output directories.')
    }
  }
}

/** Reuse an existing private key or generate a private RSA key with owner-only permissions. Never overwrite a key. */
async function ensureSigningKey(keyPath) {
  try {
    await access(keyPath)
    return
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  await mkdir(dirname(keyPath), {recursive: true, mode: 0o700})
  const {privateKey} = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: {type: 'pkcs8', format: 'pem'}
  })
  await writeFile(keyPath, privateKey, {flag: 'wx', mode: 0o600})
}

/** Run Chrome's official pack command without a shell. Report launch failures and leave generated files in the temporary directory. */
function packWithChrome(binary, buildDirectory, keyPath, profileDirectory) {
  const result = spawnSync(binary, [
    '--headless', '--no-message-box', '--no-first-run',
    `--user-data-dir=${profileDirectory}`,
    `--pack-extension=${buildDirectory}`,
    `--pack-extension-key=${keyPath}`
  ], {encoding: 'utf8', timeout: 30000})
  if (result.error) {
    throw new Error('Could not run Chrome. Set CHROME_BINARY to a Chrome or Chromium executable.', {cause: result.error})
  }
  if (result.status !== 0) {
    const details = result.stderr.trim() || result.stdout.trim()
    throw new Error(`Chrome could not create the CRX package. ${details}`)
  }
}

/** Package an existing Chromium build as CRX3 using Chrome and a persistent private key. Preserve the build and clean up staging files. */
export async function packageChromeBuild(buildDirectory, outputDirectory, keyPath, chromeBinary) {
  const manifestPath = join(buildDirectory, 'manifest.json')
  const manifestText = await readFile(manifestPath, 'utf8')
  const manifest = JSON.parse(manifestText)
  const version = packageVersion(manifest)
  if (manifest.manifest_version !== 3) throw new Error('Use a Chromium build with Manifest V3.')
  await validateSigningKeyLocation(buildDirectory, outputDirectory, keyPath)
  await ensureSigningKey(keyPath)
  const prefix = join(tmpdir(), 'browsercurl-pack-')
  const temporary = await mkdtemp(prefix)
  try {
    const stagedBuild = join(temporary, 'extension')
    await cp(buildDirectory, stagedBuild, {recursive: true})
    const profileDirectory = join(temporary, 'profile')
    packWithChrome(chromeBinary, stagedBuild, keyPath, profileDirectory)
    const bytes = await readFile(`${stagedBuild}.crx`)
    if (bytes.length < 12) throw new Error('Chrome did not create a valid CRX3 package.')
    const magic = bytes.toString('ascii', 0, 4)
    const crxVersion = bytes.readUInt32LE(4)
    const isCrx3 = magic === 'Cr24' && crxVersion === 3
    if (!isCrx3) {
      throw new Error('Chrome did not create a valid CRX3 package.')
    }
    const outputPath = join(outputDirectory, `browsercurl-${version}-chromium-self-signed.crx`)
    return await writePackage(bytes, outputPath)
  } finally {
    await rm(temporary, {recursive: true, force: true})
  }
}

/** Package existing inputs from the project root, or use the supplied path for one browser. Do not rebuild or upload releases. */
async function main() {
  const [target = 'all', input, ...extra] = process.argv.slice(2)
  const usage = 'Usage: node scripts/package-extensions.mjs [all|firefox|chrome] [input path]'
  if (target === '--help') {
    console.log(usage)
    return
  }
  const isKnownTarget = ['all', 'firefox', 'chrome'].includes(target)
  if (!isKnownTarget || extra.length) throw new Error(usage)
  if (target === 'all' && input) throw new Error('Specify firefox or chrome when providing an input path.')
  const packagePath = join(projectRoot, 'package.json')
  const packageText = await readFile(packagePath, 'utf8')
  const {version} = JSON.parse(packageText)
  const outputDirectory = join(projectRoot, 'dist', 'releases')
  if (target === 'all' || target === 'firefox') {
    const defaultZip = join(outputDirectory, `browsercurl-${version}-firefox.zip`)
    const zipPath = input ? resolve(input) : defaultZip
    const output = await packageFirefoxZip(zipPath, outputDirectory)
    console.log(`Created ${output}`)
  }
  if (target === 'all' || target === 'chrome') {
    const buildDirectory = input ? resolve(input) : join(projectRoot, 'dist', 'chromium')
    const defaultKey = join(projectRoot, '.keys', 'chromium.pem')
    const keyPath = resolve(process.env.CRX_KEY_PATH ?? defaultKey)
    const binary = process.env.CHROME_BINARY ?? 'google-chrome'
    const output = await packageChromeBuild(buildDirectory, outputDirectory, keyPath, binary)
    console.log(`Created ${output}`)
    console.log(`Chrome signing key: ${keyPath}. Keep this file private and reuse it for updates.`)
  }
}

/** Report a packaging failure without exposing private key contents and return a failing process status. */
function reportFailure(error) {
  console.error(error.message)
  process.exitCode = 1
}

if (process.argv[1]) {
  const invokedFile = resolve(process.argv[1])
  const moduleFile = fileURLToPath(import.meta.url)
  if (invokedFile === moduleFile) void main().catch(reportFailure)
}
