/** Sort request headers by who can send them: fetch(), a network rule, or only the browser. */
import type {HeaderPair} from '../shared/http-messages'

/**
 * Headers that fetch() drops but a network rule can set.
 * The background script sets these after the browser builds the request, so the server gets the values from the editor.
 */
const RULE_HEADER_NAMES = new Set([
  'accept-charset',
  'cookie',
  'date',
  'dnt',
  'origin',
  'referer',
  'user-agent'
])

/**
 * Headers that only the browser controls.
 * The network stack calculates these values, and a changed value can break the connection or the response decoding.
 */
const BROWSER_HEADER_NAMES = new Set([
  'accept-encoding',
  'access-control-request-headers',
  'access-control-request-method',
  'connection',
  'content-length',
  'cookie2',
  'expect',
  'host',
  'keep-alive',
  'set-cookie',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'via'
])

/** Request headers after sorting. Rule header names are lowercase, and each name occurs one time. */
export interface SortedHeaders {
  fetchHeaders: HeaderPair[]
  ruleHeaders: HeaderPair[]
  skippedHeaders: string[]
}

/** Join repeated values the same way that a browser joins them in one header line. */
function joinHeaderValues(name: string, values: string[]): string {
  const separator = name === 'cookie' ? '; ' : ', '
  return values.join(separator)
}

/** Return true for headers that a network rule must set because fetch() drops them. */
function needsRule(name: string): boolean {
  return RULE_HEADER_NAMES.has(name) || name.startsWith('sec-')
}

/** Return true for headers that the browser always calculates itself. */
function isBrowserHeader(name: string): boolean {
  return BROWSER_HEADER_NAMES.has(name) || name.startsWith('proxy-')
}

/**
 * Split request headers into three groups.
 * fetchHeaders go to fetch(), ruleHeaders go to a network rule, and skippedHeaders lists names that the browser controls.
 */
export function sortRequestHeaders(headers: HeaderPair[]): SortedHeaders {
  const fetchHeaders: HeaderPair[] = []
  const ruleValues = new Map<string, string[]>()
  const skippedHeaders: string[] = []

  for (const [rawName, value] of headers) {
    const name = rawName.trim().toLowerCase()
    if (!name) continue
    if (isBrowserHeader(name)) {
      if (!skippedHeaders.includes(name)) skippedHeaders.push(name)
      continue
    }
    if (!needsRule(name)) {
      fetchHeaders.push([rawName.trim(), value])
      continue
    }
    const values = ruleValues.get(name) ?? []
    values.push(value)
    ruleValues.set(name, values)
  }

  const ruleHeaders: HeaderPair[] = []
  for (const [name, values] of ruleValues) {
    ruleHeaders.push([name, joinHeaderValues(name, values)])
  }
  return {fetchHeaders, ruleHeaders, skippedHeaders}
}
