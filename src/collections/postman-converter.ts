/** Convert Postman files as plain data. Local storage and downloads belong to the caller. */
import type {EditorState} from '../history/request-state'
import type {RequestEntry} from '../requests/request-types'
import {parse as parsePostmanUrl} from 'postman-url-encoder/parser/index.js'

export interface ImportedRequest {editor: EditorState}
export interface ImportedFolder {name: string; requests: ImportedItem[]}
export type ImportedItem = ImportedRequest | ImportedFolder
export interface ImportedCollection extends ImportedFolder {
  postmanId?: string
  variables?: unknown[]
}

/** Export one collection. Keep a newly generated Postman ID on the input for the caller to persist. */
export function exportPostmanCollection(collection: ImportedCollection): {json: string; fileName: string} {
  collection.postmanId ||= crypto.randomUUID()
  const items = (children: ImportedItem[]): ObjectValue[] => children.map((item) => {
    if ('requests' in item) return {name: item.name, item: items(item.requests)}
    const editor = item.editor
    // The editor's blank rows are placeholders; sending also ignores keys with no text.
    const query = editor.params.filter(({key}) => key.trim()).map(({enabled, key, value}) => ({
      key: encodeQueryComponent(key), value: encodeQueryComponent(value), disabled: !enabled
    }))
    const header = editor.headers
      .filter(({key}) => editor.authType !== 'custom' || key.trim().toLowerCase() !== 'authorization')
      .map(({enabled, key, value}) => ({key, value, disabled: !enabled}))
    if (editor.authType === 'custom') {
      header.push({key: 'Authorization', value: editor.authValues['custom-authorization'] ?? '', disabled: false})
    }
    // Query rows are authoritative, even when the URL field still has an older query string.
    // Postman's SDK uses structured components, not raw, when reading a URL object.
    // Its parser keeps variable references intact, including names containing URL delimiters.
    const url = parsePostmanUrl(editor.url)
    const hash = url.hash === undefined ? '' : `#${url.hash}`
    const queryLength = url.query === undefined ? 0 : url.query.join('&').length + 1
    const address = url.raw.slice(0, url.raw.length - hash.length - queryLength)
    const search = query.filter(({disabled}) => !disabled).map(({key, value}) => `${key}=${value}`).join('&')
    const raw = address + (search ? `?${search}` : '') + hash
    return {name: editor.name, request: {
      method: editor.method, url: {...url, raw, query,
        ...(url.auth ? {auth: {user: url.auth[0], password: url.auth[1]}} : {})}, header,
      body: {mode: 'raw', raw: editor.body, options: {raw: {language: editor.bodyType === 'json' ? 'json' : 'text'}}},
      auth: exportAuth(editor)
    }}
  })
  const output: ObjectValue = {
    info: {name: collection.name, _postman_id: collection.postmanId, schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'},
    item: items(collection.requests)
  }
  if (collection.variables !== undefined) output.variable = collection.variables
  const name = collection.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
  return {json: JSON.stringify(output, null, 2), fileName: `${name}.postman_collection.json`}
}

/** Postman query text is encoded; leave variable references intact for Postman to resolve. */
function encodeQueryComponent(value: string): string {
  return value.split(/(\{\{[^{}]*\}\})/g).map((part, index) => index % 2 ? part : encodeURIComponent(part)).join('')
}

/** Export only the active credentials, never the editor's values for inactive types. */
function exportAuth(editor: EditorState): ObjectValue {
  const get = (key: string): string => editor.authValues[key] ?? ''
  let type: string
  let values: Record<string, string>
  switch (editor.authType) {
    case 'bearer':
      type = 'bearer'
      values = {token: get('bearer-token')}
      break
    case 'basic':
      type = 'basic'
      values = {username: get('basic-username'), password: get('basic-password')}
      break
    case 'api-key':
      type = 'apikey'
      values = {key: get('api-key-name'), value: get('api-key-value'), in: get('api-key-location') === 'query' ? 'query' : 'header'}
      break
    default: return {type: 'noauth'}
  }
  return {type, [type]: Object.entries(values).map(([key, value]) => ({key, value, type: 'string'}))}
}

type ObjectValue = Record<string, unknown>
function object(value: unknown): ObjectValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {}
}
function text(value: unknown): string {
  return value == null ? '' : String(value)
}

