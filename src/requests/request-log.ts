/** Describe a sent request as text for the response viewer's Request tab. */
import {sortRequestHeaders} from './locked-headers.ts'
import type {HeaderPair, HttpRequestPayload} from './http-messages'

/** The lowercase name of the header that identifies the browser. */
const USER_AGENT_HEADER = 'user-agent'

/**
 * Return the headers that reach the server, in the order the editor sent them.
 * Headers that the browser controls, such as Host, are left out because the browser replaces them.
 * When the editor has no User-Agent, the browser sends its own, so the log adds browserUserAgent.
 */
export function sentRequestHeaders(request: HttpRequestPayload, browserUserAgent: string): HeaderPair[] {
  const {skippedHeaders} = sortRequestHeaders(request.headers)
  const browserHeaders = new Set(skippedHeaders)
  const headers: HeaderPair[] = []
  let hasUserAgent = false
  for (const [rawName, value] of request.headers) {
    const name = rawName.trim().toLowerCase()
    if (!name || browserHeaders.has(name)) continue
    if (name === USER_AGENT_HEADER) hasUserAgent = true
    headers.push([name, value])
  }
  if (!hasUserAgent) headers.push([USER_AGENT_HEADER, browserUserAgent])
  return headers
}

/**
 * Return the headers for the Request tab.
 * reportedHeaders are the headers that the browser reported as sent. They come first, in the browser's order.
 * The browser does not report some headers, such as Authorization, so editor headers missing from that list follow.
 * Without reportedHeaders, the list holds the editor headers and the browser's User-Agent.
 */
export function requestLogHeaders(
  request: HttpRequestPayload,
  browserUserAgent: string,
  reportedHeaders?: HeaderPair[]
): HeaderPair[] {
  const editorHeaders = sentRequestHeaders(request, browserUserAgent)
  if (!reportedHeaders) return editorHeaders
  const reportedNames = new Set(reportedHeaders.map(([name]) => name))
  const unreportedHeaders = editorHeaders.filter(([name]) => !reportedNames.has(name))
  return [...reportedHeaders, ...unreportedHeaders]
}

/**
 * Format a sent request like an HTTP message: the method and URL, then one `name: value` line per header,
 * then the body after a blank line when the request has one.
 * reportedHeaders are the headers that the browser reported as sent, as requestLogHeaders describes.
 */
export function formatRequestLog(
  request: HttpRequestPayload,
  browserUserAgent: string,
  reportedHeaders?: HeaderPair[]
): string {
  const lines = [`${request.method} ${request.url}`, '']
  const headers = requestLogHeaders(request, browserUserAgent, reportedHeaders)
  for (const [name, value] of headers) lines.push(`${name}: ${value}`)
  if (request.body) lines.push('', request.body)
  return lines.join('\n')
}
