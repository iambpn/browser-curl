/** Messages that the sidebar and the background request runner exchange through a runtime port. */

/** The runtime port name for one HTTP request. The sidebar opens one port for each request. */
export const HTTP_REQUEST_PORT = 'browsercurl.http-request'

/** The longest time in milliseconds that the background script waits for a complete response. */
export const REQUEST_TIMEOUT_MS = 30000

/** One request header as a name and value pair. Pairs keep the order and duplicate names. */
export type HeaderPair = [name: string, value: string]

/** A request for the background script to send. All values are plain data for extension messaging. */
export interface HttpRequestPayload {
  method: string
  url: string
  headers: HeaderPair[]
  body?: string
}

/** A complete response that the background script read. The body is decoded as UTF-8 text. */
export interface HttpResponsePayload {
  status: number
  statusText: string
  url: string
  headers: HeaderPair[]
  body: string
  size: number
  durationMs: number
  skippedHeaders: string[]
}

/** The message that the sidebar sends after it opens a request port. */
export interface HttpSendMessage {
  type: 'send'
  request: HttpRequestPayload
}

/** The message that the background script sends when the request ends. */
export type HttpResultMessage =
  | {type: 'response'; response: HttpResponsePayload}
  | {type: 'error'; message: string}