function rows(value: unknown): RequestEntry[] {
  if (!Array.isArray(value)) return []
  return value.map((entry) => {
    const row = object(entry)
    return {enabled: row.disabled !== true, key: text(row.key), value: text(row.value)}
  })
}

/** Both schema versions also allow headers as newline-separated text. */
function headerRows(value: unknown): RequestEntry[] {
  if (typeof value !== 'string') return rows(value)
  return value.split(/\r?\n/).filter((line) => line.indexOf(':') > 0).map((line) => {
    const colon = line.indexOf(':')
    return {enabled: true, key: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim()}
  })
}

/** Editor query rows hold decoded text; the request builder encodes them when sending. */
function decodeQueryComponent(value: string): string {
  try { return decodeURIComponent(value.replace(/\+/g, ' ')) } catch { return value }
}

/** Parse only the query text, so template hosts and relative addresses are never URL-validated. */
function queryRows(address: string): RequestEntry[] {
  const [beforeHash] = address.split('#')
  const question = beforeHash.indexOf('?')
  if (question === -1) return []
  return beforeHash.slice(question + 1).split('&').filter(Boolean).map((part) => {
    const equal = part.indexOf('=')
    return {enabled: true, key: decodeQueryComponent(equal === -1 ? part : part.slice(0, equal)), value: decodeQueryComponent(equal === -1 ? '' : part.slice(equal + 1))}
  })
}

function readUrl(value: unknown): {url: string; params: RequestEntry[]} {
  if (typeof value === 'string') return {url: value, params: queryRows(value)}
  const source = object(value)
  const sourceQuery = rows(source.query)
  const params = sourceQuery.map((row) => ({...row, key: decodeQueryComponent(row.key), value: decodeQueryComponent(row.value)}))
  if (typeof source.raw === 'string') {
    return {url: source.raw, params: Array.isArray(source.query) ? params : queryRows(source.raw)}
  }
  const parts = (value: unknown, separator: string): string => Array.isArray(value)
    ? value.map((part) => typeof part === 'string' ? part : text(object(part).value)).join(separator) : text(value)
  const host = parts(source.host, '.')
  const path = parts(source.path, '/')
  // Only string paths carry an optional leading separator; array entries are literal segments.
  const addressPath = Array.isArray(source.path) ? `/${path}` : (path ? `/${path.replace(/^\//, '')}` : '')
  // Reconstruct from the original text so decoded delimiters stay inside their query components.
  const query = sourceQuery.filter((row) => row.enabled).map(({key, value}) => `${key}=${value}`).join('&')
  const url = (source.protocol ? `${text(source.protocol)}://` : '') + host
    + (source.port ? `:${text(source.port)}` : '') + addressPath + (query ? `?${query}` : '')
  return {url, params}
}

