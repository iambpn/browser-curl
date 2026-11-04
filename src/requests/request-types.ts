/** Editable HTTP request values shared by request building, cURL import, and saved editor state. */

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
