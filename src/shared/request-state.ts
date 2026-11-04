/** Persistent editor values and sent requests, including credentials entered by the user. */
import type {RequestEntry} from '../sidebar/request'
import type {HttpRequestPayload, HttpResultMessage} from './http-messages'

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

/** An editor snapshot and the saved request whose result the panel displays. */
export interface PanelSnapshot {
  editor: EditorState
  responseId?: string
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
