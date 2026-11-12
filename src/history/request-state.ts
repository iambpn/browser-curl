/** Persistent editor values and sent requests, including credentials entered by the user. */
import type {RequestEntry} from '../requests/request-types'
import type {HttpRequestPayload, HttpResultMessage} from '../requests/http-messages'

/** Every editable value, including disabled rows and credentials for inactive authorization types. */
export interface EditorState {
  name: string
  method: string
  url: string
  params: RequestEntry[]
  headers: RequestEntry[]
  body: string
  bodyType: string
  authType: string
  authValues: Record<string, string>
}

/** The collection request that Save updates. */
export interface CollectionRequestLink {
  collectionId: string
  requestId: string
}

/** An editor snapshot, its collection destination, and the saved send whose result the panel displays. */
export interface PanelSnapshot {
  editor: EditorState
  responseId?: string
  collectionRequest?: CollectionRequestLink
}

/** The current draft and an optional history preview that keeps the draft available. */
export interface WorkspaceState {
  draft: PanelSnapshot
  preview?: PanelSnapshot
}

/** One send attempt. A missing result means the background request is still running. */
export interface SavedRequest {
  id: string
  name: string
  sentAt: number
  editor: EditorState
  request: HttpRequestPayload
  result?: HttpResultMessage
}

/**
 * The short data that the history list shows for one send attempt.
 * state is running while the request has no result, response for an HTTP response, and error for a failed or canceled send.
 * httpStatus is set only when state is response.
 */
export interface HistorySummary {
  id: string
  name: string
  method: string
  url: string
  sentAt: number
  state: 'running' | 'response' | 'error'
  httpStatus?: number
}

/** Make the history list data for a saved send attempt. */
export function summarizeSavedRequest(saved: SavedRequest): HistorySummary {
  const summary: HistorySummary = {
    id: saved.id,
    name: saved.name,
    method: saved.request.method,
    url: saved.request.url,
    sentAt: saved.sentAt,
    state: saved.result?.type ?? 'running'
  }
  if (saved.result?.type === 'response') summary.httpStatus = saved.result.response.status
  return summary
}

/** Use an explicit name, the URL hostname, or an empty-editor label if the URL is invalid. */
export function resolveRequestName(name: string, address: string): string {
  const explicitName = name.trim()
  if (explicitName) return explicitName
  try {
    return new URL(address).hostname || 'Untitled request'
  } catch {
    return 'Untitled request'
  }
}
