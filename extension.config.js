/** Extension.js settings: browser profiles and the extra cURL parser files. */
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {dirname, join} from 'node:path'
import {gzipSync} from 'node:zlib'

// Extension.js uses a fresh profile on every run.
// Prefer that default? Remove the profile config below.
const profile = (name) => `./dist/extension-profile-${name}`

const require = createRequire(import.meta.url)
const curlconverterEntry = require.resolve('curlconverter')
const webTreeSitterEntry = require.resolve('web-tree-sitter')
const browserParserEntry = join(dirname(curlconverterEntry), 'shell', 'webParser.js')
const compressedParserEntry = join(import.meta.dirname, 'src', 'requests', 'curl-parser.ts')

/**
 * Parser assets at the extension root. tree-sitter.wasm initializes the parser runtime.
 * tree-sitter-bash.wasm.gz holds the compressed Bash grammar, which the browser decompresses only during cURL import.
 * The keys are output names, and the values are the uncompressed source paths in node_modules.
 */
const curlParserFiles = {
  'tree-sitter.wasm': join(dirname(webTreeSitterEntry), 'tree-sitter.wasm'),
  'tree-sitter-bash.wasm.gz': join(dirname(curlconverterEntry), '..', 'tree-sitter-bash.wasm')
}

/** Add the parser runtime and compressed Bash grammar to the root of each build. */
class CurlParserFilesPlugin {
  /** Add the files when the compiler creates the build assets. */
  apply(compiler) {
    const {Compilation, sources} = compiler.webpack
    const name = 'CurlParserFilesPlugin'

    /** Register the parser assets for the current compilation. */
    function addParserFiles(compilation) {
      /** Read each parser file, compress the grammar, and add the asset to the build output. */
      function emitParserFiles() {
        for (const [outputName, sourcePath] of Object.entries(curlParserFiles)) {
          const content = readFileSync(sourcePath)
          const output = outputName.endsWith('.gz') ? gzipSync(content, {level: 9}) : content
          compilation.emitAsset(outputName, new sources.RawSource(output))
        }
      }
      const stage = Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL
      compilation.hooks.processAssets.tap({name, stage}, emitParserFiles)
    }
    compiler.hooks.thisCompilation.tap(name, addParserFiles)
  }
}

/**
 * Browser profiles and parser assets, with the default extension performance budgets.
 * @type {import('extension').FileConfig}
 */
export default {
  browser: {
    chrome: {profile: profile('chrome')},
    chromium: {profile: profile('chromium')},
    edge: {profile: profile('edge')},
    firefox: {profile: profile('firefox')},
    'chromium-based': {profile: profile('chromium-based')},
    'gecko-based': {profile: profile('gecko-based')}
  },
  /** Use the compressed grammar loader and emit its assets while keeping the default performance budgets. */
  config(config) {
    config.resolve ??= {}
    config.resolve.alias = {
      ...(config.resolve.alias ?? {}),
      [browserParserEntry + '$']: compressedParserEntry
    }
    config.plugins = [...(config.plugins ?? []), new CurlParserFilesPlugin()]
    return config
  }
}
