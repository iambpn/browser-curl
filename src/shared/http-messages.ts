/** Messages that the sidebar and the background request runner exchange through a runtime port. */
import type {EditorState} from './request-state'

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

/**
 * A response that the background script read. A text body is decoded as UTF-8.
 * size is the number of body bytes that the background read. For a cut-off body, size is the maximum response size.
 */
export interface HttpResponsePayload {
  status: number
  statusText: string
  url: string
  headers: HeaderPair[]
  body: string
  size: number
  durationMs: number
  skippedHeaders: string[]
  /** True when the body was larger than the maximum response size. The body then holds only the first part. */
  isTruncated: boolean
  /** True when the Content-Type is not a text type. The body is then empty. */
  isBinary: boolean
  /** True only in history, when history did not save the body because the body was larger than the history limit. */
  isBodyOmitted?: boolean
}

/** The message that the sidebar sends after it opens a request port. */
export interface HttpSendMessage {
  type: 'send'
  id: string
  editor: EditorState
  request: HttpRequestPayload
}

/**
 * Use cancel-http-request to stop a running request by ID after a panel reopens.
 * Use delete-saved-request to remove a complete request and response from history.
 */
export type HttpControlMessage =
  | {type: 'cancel-http-request'; id: string}
  | {type: 'delete-saved-request'; id: string}

/**
 * Use response for a complete HTTP response, and error for a failed or canceled send.
 * storageError reports a result that the background could not persist.
 */
export type HttpResultMessage =
  | {type: 'response'; response: HttpResponsePayload; storageError?: string}
  | {type: 'error'; message: string; storageError?: string}
