/** Unit tests for sorting request headers into fetch, rule, and browser-controlled groups. */
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {sortRequestHeaders} from '../src/requests/locked-headers.ts'

/** Check each group and the order of normal headers. */
function headerGroups() {
  const sorted = sortRequestHeaders([
    ['Content-Type', 'application/json'],
    ['Cookie', 'a=1'],
    ['Host', 'example.com'],
    ['X-Test', 'yes'],
    ['User-Agent', 'curl/8'],
    ['Origin', 'https://app.example'],
    ['sec-ch-ua', '"Chromium"'],
    ['Content-Length', '12'],
    ['Proxy-Authorization', 'secret']
  ])
  assert.deepEqual(sorted.fetchHeaders, [
    ['Content-Type', 'application/json'],
    ['X-Test', 'yes']
  ])
  assert.deepEqual(sorted.ruleHeaders, [
    ['cookie', 'a=1'],
    ['user-agent', 'curl/8'],
    ['origin', 'https://app.example'],
    ['sec-ch-ua', '"Chromium"']
  ])
  assert.deepEqual(sorted.skippedHeaders, ['host', 'content-length', 'proxy-authorization'])
}
test('sorts headers by who can send them', headerGroups)

/** Check that repeated rule headers become one header line with the browser's separator. */
function repeatedRuleHeaders() {
  const sorted = sortRequestHeaders([
    ['Cookie', 'a=1'],
    ['cookie', 'b=2'],
    ['Referer', 'https://one.example'],
    ['DNT', '1'],
    ['dnt', '0'],
    ['', 'ignored']
  ])
  assert.deepEqual(sorted.ruleHeaders, [
    ['cookie', 'a=1; b=2'],
    ['referer', 'https://one.example'],
    ['dnt', '1, 0']
  ])
  assert.deepEqual(sorted.fetchHeaders, [])
}
test('joins repeated rule headers', repeatedRuleHeaders)