/** Import a supported collection atomically; no result is returned if an item is malformed. */
export function importPostmanCollection(fileText: string): {collection: ImportedCollection; warnings: string[]} {
  let parsed: unknown
  try { parsed = JSON.parse(fileText) } catch {
    throw new Error('This file is not valid JSON. Choose a Postman Collection v2.0 or v2.1 JSON file.')
  }
  const source = object(parsed)
  const info = object(source.info)
  const schema = text(info.schema)
  if (!/^https?:\/\/schema\.(?:getpostman|postman)\.com\/(?:json\/collection\/v2\.[01]\.0\/collection\.json|collection\/json\/v2\.[01]\.0\/draft-0[47]\/collection\.json)$/.test(schema)) {
    throw new Error('Unsupported file. Choose a Postman Collection v2.0 or v2.1 JSON file (info.schema must identify that version).')
  }
  if (typeof info.name !== 'string' || !info.name.trim() || !Array.isArray(source.item)) {
    throw new Error('This JSON is not a Postman collection. It needs a collection name and an item list.')
  }
  const dropped = new Map<string, Set<string>>()
  const warn = (kind: string, name: string): void => {
    if (!dropped.has(kind)) dropped.set(kind, new Set())
    dropped.get(kind)!.add(name)
  }
  /** Group warnings by dropped feature, including all affected paths instead of repeating messages. */
  const warnDropped = (value: unknown, name: string): void => {
    if (Array.isArray(value)) { value.forEach((entry) => warnDropped(entry, name)); return }
    for (const [key, part] of Object.entries(object(value))) {
      if (part == null || part === '' || (Array.isArray(part) && !part.length)) continue
      if (key === 'event' || key === 'script') warn('Scripts and events were dropped', name)
      else if (key === 'description') warn('Descriptions were dropped', name)
      else if (key === 'response') warn('Saved example responses were dropped', name)
      else if (key === 'protocolProfileBehavior') warn('Protocol profile settings were dropped', name)
      else if (!['item', 'request', 'variable'].includes(key)) warnDropped(part, name)
    }
  }
  const readAuth = (value: unknown, editor: EditorState, name: string): void => {
    const auth = object(value)
    const type = text(auth.type)
    const attributes = auth[type]
    // v2.0 uses an object; v2.1 uses a list of key/value attributes.
    const get = (key: string): string => text(Array.isArray(attributes)
      ? object(attributes.find((entry) => object(entry).key === key)).value : object(attributes)[key])
    switch (type) {
      case '':
      case 'noauth': return
      case 'bearer':
        editor.authType = 'bearer'
        editor.authValues['bearer-token'] = get('token')
        return
      case 'basic':
        editor.authType = 'basic'
        editor.authValues['basic-username'] = get('username')
        editor.authValues['basic-password'] = get('password')
        return
      case 'apikey':
        editor.authType = 'api-key'
        editor.authValues['api-key-name'] = get('key')
        editor.authValues['api-key-value'] = get('value')
        editor.authValues['api-key-location'] = get('in') === 'query' ? 'query' : 'header'
        return
      default: warn(`Unsupported ${type} authorization was dropped; No auth is used`, name)
    }
  }
  const readItems = (items: unknown[], inheritedAuth: unknown, parent: string): ImportedItem[] => items.map((value) => {
    const item = object(value)
    if (typeof item.name !== 'string' || !item.name.trim()) throw new Error('Every Postman item needs a name.')
    const name = `${parent} / ${item.name}`
    warnDropped(item, name)
    if (Array.isArray(item.item)) return {name: item.name, requests: readItems(item.item, item.auth ?? inheritedAuth, name)}
    if ('item' in item || (typeof item.request !== 'string' && (!item.request || typeof item.request !== 'object' || Array.isArray(item.request)))) {
      throw new Error(`Postman item “${item.name}” needs a request or a folder item list.`)
    }
    const request = typeof item.request === 'string' ? {url: item.request} : object(item.request)
    warnDropped(request, name)
    const address = readUrl(request.url)
    const editor: EditorState = {
      name: item.name, method: text(request.method) || 'GET', ...address,
      headers: headerRows(request.header), body: '', bodyType: 'json', authType: 'none',
      authValues: {
        'bearer-token': '', 'basic-username': '', 'basic-password': '', 'api-key-name': '',
        'api-key-value': '', 'api-key-location': 'header', 'custom-authorization': ''
      }
    }
    const body = object(request.body)
    if (body.mode === 'raw') {
      editor.body = text(body.raw)
      editor.bodyType = object(object(body.options).raw).language === 'json' ? 'json' : 'text'
    } else if (body.mode) warn(`The ${text(body.mode)} body was dropped`, name)
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(editor.method)) {
      warn(`Unsupported method ${editor.method} was changed to GET`, name)
      editor.method = 'GET'
    }
    readAuth(request.auth ?? inheritedAuth, editor, name)
    return {editor}
  })
  warnDropped(source, info.name)
  const collection: ImportedCollection = {name: info.name, requests: readItems(source.item, source.auth, info.name)}
  if (typeof info._postman_id === 'string') collection.postmanId = info._postman_id
  if (Array.isArray(source.variable)) collection.variables = source.variable
  return {collection, warnings: [...dropped].map(([kind, names]) => `${kind} for: ${[...names].join(', ')}.`)}
}
