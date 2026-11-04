/** Initialize curlconverter's browser parser with the packaged, compressed Bash grammar during cURL import. */
import Parser from 'web-tree-sitter'

/** Resolve the parser runtime inside the extension without relying on the current page path. */
function locateParserFile(name: string): string {
  return chrome.runtime.getURL(name)
}

/** Read and decompress the packaged grammar. Reject missing or corrupt assets before the editor imports any values. */
async function loadBashGrammar(): Promise<Uint8Array> {
  const url = chrome.runtime.getURL('tree-sitter-bash.wasm.gz')
  const response = await fetch(url)
  if (!response.ok || !response.body) {
    throw new Error('Could not load the cURL parser. Reopen the panel and try again.')
  }
  const decompressor = new DecompressionStream('gzip')
  const stream = response.body.pipeThrough(decompressor)
  const decompressed = new Response(stream)
  const bytes = await decompressed.arrayBuffer()
  return new Uint8Array(bytes)
}

await Parser.init({locateFile: locateParserFile})
const grammarBytes = await loadBashGrammar()
const bash = await Parser.Language.load(grammarBytes)
const parser = new Parser()
parser.setLanguage(bash)

/** The initialized Bash parser that curlconverter uses to read shell commands. */
export default parser
