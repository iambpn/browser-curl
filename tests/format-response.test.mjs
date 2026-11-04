/** Unit tests for response text formatting and byte counts. */
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {formatResponse, formatSize} from '../src/responses/format-response.ts'

/** Preserve text responses and support both raw and formatted JSON views. */
function responseFormatting() {
  assert.equal(formatResponse('{"ok":true}', true), '{\n  "ok": true\n}')
  assert.equal(formatResponse('{"ok":true}', false), '{"ok":true}')
  assert.equal(formatResponse('<h1>Server error</h1>', true), '<h1>Server error</h1>')
  assert.equal(formatResponse('', true), '')
}
test('formats JSON and preserves non-JSON responses', responseFormatting)

/** Check byte units at the display boundaries. */
function responseSizes() {
  assert.equal(formatSize(0), '0 B')
  assert.equal(formatSize(1023), '1023 B')
  assert.equal(formatSize(1024), '1.0 KB')
  assert.equal(formatSize(1048576), '1.0 MB')
}
test('formats response byte counts', responseSizes)
