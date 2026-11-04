/** Verify compressed parser assets, loading on demand, and preserved drafts when parser loading fails. */
import {test, expect} from './fixtures.mjs'
import {cp, mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {
  click, echoedRequest, expectHidden, expectValue, expectVisible, fill,
  savedWorkspaceWith, send, storedWorkspace
} from './panel-helpers.mjs'

/** Load the compressed grammar only for cURL import, reuse it, and send the parsed request through the real extension. */
async function compressedGrammar({extension, api}) {
  const grammarRequests = []
  /** Record grammar loads without intercepting the packaged asset. */
  function recordGrammarRequest(request) {
    if (request.url().endsWith('/tree-sitter-bash.wasm.gz')) grammarRequests.push(request.url())
  }
  extension.context.on('request', recordGrammarRequest)
  const panel = await extension.openPanel()
  expect(grammarRequests).toEqual([])

  await fill(panel, '#request-url', `${api.origin}/echo`)
  await send(panel)
  expect(grammarRequests).toEqual([])

  const grammarLoaded = panel.waitForResponse('**/tree-sitter-bash.wasm.gz')
  const command = `curl '${api.origin}/echo?source=compressed' --json '{"compressed":true}' -H 'X-Parser: gzip'`
  await fill(panel, '#request-url', command)
  await click(panel, '#send-request')
  await expectVisible(panel, '#import-notice')
  await expectValue(panel, '#request-method', 'POST')
  await expectValue(panel, '#request-url', `${api.origin}/echo?source=compressed`)
  const response = await grammarLoaded
  expect(response.ok()).toBe(true)
  const asset = await response.body()
  expect(asset.byteLength).toBeLessThan(1024 * 1024)
  await send(panel)
  const received = await echoedRequest(panel)
  expect(received.body).toBe('{"compressed":true}')
  expect(received.headers['x-parser']).toBe('gzip')

  await fill(panel, '#request-url', `curl '${api.origin}/echo?source=reused'`)
  await click(panel, '#send-request')
  await expectValue(panel, '#request-url', `${api.origin}/echo?source=reused`)
  expect(grammarRequests).toHaveLength(1)
}
test('loads the compressed grammar on demand within the asset budget and reuses it', compressedGrammar)

for (const failure of ['missing', 'corrupt']) {
  /** Keep the full draft after a parser asset failure, and leave manual requests usable. */
  async function failedGrammarPreservesDraft({extension, api}) {
    const originalPath = extension.extensionPath
    const prefix = join(tmpdir(), 'browsercurl-parser-')
    const directory = await mkdtemp(prefix)
    try {
      await extension.close()
      await cp(originalPath, directory, {recursive: true})
      const grammarPath = join(directory, 'tree-sitter-bash.wasm.gz')
      if (failure === 'missing') await rm(grammarPath)
      else await writeFile(grammarPath, 'invalid gzip')
      extension.extensionPath = directory
      await extension.start()

      const panel = await extension.openPanel()
      await panel.locator('#request-method').selectOption('PATCH')
      await click(panel, '#body-tab')
      await fill(panel, '#request-body', '{"draft":"retained"}')
      const command = `curl '${api.origin}/echo' --json '{"imported":true}'`
      await fill(panel, '#request-url', command)
      const before = await savedWorkspaceWith(panel, 'url', command)
      await click(panel, '#send-request')
      await expectVisible(panel, '#request-error')
      await expectHidden(panel, '#import-notice')
      await expectValue(panel, '#request-method', 'PATCH')
      await expectValue(panel, '#request-body', '{"draft":"retained"}')
      await expectValue(panel, '#request-url', command)
      const after = await panel.evaluate(storedWorkspace)
      expect(after).toEqual(before)
      expect(api.requests).toEqual([])

      await fill(panel, '#request-url', `${api.origin}/echo`)
      await send(panel)
      const received = await echoedRequest(panel)
      expect(received.method).toBe('PATCH')
      expect(received.body).toBe('{"draft":"retained"}')
    } finally {
      await extension.close()
      extension.extensionPath = originalPath
      await rm(directory, {recursive: true, force: true})
    }
  }
  test(`preserves the draft and manual sending when the compressed grammar is ${failure}`, failedGrammarPreservesDraft)
}
