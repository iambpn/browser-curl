/**
 * Convert a pasted cURL command into request editor values.
 * curlconverter parses the shell syntax and curl options, and it returns the request as HAR data.
 * The sidebar loads this module only when the user pastes a cURL command, because the parser loads WebAssembly files.
 */
import {toHarStringWarn} from 'curlconverter/dist/src/generators/har.js'
import type {RequestAuthorization, RequestDraft, RequestEntry} from './request-types'

/** One name and value pair in HAR data. */
interface HarPair {
  name: string
  value: string
}

/** The HAR request fields that the import uses. */
interface HarRequest {
  method: string
  url: string
  headers: HarPair[]
  cookies: HarPair[]
  queryString: HarPair[]
  postData?: {mimeType: string; text?: string; params?: HarPair[]}
}

/** The editor values from a cURL command and the curl options that the editor cannot use. */
export interface CurlImport {
  draft: RequestDraft
  warnings: string[]
}

/** curlconverter warning codes that do not apply, because the sidebar keeps every repeated header. */
const IGNORED_WARNINGS = new Set(['repeated-header'])

/** Read the first request from curlconverter's HAR output. */
function readHarRequest(command: string): {request: HarRequest; warnings: string[]} {
  const [harText, rawWarnings] = toHarStringWarn(command)
  const har = JSON.parse(harText)
  const request: HarRequest | undefined = har.log?.entries?.[0]?.request
  if (!request) throw new Error('The cURL command has no URL.')
  const warnings: string[] = []
  for (const [code, message] of rawWarnings) {
    if (!IGNORED_WARNINGS.has(code)) warnings.push(message)
  }
  return {request, warnings}
}

/** Rebuild the full URL, because HAR stores the query string separately. */
function fullUrl(request: HarRequest): string {
  const url = new URL(request.url)
  for (const {name, value} of request.queryString) url.searchParams.append(name, value)
  return url.href
}

/** Decode Basic credentials as UTF-8. Return undefined when the editor cannot show them as Basic auth. */
function decodeBasicCredentials(encoded: string): RequestAuthorization | undefined {
  let decoded: string
  try {
    const binary = atob(encoded)
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    decoded = new TextDecoder('utf-8', {fatal: true}).decode(bytes)
  } catch {
    return undefined
  }
  const separator = decoded.indexOf(':')
  if (separator < 0) return undefined
  const username = decoded.slice(0, separator)
  const password = decoded.slice(separator + 1)
  return {type: 'basic', username, password}
}

/** Show an Authorization header in the Authorization tab with the matching type. */
function authorizationFromHeader(value: string): RequestAuthorization {
  const [scheme, ...rest] = value.trim().split(/\s+/)
  const credentials = rest.join(' ')
  const lowerScheme = scheme.toLowerCase()
  if (lowerScheme === 'bearer' && credentials) return {type: 'bearer', token: credentials}
  if (lowerScheme === 'basic') {
    const basic = decodeBasicCredentials(credentials)
    if (basic) return basic
  }
  return {type: 'custom', value: value.trim()}
}

/** Move the first Authorization header to the Authorization tab and keep all other headers in order. */
function splitAuthorization(headers: HarPair[]): {
  authorization: RequestAuthorization
  headers: RequestEntry[]
} {
  let authorization: RequestAuthorization = {type: 'none'}
  const entries: RequestEntry[] = []
  for (const {name, value} of headers) {
    const isFirstAuthorization = authorization.type === 'none' && name.toLowerCase() === 'authorization'
    if (isFirstAuthorization) {
      authorization = authorizationFromHeader(value)
      continue
    }
    entries.push({enabled: true, key: name, value})
  }
  return {authorization, headers: entries}
}

/** Read the body text. HAR splits form data into fields, so this joins the fields again. */
function bodyText(request: HarRequest): string {
  const postData = request.postData
  if (!postData) return ''
  if (postData.text !== undefined) return postData.text
  const form = new URLSearchParams()
  for (const {name, value} of postData.params ?? []) form.append(name, value)
  return form.toString()
}

/** Use the JSON editor only for valid JSON, so the editor can send every other body unchanged. */
function bodyType(body: string): string {
  if (!body) return 'json'
  try {
    JSON.parse(body)
    return 'json'
  } catch {
    return 'text'
  }
}

/**
 * Parse a cURL command and return the editor values.
 * Throws an error if the text is not a cURL command with a URL.
 */
export function importCurlCommand(command: string): CurlImport {
  const {request, warnings} = readHarRequest(command)
  const {authorization, headers} = splitAuthorization(request.headers)
  if (request.cookies.length) {
    const cookiePairs = request.cookies.map(({name, value}) => `${name}=${value}`)
    headers.push({enabled: true, key: 'Cookie', value: cookiePairs.join('; ')})
  }
  const params = request.queryString.map(({name, value}) => ({enabled: true, key: name, value}))
  const body = bodyText(request)

  const draft: RequestDraft = {
    method: request.method.toUpperCase(),
    url: fullUrl(request),
    params,
    headers,
    body,
    bodyType: bodyType(body),
    authorization
  }
  return {draft, warnings}
}

/** Return "1 header" or "2 headers" for the import summary. */
function countLabel(count: number, singular: string, plural: string): string {
  const noun = count === 1 ? singular : plural
  return `${count} ${noun}`
}

/** The Authorization tab names for the import summary, by authorization type. */
const AUTHORIZATION_LABELS: Record<RequestAuthorization['type'], string> = {
  none: '',
  bearer: 'a Bearer token',
  basic: 'Basic auth',
  'api-key': 'an API key',
  custom: 'a custom Authorization header'
}

/** Describe the imported values in one sentence, such as "Imported the POST request with 2 headers and a JSON body." */
export function describeImport(draft: RequestDraft): string {
  const parts: string[] = []
  if (draft.params.length) parts.push(countLabel(draft.params.length, 'query parameter', 'query parameters'))
  if (draft.headers.length) parts.push(countLabel(draft.headers.length, 'header', 'headers'))
  if (draft.body) parts.push(draft.bodyType === 'json' ? 'a JSON body' : 'a text body')
  const authorization = AUTHORIZATION_LABELS[draft.authorization.type]
  if (authorization) parts.push(authorization)

  const request = `Imported the ${draft.method} request`
  if (!parts.length) return `${request}.`
  if (parts.length === 1) return `${request} with ${parts[0]}.`
  if (parts.length === 2) return `${request} with ${parts[0]} and ${parts[1]}.`
  const last = parts.pop()
  return `${request} with ${parts.join(', ')}, and ${last}.`
}
