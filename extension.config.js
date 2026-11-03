/** Extension.js settings: browser profiles and the extra cURL parser files. */
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {dirname, join} from 'node:path'

// Extension.js uses a fresh profile on every run.
// Prefer that default? Remove the profile config below.
const profile = (name) => `./dist/extension-profile-${name}`

const require = createRequire(import.meta.url)
const curlconverterEntry = require.resolve('curlconverter')
const curlconverterRequire = createRequire(curlconverterEntry)
const webTreeSitterEntry = curlconverterRequire.resolve('web-tree-sitter')

/**
 * WebAssembly files that curlconverter loads from the extension root, as "/tree-sitter.wasm" and "/tree-sitter-bash.wasm".
 * The keys are output names, and the values are the source paths in node_modules.
 */
const curlParserFiles = {
  'tree-sitter.wasm': join(dirname(webTreeSitterEntry), 'tree-sitter.wasm'),
  'tree-sitter-bash.wasm': join(dirname(curlconverterEntry), '..', 'tree-sitter-bash.wasm')
}

/** Rspack plugin that adds the cURL parser's WebAssembly files to the root of each build. */
class CurlParserFilesPlugin {
  /** Add the files when the compiler creates the build assets. */
  apply(compiler) {
    const {Compilation, sources} = compiler.webpack
    const name = 'CurlParserFilesPlugin'

    /** Add each WebAssembly file as an asset of the current compilation. */
    function addParserFiles(compilation) {
      /** Read each file from node_modules and add it to the build output. */
      function emitParserFiles() {
        for (const [outputName, sourcePath] of Object.entries(curlParserFiles)) {
          const content = readFileSync(sourcePath)
          compilation.emitAsset(outputName, new sources.RawSource(content))
        }
      }
      const stage = Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL
      compilation.hooks.processAssets.tap({name, stage}, emitParserFiles)
    }
    compiler.hooks.thisCompilation.tap(name, addParserFiles)
  }
}

/** @type {import('extension').FileConfig} */
export default {
  browser: {
    chrome: {profile: profile('chrome')},
    chromium: {profile: profile('chromium')},
    edge: {profile: profile('edge')},
    firefox: {profile: profile('firefox')},
    'chromium-based': {profile: profile('chromium-based')},
    'gecko-based': {profile: profile('gecko-based')}
  },
  /** Add the cURL parser files to the Rspack config that Extension.js builds. */
  config(config) {
    config.plugins = [...(config.plugins ?? []), new CurlParserFilesPlugin()]
    return config
  }
}
