/** Remove a fixed set of generated project folders while preserving source files, dependencies, and signing keys. */
import {lstat, rm} from 'node:fs/promises'
import {join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

/**
 * Generated folders that cleanup can remove:
 * dist: browser builds, release packages, and development browser profiles.
 * .playwright: test reports and failure output.
 * coverage: generated test coverage reports.
 * .extension-js: local Extension.js session state.
 */
const GENERATED_FOLDERS = ['dist', '.playwright', 'coverage', '.extension-js']

/**
 * Remove existing generated folders beneath projectDirectory and return their names.
 * With dryRun, only inspect the targets. Validate all targets before deletion and unlink symlinks without following them.
 */
export async function cleanGeneratedFolders(projectDirectory, {dryRun = false} = {}) {
  const folders = []
  for (const folder of GENERATED_FOLDERS) {
    const target = join(projectDirectory, folder)
    let info
    try {
      info = await lstat(target)
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    const isFolderOrLink = info.isDirectory() || info.isSymbolicLink()
    if (!isFolderOrLink) throw new Error(`Refusing to remove ${folder}: expected a folder or symbolic link.`)
    folders.push(folder)
  }
  if (!dryRun) {
    for (const folder of folders) {
      const target = join(projectDirectory, folder)
      await rm(target, {recursive: true, force: true})
    }
  }
  return folders
}

/** Clean this project or list its generated folders. Reject unknown arguments before inspecting or deleting anything. */
async function main() {
  const args = process.argv.slice(2)
  const usage = 'Usage: node scripts/clean.mjs [--dry-run|--help]'
  if (args.length === 1 && args[0] === '--help') {
    console.log(usage)
    return
  }
  if (args.length > 1) throw new Error(usage)
  if (args.length === 1 && args[0] !== '--dry-run') throw new Error(usage)
  const dryRun = args[0] === '--dry-run'
  const projectDirectory = fileURLToPath(new URL('../', import.meta.url))
  const folders = await cleanGeneratedFolders(projectDirectory, {dryRun})
  if (!folders.length) {
    console.log('No generated folders to clean.')
    return
  }
  const action = dryRun ? 'Would remove' : 'Removed'
  for (const folder of folders) console.log(`${action} ${folder}/`)
}

/** Report cleanup errors and return a failing exit status. */
function reportFailure(error) {
  console.error(error.message)
  process.exitCode = 1
}

if (process.argv[1]) {
  const invokedFile = resolve(process.argv[1])
  const moduleFile = fileURLToPath(import.meta.url)
  if (invokedFile === moduleFile) void main().catch(reportFailure)
}
