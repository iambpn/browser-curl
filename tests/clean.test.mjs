/** Verify generated-folder cleanup, preview behavior, preserved project data, and safe handling of invalid targets and symlinks. */
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {test} from 'node:test'
import {cleanGeneratedFolders} from '../scripts/clean.mjs'

/** Create an isolated project directory and remove it after the test finishes. */
async function fixture(context) {
  const prefix = join(tmpdir(), 'browsercurl-clean-test-')
  const directory = await mkdtemp(prefix)
  /** Remove the isolated test project, including files that cleanup must preserve. */
  async function cleanup() {
    await rm(directory, {recursive: true, force: true})
  }
  context.after(cleanup)
  return directory
}

/** Write a fixture file and create its parent directory. */
async function fixtureFile(directory, name, content = 'keep this file') {
  const target = join(directory, name)
  await mkdir(dirname(target), {recursive: true})
  await writeFile(target, content)
}

/** Copy the real CLI into a temporary project so subprocess tests can never delete the working project's output. */
async function cliFixture(context) {
  const directory = await fixture(context)
  const original = fileURLToPath(new URL('../scripts/clean.mjs', import.meta.url))
  const source = await readFile(original, 'utf8')
  await fixtureFile(directory, 'scripts/clean.mjs', source)
  await fixtureFile(directory, 'dist/package.zip', 'existing package')
  return {directory, script: join(directory, 'scripts', 'clean.mjs')}
}

/** Remove generated output while preserving signing keys, installed dependencies, source files, and project configuration. */
async function cleanOutput(context) {
  const directory = await fixture(context)
  const generated = ['dist', '.playwright', 'coverage', '.extension-js']
  for (const folder of generated) await fixtureFile(directory, `${folder}/nested/output`)
  const preserved = ['.keys/chromium.pem', 'node_modules/dependency/index.js', 'src/app.ts', 'package.json']
  for (const name of preserved) await fixtureFile(directory, name)
  const removed = await cleanGeneratedFolders(directory)
  assert.deepEqual(removed, generated)
  for (const folder of generated) {
    await assert.rejects(lstat(join(directory, folder)), {code: 'ENOENT'})
  }
  for (const name of preserved) {
    const content = await readFile(join(directory, name), 'utf8')
    assert.equal(content, 'keep this file')
  }
  assert.deepEqual(await cleanGeneratedFolders(directory), [])
}
test('cleans generated folders, preserves project data, and permits repeated cleanup', cleanOutput)

/** List existing generated folders without changing their contents. */
async function previewCleanup(context) {
  const directory = await fixture(context)
  await fixtureFile(directory, 'dist/releases/extension.xpi', 'package bytes')
  await fixtureFile(directory, '.playwright/results/report.txt', 'test report')
  const folders = await cleanGeneratedFolders(directory, {dryRun: true})
  assert.deepEqual(folders, ['dist', '.playwright'])
  const packageBytes = await readFile(join(directory, 'dist/releases/extension.xpi'), 'utf8')
  assert.equal(packageBytes, 'package bytes')
  const report = await readFile(join(directory, '.playwright/results/report.txt'), 'utf8')
  assert.equal(report, 'test report')
}
test('dry run lists targets without deleting packages or test reports', previewCleanup)

/** Reject an unexpected regular file before removing any generated folder. */
async function rejectUnexpectedFile(context) {
  const directory = await fixture(context)
  await fixtureFile(directory, 'dist/keep.txt', 'existing build')
  await fixtureFile(directory, 'coverage', 'unrelated file')
  await assert.rejects(cleanGeneratedFolders(directory), /Refusing to remove coverage/)
  const build = await readFile(join(directory, 'dist/keep.txt'), 'utf8')
  assert.equal(build, 'existing build')
  const unexpectedFile = await readFile(join(directory, 'coverage'), 'utf8')
  assert.equal(unexpectedFile, 'unrelated file')
}
test('validates every cleanup target before deleting anything', rejectUnexpectedFile)

/** Remove a generated-folder symlink without following it into signing keys or other project data. */
async function unlinkGeneratedFolder(context) {
  const directory = await fixture(context)
  const project = join(directory, 'project')
  const keys = join(directory, 'keys')
  await mkdir(project)
  await fixtureFile(keys, 'chromium.pem', 'preserved key')
  await symlink(keys, join(project, 'dist'), 'junction')
  assert.deepEqual(await cleanGeneratedFolders(project), ['dist'])
  const key = await readFile(join(keys, 'chromium.pem'), 'utf8')
  assert.equal(key, 'preserved key')
  assert.deepEqual(await readdir(project), [])
}
test('unlinks generated-folder symlinks without deleting their targets', unlinkGeneratedFolder)

/** Reject a mistyped CLI option before any project cleanup runs. */
async function rejectUnknownOption(context) {
  const {directory, script} = await cliFixture(context)
  const result = spawnSync(process.execPath, [script, '--unknown'], {encoding: 'utf8'})
  assert.ifError(result.error)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Usage: node scripts\/clean.mjs/)
  const packageBytes = await readFile(join(directory, 'dist/package.zip'), 'utf8')
  assert.equal(packageBytes, 'existing package')
}
test('cleanup CLI rejects unknown options', rejectUnknownOption)

/** Run the complete CLI from another working directory and preserve the temporary project's signing key. */
async function runCleanupCli(context) {
  const {directory, script} = await cliFixture(context)
  await fixtureFile(directory, '.keys/chromium.pem', 'preserved key')
  const preview = spawnSync(process.execPath, [script, '--dry-run'], {encoding: 'utf8', cwd: tmpdir()})
  assert.ifError(preview.error)
  assert.equal(preview.status, 0, preview.stderr)
  assert.match(preview.stdout, /Would remove dist\//)
  const packageBytes = await readFile(join(directory, 'dist/package.zip'), 'utf8')
  assert.equal(packageBytes, 'existing package')
  const cleaned = spawnSync(process.execPath, [script], {encoding: 'utf8', cwd: tmpdir()})
  assert.ifError(cleaned.error)
  assert.equal(cleaned.status, 0, cleaned.stderr)
  assert.match(cleaned.stdout, /Removed dist\//)
  await assert.rejects(lstat(join(directory, 'dist')), {code: 'ENOENT'})
  const key = await readFile(join(directory, '.keys/chromium.pem'), 'utf8')
  assert.equal(key, 'preserved key')
}
test('cleanup CLI previews and deletes only its own project output', runCleanupCli)
