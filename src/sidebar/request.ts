/** Build HTTP requests and format response text for the sidebar. */

/** An editable query parameter or header. Disabled entries stay in the editor. */
export interface RequestEntry {
  enabled: boolean
  key: string
  value: string
}

/**
 * Authorization sent with the request.
 * Use none for manual headers, bearer for access tokens, basic for credentials,
 * api-key for a header or query key, and custom for a complete Authorization value.
 */
export type RequestAuthorization =
  | {type: 'none'}
  | {type: 'bearer'; token: string}
  | {type: 'basic'; username: string; password: string}
  | {type: 'api-key'; key: string; value: string; location: 'header' | 'query'}
  | {type: 'custom'; value: string}

/** The current request editor values, including the selected authorization. */
export interface RequestDraft {
  method: string
  url: string
  params: RequestEntry[]
  headers: RequestEntry[]
  body: string
  bodyType: string
  authorization: RequestAuthorization
}

/** Encode Basic credentials as UTF-8 bytes before converting them to Base64. */
function encodeBasicCredentials(username: string, password: string): string {
  if (username.includes(':')) {
    throw new Error('A Basic auth username cannot contain a colon.')
  }
  const bytes = new TextEncoder().encode(`${username}:${password}`)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** Apply the selected authorization after manual headers and query parameters. */
function applyAuthorization(
  authorization: RequestAuthorization,
  url: URL,
  headers: Headers
): void {
  switch (authorization.type) {
    case 'none':
      return
    case 'bearer': {
      const token = authorization.token.trim()
      if (token) headers.set('Authorization', `Bearer ${token}`)
      return
    }
    case 'basic': {
      const credentials = encodeBasicCredentials(authorization.username, authorization.password)
      headers.set('Authorization', `Basic ${credentials}`)
      return
    }
    case 'api-key': {
      const key = authorization.key.trim()
      if (!key) throw new Error('Enter a key name in the Authorization tab.')
      if (authorization.location === 'query') {
        url.searchParams.set(key, authorization.value)
      } else {
        headers.set(key, authorization.value)
      }
      return
    }
    case 'custom': {
      const value = authorization.value.trim()
      if (value) headers.set('Authorization', value)
    }
  }
}

/** Validate an HTTP URL without allowing credentials in the address. */
export function parseRequestUrl(address: string): URL {
  const url = new URL(address.trim())
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Use an http:// or https:// URL.')
  }
  if (url.username || url.password) {
    throw new Error('Remove credentials from the URL. Use the Authorization tab.')
  }
  return url
}

/** Build a fetch request from enabled rows without changing the editor values. */
export function buildRequest(draft: RequestDraft): {url: URL; init: RequestInit} {
  const url = parseRequestUrl(draft.url)
  url.search = ''
  url.hash = ''
  for (const entry of draft.params) {
    if (entry.enabled && entry.key.trim()) {
      url.searchParams.append(entry.key, entry.value)
    }
  }

  const headers = new Headers()
  for (const entry of draft.headers) {
    if (entry.enabled && entry.key.trim()) {
      headers.append(entry.key.trim(), entry.value)
    }
  }
  applyAuthorization(draft.authorization, url, headers)

  const init: RequestInit = {method: draft.method, headers, credentials: 'omit'}
  const allowsBody = draft.method !== 'GET' && draft.method !== 'HEAD'
  if (allowsBody && draft.body) {
    if (draft.bodyType === 'json') JSON.parse(draft.body)
    if (!headers.has('Content-Type')) {
      const contentType = draft.bodyType === 'json' ? 'application/json' : 'text/plain'
      headers.set('Content-Type', contentType)
    }
    init.body = draft.body
  }
  return {url, init}
}

/** Format JSON when requested and leave other response formats unchanged. */
export function formatResponse(body: string, pretty: boolean): string {
  if (!pretty || !body) return body
  try {
    const parsed = JSON.parse(body)
    return JSON.stringify(parsed, null, 2)
  } catch {
    return body
  }
}

/** Display the response body's byte count with a compact unit. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kilobytes = bytes / 1024
  if (kilobytes < 1024) return `${kilobytes.toFixed(1)} KB`
  const megabytes = kilobytes / 1024
  return `${megabytes.toFixed(1)} MB`
}
