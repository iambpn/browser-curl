/** The sidebar's request editor and response viewer. */
import {controlSavedRequest, sendThroughBackground} from './background-client'
import type {CurlImport} from './curl-import'
import {buildRequest, formatResponse, formatSize, parseRequestUrl} from './request'
import type {RequestAuthorization, RequestDraft, RequestEntry} from './request'
import {loadResponseHeight, saveResponseHeight} from './response-height'
import type {HeaderPair, HttpRequestPayload, HttpResponsePayload} from '../shared/http-messages'
import type {HttpResultMessage} from '../shared/http-messages'
import {HISTORY_KEY_PREFIX, listSavedRequests, loadSavedRequest, loadWorkspace, saveWorkspace} from '../shared/request-store'
import {resolveRequestName} from '../shared/request-state'
import type {EditorState, PanelSnapshot, SavedRequest} from '../shared/request-state'

/** Text that starts with the curl program name, such as `curl https://…` or `curl.exe -X POST …`. */
const CURL_COMMAND_PATTERN = /^\s*curl(?:\.exe)?\s/i

/** The IDs of every Authorization tab field. Undo restores all of them, not only the selected type. */
const AUTH_FIELD_IDS = [
  'bearer-token',
  'basic-username',
  'basic-password',
  'api-key-name',
  'api-key-value',
  'api-key-location',
  'custom-authorization'
]

/** Return true when pasted or entered text is a cURL command and not a URL. */
function isCurlCommand(text: string): boolean {
  return CURL_COMMAND_PATTERN.test(text)
}

/** Read the Authorization tab fields that store the given authorization. */
function authorizationFieldValues(authorization: RequestAuthorization): Record<string, string> {
  switch (authorization.type) {
    case 'bearer':
      return {'bearer-token': authorization.token}
    case 'basic':
      return {'basic-username': authorization.username, 'basic-password': authorization.password}
    case 'api-key':
      return {
        'api-key-name': authorization.key,
        'api-key-value': authorization.value,
        'api-key-location': authorization.location
      }
    case 'custom':
      return {'custom-authorization': authorization.value}
    default:
      return {}
  }
}

/** Convert imported request values into a full editor snapshot with empty unused auth fields. */
function editorStateFromDraft(draft: RequestDraft): EditorState {
  const authValues: Record<string, string> = {'api-key-location': 'header'}
  for (const id of AUTH_FIELD_IDS) authValues[id] ??= ''
  const importedValues = authorizationFieldValues(draft.authorization)
  Object.assign(authValues, importedValues)
  return {
    name: '',
    method: draft.method,
    url: draft.url,
    params: draft.params,
    headers: draft.headers,
    body: draft.body,
    bodyType: draft.bodyType,
    authType: draft.authorization.type,
    authValues
  }
}

/** Convert the built fetch() values into plain data for the background script. */
function toPayload(request: {url: URL; init: RequestInit}): HttpRequestPayload {
  const headers: HeaderPair[] = []
  const requestHeaders = request.init.headers as Headers
  for (const [name, value] of requestHeaders) headers.push([name, value])
  const body = typeof request.init.body === 'string' ? request.init.body : undefined
  return {method: request.init.method ?? 'GET', url: request.url.href, headers, body}
}

/** Show a lowercase header name in its usual form, such as Content-Length for content-length. */
function displayHeaderName(name: string): string {
  const words = name.split('-')
  const capitalized = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
  return capitalized.join('-')
}

/** Keep the first line of a parser error. Later lines point at the command text with ^ marks. */
function firstLine(text: string): string {
  const [line] = text.split('\n')
  return line.trim()
}

/** Find a required element in the sidebar template. */
function element<T extends HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector)
  if (!node) throw new Error(`Missing sidebar element: ${selector}`)
  return node
}

/** Manage the request editor, persistent workspace, history, and response display. */
class SidebarApp {
  private form = element<HTMLFormElement>('#request-form')
  private url = element<HTMLInputElement>('#request-url')
  private method = element<HTMLSelectElement>('#request-method')
  private send = element<HTMLButtonElement>('#send-request')
  private body = element<HTMLTextAreaElement>('#request-body')
  private bodyType = element<HTMLSelectElement>('#body-type')
  private authType = element<HTMLSelectElement>('#auth-type')
  private nameButton = element<HTMLButtonElement>('#request-name')
  private nameInput = element<HTMLInputElement>('#request-name-input')
  private requestName = ''
  private historyDialog = element<HTMLDialogElement>('#history-dialog')
  private historyList = element('#history-list')
  private draftBeforeHistory: PanelSnapshot | undefined
  private responseId: string | undefined
  private responseRevision = 0
  private runningId: string | undefined
  private historyRefresh = 0
  private restoringWorkspace = true
  private canPersistWorkspace = false
  private disposed = false
  private responseSection = element('#response-section')
  private responseResizer = element('#response-resizer')
  private preferredResponseHeight = loadResponseHeight()
  private resizeStart: {pointerId: number; y: number; height: number} | undefined
  private error = element('#request-error')
  private responseContent = element<HTMLPreElement>('#response-content')
  private responseEmpty = element('#response-empty')
  private responseTools = element('#response-tools')
  private responseStats = element('#response-stats')
  private responseFormat = element<HTMLSelectElement>('#response-format')
  private copy = element<HTMLButtonElement>('#copy-response')
  private copyLabel = element('#copy-response-label')
  private responseNote = element('#response-note')
  private importNotice = element('#import-notice')
  private importSummary = element('#import-summary')
  private importWarnings = element<HTMLUListElement>('#import-warnings')
  private undoImport = element<HTMLButtonElement>('#undo-import')
  private stateBeforeImport: EditorState | undefined
  private responseBody = ''
  private responseHeaders = ''
  private responseTab = 'body'
  private lastUrlSearch = ''

  /** Restore the panel layout and connect request, naming, authorization, and resize events. */
  constructor() {
    this.addRow('params')
    this.addRow('headers')
    this.form.addEventListener('submit', this.sendRequest)
    this.send.addEventListener('click', this.handleSendClick)
    this.url.addEventListener('input', this.readUrlParameters)
    this.url.addEventListener('paste', this.handleUrlPaste)
    this.undoImport.addEventListener('click', this.undoCurlImport)
    element('#dismiss-import').addEventListener('click', this.hideImportNotice)
    this.method.addEventListener('change', this.updateMethod)
    this.bodyType.addEventListener('change', this.updateBodyFormat)
    this.form.addEventListener('input', this.handleRowInput)
    this.form.addEventListener('click', this.handleEditorClick)
    this.form.addEventListener('keydown', this.handleTabKey)
    element('#root').addEventListener('input', this.persistEditorChange)
    element('#root').addEventListener('change', this.persistEditorChange)
    element('#show-history').addEventListener('click', this.showHistory)
    element('#close-history').addEventListener('click', this.closeHistory)
    this.historyList.addEventListener('click', this.handleHistoryClick)
    element('#back-to-draft').addEventListener('click', this.backToDraft)
    element('#clear-request').addEventListener('click', this.clearRequest)
    chrome.storage.onChanged.addListener(this.handleStorageChange)
    element('#response-tabs').addEventListener('click', this.handleResponseTab)
    element('#response-tabs').addEventListener('keydown', this.handleTabKey)
    this.responseFormat.addEventListener('change', this.renderResponse)
    this.copy.addEventListener('click', this.copyResponse)
    this.authType.addEventListener('change', this.updateAuthorization)
    this.nameButton.addEventListener('click', this.startRenaming)
    this.nameInput.addEventListener('blur', this.finishRenaming)
    this.nameInput.addEventListener('keydown', this.handleNameKey)
    this.responseResizer.addEventListener('pointerdown', this.startResponseResize)
    this.responseResizer.addEventListener('pointermove', this.moveResponseResize)
    this.responseResizer.addEventListener('pointerup', this.finishResponseResize)
    this.responseResizer.addEventListener('pointercancel', this.finishResponseResize)
    this.responseResizer.addEventListener('lostpointercapture', this.finishResponseResize)
    this.responseResizer.addEventListener('keydown', this.handleResponseResizeKey)
    window.addEventListener('resize', this.fitResponse)
    document.addEventListener('keydown', this.handleShortcut)
    window.addEventListener('pagehide', this.dispose, {once: true})
    this.updateMethod()
    this.updateAuthorization()
    this.fitResponse()
    void this.restoreWorkspace()
  }

  /** Restore the last editor and response before enabling input, so startup cannot overwrite a newer draft. */
  private async restoreWorkspace(): Promise<void> {
    element('#root').inert = true
    try {
      const workspace = await loadWorkspace()
      this.canPersistWorkspace = true
      if (workspace) {
        this.draftBeforeHistory = workspace.preview ? workspace.draft : undefined
        const snapshot = workspace.preview ?? workspace.draft
        this.applyEditorState(snapshot.editor)
        this.responseId = snapshot.responseId
        await this.restoreResponse()
      }
    } catch {
      const message = this.canPersistWorkspace
        ? 'Could not restore the saved response. Reopen the panel to try again.'
        : 'Could not restore the saved draft. New edits are not saved. Reopen the panel, or select Clear to start over.'
      this.showStorageError(message)
    } finally {
      this.restoringWorkspace = false
      element('#root').inert = false
      this.updateRequestName()
      this.updateWorkspaceLabel()
    }
  }

  /** Read the current editor and the response reference without copying response bodies into the draft. */
  private readPanelSnapshot(): PanelSnapshot {
    return {editor: this.readEditorState(), responseId: this.responseId}
  }

  /** Save every editor change immediately. Background request completion stores responses separately. */
  private persistWorkspace = (): void => {
    if (this.restoringWorkspace || !this.canPersistWorkspace) return
    const current = this.readPanelSnapshot()
    const workspace = this.draftBeforeHistory
      ? {draft: this.draftBeforeHistory, preview: current}
      : {draft: current}
    void saveWorkspace(workspace).catch(this.reportDraftFailure)
  }

  /** Keep automatic names and persisted values current after input, including inactive auth fields. */
  private persistEditorChange = (): void => {
    this.updateRequestName()
    this.persistWorkspace()
  }

  /** Report a failed draft write without hiding a network result or clearing entered values. */
  private reportDraftFailure = (): void => {
    this.showStorageError('Could not save the draft. Keep this panel open and try editing it again.')
  }

  /** Show persistence failures separately from request failures. */
  private showStorageError(message: string): void {
    const notice = element('#storage-error')
    notice.textContent = message
    notice.hidden = false
  }

  /** Restore the saved response or running state without changing the editor. */
  private async restoreResponse(): Promise<void> {
    const id = this.responseId
    this.resetResponse()
    if (!id) return
    const revision = this.responseRevision
    const saved = await loadSavedRequest(id)
    if (this.responseId !== id || this.responseRevision !== revision) return
    if (!saved) {
      this.responseId = undefined
      return
    }
    this.showSavedResult(saved)
  }

  /** Show an attempt's result, or its visible running state until storage reports completion. */
  private showSavedResult(saved: SavedRequest): void {
    if (!saved.result) {
      this.runningId = saved.id
      this.setLoading(true)
    } else {
      this.runningId = undefined
      this.setLoading(false)
      this.showResult(saved.result)
    }
    this.updateWorkspaceLabel()
  }

  /** Display response text or a saved failure using the same view as a newly sent request. */
  private showResult(result: HttpResultMessage): void {
    if (result.type === 'response') {
      const response = result.response
      this.responseBody = response.body
      const headers: string[] = []
      for (const [key, value] of response.headers) headers.push(`${key}: ${value}`)
      this.responseHeaders = headers.join('\n')
      this.renderResponseStats(response)
      this.showSkippedHeaders(response.skippedHeaders)
      this.responseStats.hidden = false
      this.responseEmpty.hidden = true
      this.responseTools.hidden = false
      this.renderResponse()
    } else {
      this.resetResponse()
      this.showError(result.message)
      element('#empty-title').textContent = 'No response received'
      element('#empty-description').textContent = result.message
    }
    if (result.storageError) this.showStorageError(result.storageError)
  }

  /** Clear response data, loading indicators, and old errors without touching the editor or history. */
  private resetResponse(): void {
    this.runningId = undefined
    this.setLoading(false)
    this.responseBody = ''
    this.responseHeaders = ''
    this.error.hidden = true
    this.responseStats.hidden = true
    this.responseNote.hidden = true
    this.responseTools.hidden = true
    this.responseContent.textContent = ''
    this.responseContent.hidden = true
    const headers = element('#response-headers-panel')
    headers.textContent = ''
    headers.hidden = true
    this.responseEmpty.hidden = false
    element('#empty-title').textContent = 'Ready when you are'
    element('#empty-description').textContent = 'Enter a URL or paste a cURL command, then select Send.'
  }

  /** Reflect draft, history, and running state beside the request name. */
  private updateWorkspaceLabel(): void {
    element('#back-to-draft').hidden = !this.draftBeforeHistory
    const status = element('#workspace-status')
    status.dataset.running = String(Boolean(this.runningId))
    let label = this.draftBeforeHistory ? 'History' : 'Draft'
    if (this.runningId) label = 'Running'
    element('#workspace-status-label').textContent = label
  }

  /** Open saved sends in a modal list without replacing the current editor. */
  private showHistory = (): void => {
    this.historyDialog.showModal()
    void this.renderHistory()
  }

  /** Close history and return focus to the header button. */
  private closeHistory = (): void => {
    this.historyDialog.close()
    element('#show-history').focus()
  }

  /** Render sends newest first and expose running requests with an icon and status text. */
  private async renderHistory(): Promise<void> {
    const refresh = ++this.historyRefresh
    try {
      const savedRequests = await listSavedRequests()
      if (refresh !== this.historyRefresh || this.disposed) return
      const items: HTMLLIElement[] = []
      for (const saved of savedRequests) items.push(this.historyItem(saved))
      this.historyList.replaceChildren(...items)
      element('#history-empty').hidden = items.length !== 0
      element('#history-error').hidden = true
    } catch {
      element('#history-error').textContent = 'Could not read request history. Close this window and try again.'
      element('#history-error').hidden = false
    }
  }

  /** Build a safe history row from a static template, including name, URL, date, and result. */
  private historyItem(saved: SavedRequest): HTMLLIElement {
    const template = element<HTMLTemplateElement>('#history-item-template')
    const fragment = template.content.cloneNode(true) as DocumentFragment
    const item = fragment.querySelector<HTMLLIElement>('li')!
    const open = item.querySelector<HTMLButtonElement>('[data-open-history]')!
    open.dataset.openHistory = saved.id
    item.querySelector('[data-history-name]')!.textContent = saved.name
    item.querySelector('[data-history-method]')!.textContent = saved.request.method
    const url = item.querySelector<HTMLElement>('[data-history-url]')!
    url.textContent = saved.request.url
    url.title = saved.request.url
    const sentAt = new Date(saved.sentAt)
    const time = item.querySelector<HTMLTimeElement>('time')!
    time.dateTime = sentAt.toISOString()
    time.textContent = sentAt.toLocaleString()
    const status = item.querySelector<HTMLElement>('[data-history-status]')!
    status.dataset.running = String(!saved.result)
    let result = 'Running'
    if (saved.result?.type === 'response') result = String(saved.result.response.status)
    if (saved.result?.type === 'error') result = 'Failed'
    status.querySelector('[data-history-status-label]')!.textContent = result
    const remove = item.querySelector<HTMLButtonElement>('[data-delete-history]')!
    remove.dataset.deleteHistory = saved.id
    remove.setAttribute('aria-label', `Delete ${saved.name}`)
    return item
  }

  /** Open or delete an entry without submitting or altering another history entry. */
  private handleHistoryClick = async (event: MouseEvent): Promise<void> => {
    const target = event.target as Element
    const remove = target.closest<HTMLButtonElement>('[data-delete-history]')
    if (remove) {
      remove.disabled = true
      try {
        await controlSavedRequest({type: 'delete-saved-request', id: remove.dataset.deleteHistory!})
      } catch {
        remove.disabled = false
        element('#history-error').textContent = 'Could not delete this saved request. Try again.'
        element('#history-error').hidden = false
      }
      return
    }
    const open = target.closest<HTMLButtonElement>('[data-open-history]')
    if (!open) return
    try {
      const saved = await loadSavedRequest(open.dataset.openHistory!)
      if (!saved) return
      if (!this.draftBeforeHistory) this.draftBeforeHistory = this.readPanelSnapshot()
      this.hideImportNotice()
      this.resetResponse()
      this.applyEditorState(saved.editor)
      this.responseId = saved.id
      await this.restoreResponse()
      this.updateWorkspaceLabel()
      this.persistWorkspace()
      this.closeHistory()
    } catch {
      element('#history-error').textContent = 'Could not open this saved request. Try again.'
      element('#history-error').hidden = false
    }
  }

  /** Return from a history preview to the untouched draft and its saved response. */
  private backToDraft = async (): Promise<void> => {
    const draft = this.draftBeforeHistory
    if (!draft) return
    this.draftBeforeHistory = undefined
    this.hideImportNotice()
    this.applyEditorState(draft.editor)
    this.responseId = draft.responseId
    try {
      await this.restoreResponse()
    } catch {
      this.showStorageError('Could not restore the draft response. Open history to try again.')
    }
    this.updateWorkspaceLabel()
    this.persistWorkspace()
  }

  /** Empty every form value and the visible response, while keeping saved history and background sends. */
  private clearRequest = (): void => {
    this.canPersistWorkspace = true
    this.draftBeforeHistory = undefined
    this.responseId = undefined
    this.hideImportNotice()
    this.resetResponse()
    const empty: RequestDraft = {
      method: 'GET', url: '', params: [], headers: [], body: '', bodyType: 'json', authorization: {type: 'none'}
    }
    this.applyEditorState(editorStateFromDraft(empty))
    this.selectTab(element<HTMLButtonElement>('#params-tab'))
    this.responseTab = 'body'
    this.selectTab(element<HTMLButtonElement>('#response-body-tab'))
    this.responseContent.hidden = true
    this.responseFormat.value = 'pretty'
    element('#storage-error').hidden = true
    this.updateWorkspaceLabel()
    this.persistWorkspace()
    this.url.focus()
  }

  /** Update open history and the displayed response when the background stores a result or deletion. */
  private handleStorageChange = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
    if (area !== 'local' || this.disposed) return
    let historyChanged = false
    for (const [key, change] of Object.entries(changes)) {
      if (!key.startsWith(HISTORY_KEY_PREFIX)) continue
      historyChanged = true
      const id = key.slice(HISTORY_KEY_PREFIX.length)
      if (!change.newValue && this.draftBeforeHistory?.responseId === id) {
        this.draftBeforeHistory.responseId = undefined
        this.persistWorkspace()
      }
      if (id !== this.responseId) continue
      this.responseRevision += 1
      if (change.newValue) this.showSavedResult(change.newValue as SavedRequest)
      else {
        this.responseId = undefined
        this.resetResponse()
        this.updateWorkspaceLabel()
        this.persistWorkspace()
      }
    }
    if (historyChanged && this.historyDialog.open) void this.renderHistory()
  }

  /** Add an editable row using the static template and focus it on demand. */
  private addRow(group: string, entry?: RequestEntry, focus = false): void {
    const template = element<HTMLTemplateElement>('#entry-template')
    const fragment = template.content.cloneNode(true) as DocumentFragment
    const row = fragment.querySelector<HTMLDivElement>('.entry-row')!
    const enabled = row.querySelector<HTMLInputElement>('[data-field="enabled"]')!
    const key = row.querySelector<HTMLInputElement>('[data-field="key"]')!
    const value = row.querySelector<HTMLInputElement>('[data-field="value"]')!
    const label = group === 'params' ? 'parameter' : 'header'
    enabled.setAttribute('aria-label', `Include ${label}`)
    key.setAttribute('aria-label', `${label} key`)
    value.setAttribute('aria-label', `${label} value`)
    const remove = row.querySelector('button')!
    remove.setAttribute('aria-label', `Remove ${label}`)
    enabled.checked = entry?.enabled ?? true
    key.value = entry?.key ?? ''
    value.value = entry?.value ?? ''
    element(`#${group}-rows`).append(fragment)
    if (focus) key.focus()
  }

  /** Read rows in display order, including disabled and duplicate keys. */
  private readRows(group: string): RequestEntry[] {
    const rows = document.querySelectorAll(`#${group}-rows .entry-row`)
    const entries: RequestEntry[] = []
    for (const row of rows) {
      const enabled = row.querySelector<HTMLInputElement>('[data-field="enabled"]')!
      const key = row.querySelector<HTMLInputElement>('[data-field="key"]')!
      const value = row.querySelector<HTMLInputElement>('[data-field="value"]')!
      entries.push({enabled: enabled.checked, key: key.value, value: value.value})
    }
    return entries
  }

  /** Read URL parameters while retaining disabled rows and unfinished entries. */
  private readUrlParameters = (): void => {
    let url: URL
    try {
      url = parseRequestUrl(this.url.value)
    } catch {
      return
    }
    if (url.search === this.lastUrlSearch) return
    this.lastUrlSearch = url.search
    const retained: RequestEntry[] = []
    for (const entry of this.readRows('params')) {
      if (!entry.enabled || !entry.key.trim()) retained.push(entry)
    }
    element('#params-rows').replaceChildren()
    for (const [key, value] of url.searchParams) {
      this.addRow('params', {enabled: true, key, value})
    }
    for (const entry of retained) this.addRow('params', entry)
    const rows = element('#params-rows')
    if (!rows.children.length) this.addRow('params')
    this.updateCounts()
  }

  /** Import a pasted cURL command instead of inserting it as URL text. */
  private handleUrlPaste = (event: ClipboardEvent): void => {
    const text = event.clipboardData?.getData('text/plain') ?? ''
    if (!isCurlCommand(text)) return
    event.preventDefault()
    void this.importCurl(text)
  }

  /** Parse a cURL command, fill the editor, and offer Undo for the previous values. */
  private async importCurl(command: string): Promise<void> {
    this.error.hidden = true
    this.showImportNotice('Reading the cURL command…', [], false)
    let imported: CurlImport
    let summary: string
    try {
      const curlImport = await import('./curl-import')
      imported = curlImport.importCurlCommand(command)
      summary = curlImport.describeImport(imported.draft)
    } catch (error) {
      this.hideImportNotice()
      const reason = error instanceof Error ? firstLine(error.message) : ''
      this.showError(`Could not read the cURL command. ${reason}`.trim())
      return
    }

    this.stateBeforeImport = this.readEditorState()
    const importedState = editorStateFromDraft(imported.draft)
    importedState.name = this.stateBeforeImport.name
    this.applyEditorState(importedState)
    this.showImportNotice(summary, imported.warnings, true)
    this.showImportedTab(imported.draft)
    this.persistWorkspace()
    this.url.focus()
  }

  /** Show the import result. Undo is available only after the editor values change. */
  private showImportNotice(summary: string, warnings: string[], canUndo: boolean): void {
    this.importSummary.textContent = summary
    const uniqueWarnings = new Set(warnings.map(firstLine))
    const items: HTMLLIElement[] = []
    for (const warning of uniqueWarnings) {
      const item = document.createElement('li')
      item.textContent = warning
      items.push(item)
    }
    this.importWarnings.replaceChildren(...items)
    this.importWarnings.hidden = items.length === 0
    element('#import-warning-title').hidden = items.length === 0
    this.undoImport.hidden = !canUndo
    this.importNotice.hidden = false
  }

  /** Hide the import result and forget the Undo snapshot. */
  private hideImportNotice = (): void => {
    this.importNotice.hidden = true
    this.stateBeforeImport = undefined
  }

  /** Restore the editor values from before the last cURL import. */
  private undoCurlImport = (): void => {
    const previous = this.stateBeforeImport
    this.hideImportNotice()
    if (!previous) return
    this.applyEditorState(previous)
    this.persistWorkspace()
    this.url.focus()
  }

  /** Open the tab that shows the most important imported values. */
  private showImportedTab(draft: RequestDraft): void {
    let tabId = 'params-tab'
    if (draft.headers.length) tabId = 'headers-tab'
    if (draft.body) tabId = 'body-tab'
    this.selectTab(element<HTMLButtonElement>(`#${tabId}`))
  }

  /** Read every editor value, including auth fields for types that are not selected. */
  private readEditorState(): EditorState {
    const authValues: Record<string, string> = {}
    for (const id of AUTH_FIELD_IDS) {
      authValues[id] = element<HTMLInputElement | HTMLSelectElement>(`#${id}`).value
    }
    return {
      name: this.nameInput.hidden ? this.requestName : this.nameInput.value.trim(),
      method: this.method.value,
      url: this.url.value,
      params: this.readRows('params'),
      headers: this.readRows('headers'),
      body: this.body.value,
      bodyType: this.bodyType.value,
      authType: this.authType.value,
      authValues
    }
  }

  /** Replace every editor value and update the dependent labels, counts, and fields. */
  private applyEditorState(state: EditorState): void {
    this.requestName = state.name
    this.nameInput.hidden = true
    this.nameButton.hidden = false
    let hasMethod = false
    for (const option of this.method.options) {
      if (option.value === state.method) hasMethod = true
    }
    if (!hasMethod) this.method.add(new Option(state.method))
    this.method.value = state.method
    this.url.value = state.url
    try {
      this.lastUrlSearch = parseRequestUrl(state.url).search
    } catch {
      this.lastUrlSearch = ''
    }
    this.replaceRows('params', state.params)
    this.replaceRows('headers', state.headers)
    this.body.value = state.body
    this.bodyType.value = state.bodyType
    this.authType.value = state.authType
    for (const id of AUTH_FIELD_IDS) {
      element<HTMLInputElement | HTMLSelectElement>(`#${id}`).value = state.authValues[id] ?? ''
    }
    this.updateMethod()
    this.updateAuthorization()
    this.updateCounts()
    this.updateRequestName()
  }

  /** Replace one row group. An empty group keeps one blank row for new input. */
  private replaceRows(group: string, entries: RequestEntry[]): void {
    element(`#${group}-rows`).replaceChildren()
    for (const entry of entries) this.addRow(group, entry)
    if (!entries.length) this.addRow(group)
  }

  /** Show an error above the request tabs. */
  private showError(message: string): void {
    this.error.textContent = message
    this.error.hidden = false
  }

  /** Reflect enabled parameter rows in the URL without losing other URL parts. */
  private updateUrl(): void {
    try {
      const url = parseRequestUrl(this.url.value)
      url.search = ''
      for (const entry of this.readRows('params')) {
        if (entry.enabled && entry.key.trim()) {
          url.searchParams.append(entry.key, entry.value)
        }
      }
      this.lastUrlSearch = url.search
      this.url.value = url.href
    } catch {
      // Parameter rows remain editable before a valid URL is entered.
    }
  }

  /** Count enabled nonempty rows beside each request tab. */
  private updateCounts(): void {
    for (const group of ['params', 'headers']) {
      let count = 0
      for (const entry of this.readRows(group)) {
        if (entry.enabled && entry.key.trim()) count += 1
      }
      const badge = element(`#${group}-count`)
      badge.textContent = String(count)
      badge.hidden = count === 0
    }
  }

  /** Keep query parameters and tab counts in sync with row edits. */
  private handleRowInput = (event: Event): void => {
    const target = event.target as HTMLElement
    if (!target.closest('.entry-row')) return
    if (target.closest('#params-rows')) this.updateUrl()
    this.updateCounts()
  }

  /** Handle request tabs and table controls without submitting the form. */
  private handleEditorClick = (event: MouseEvent): void => {
    const target = event.target as HTMLElement
    const tab = target.closest<HTMLButtonElement>('[role="tab"]')
    if (tab) this.selectTab(tab)
    const add = target.closest<HTMLButtonElement>('[data-add]')
    if (add) {
      this.addRow(add.dataset.add!, undefined, true)
      this.persistWorkspace()
    }
    const remove = target.closest<HTMLButtonElement>('[data-remove]')
    if (!remove) return
    const row = remove.closest('.entry-row')!
    const isParam = Boolean(row.closest('#params-rows'))
    const group = isParam ? 'params' : 'headers'
    row.remove()
    const rows = element(`#${group}-rows`)
    if (!rows.children.length) this.addRow(group)
    element<HTMLButtonElement>(`[data-add="${group}"]`).focus()
    if (isParam) this.updateUrl()
    this.updateCounts()
    this.persistWorkspace()
  }

  /** Select one accessible tab and show its corresponding panel. */
  private selectTab(selected: HTMLButtonElement): void {
    const list = selected.closest('[role="tablist"]')!
    for (const tab of list.querySelectorAll<HTMLButtonElement>('[role="tab"]')) {
      const active = tab === selected
      tab.setAttribute('aria-selected', String(active))
      tab.tabIndex = active ? 0 : -1
      const panel = tab.getAttribute('aria-controls')!
      element(`#${panel}`).hidden = !active
    }
  }

  /** Support arrow, Home, and End keys for both sets of tabs. */
  private handleTabKey = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement
    if (target.getAttribute('role') !== 'tab') return
    const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End']
    if (!keys.includes(event.key)) return
    event.preventDefault()
    const list = target.closest('[role="tablist"]')!
    const buttons = list.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    const tabs = Array.from(buttons)
    let index = tabs.indexOf(target as HTMLButtonElement)
    if (event.key === 'ArrowLeft') {
      index -= 1
      if (index < 0) index = tabs.length - 1
    }
    if (event.key === 'ArrowRight') index = (index + 1) % tabs.length
    if (event.key === 'Home') index = 0
    if (event.key === 'End') index = tabs.length - 1
    tabs[index].focus()
    tabs[index].click()
  }

  /** Prevent bodies on GET and HEAD while retaining the draft for other methods. */
  private updateMethod = (): void => {
    const method = this.method.value
    const disabled = method === 'GET' || method === 'HEAD'
    this.body.disabled = disabled
    const note = element('#body-note')
    note.hidden = !disabled
    note.textContent = ''
    if (disabled) {
      note.textContent = `${method} requests do not send a body. Select POST, PUT, PATCH, DELETE, or OPTIONS to enable the editor.`
    }
    element('#request-method-label').textContent = method
    this.method.dataset.method = method
    this.updateBodyFormat()
  }

  /** Update body format hints without changing or deleting the user's draft. */
  private updateBodyFormat = (): void => {
    const isJson = this.bodyType.value === 'json'
    const contentType = isJson ? 'application/json' : 'text/plain'
    const format = isJson ? 'JSON' : 'Text'
    this.body.setAttribute('aria-label', `${format} request body`)
    if (this.body.disabled) {
      this.body.placeholder = `${this.method.value} requests do not send a body.`
    } else {
      this.body.placeholder = isJson ? '{\n  "name": "Hello, world"\n}' : 'Enter your request body…'
    }
    const hint = element('#body-content-type')
    hint.textContent = `Default Content-Type: ${contentType}. A Content-Type in the Headers tab overrides this value.`
  }

  /** Open the request name field on click and select its current text. */
  private startRenaming = (): void => {
    this.nameButton.hidden = true
    this.nameInput.hidden = false
    this.nameInput.value = this.requestName
    this.nameInput.placeholder = resolveRequestName('', this.url.value)
    this.nameInput.focus()
    this.nameInput.select()
  }

  /** Save an explicit name, or use the URL hostname when the name is blank. */
  private finishRenaming = (): void => {
    this.requestName = this.nameInput.value.trim()
    this.nameInput.hidden = true
    this.nameButton.hidden = false
    this.updateRequestName()
    this.persistWorkspace()
  }

  /** Display an automatic hostname without turning it into an explicit name when the URL changes. */
  private updateRequestName(): void {
    const name = resolveRequestName(this.requestName, this.url.value)
    this.nameButton.textContent = name
    this.nameButton.title = `Rename ${name}`
    document.title = `${name} · Browser Curl`
  }

  /** Save with Enter or cancel with Escape without sending the request. */
  private handleNameKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' && event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Escape') this.nameInput.value = this.requestName
    this.nameInput.blur()
    this.nameButton.focus()
  }

  /** Show fields for the selected authorization while keeping other draft values. */
  private updateAuthorization = (): void => {
    const groups = document.querySelectorAll<HTMLElement>('[data-auth-type]')
    for (const group of groups) group.hidden = group.dataset.authType !== this.authType.value
  }

  /** Read only credentials for the selected authorization type. */
  private readAuthorization(): RequestAuthorization {
    switch (this.authType.value) {
      case 'bearer':
        return {type: 'bearer', token: element<HTMLInputElement>('#bearer-token').value}
      case 'basic':
        return {
          type: 'basic',
          username: element<HTMLInputElement>('#basic-username').value,
          password: element<HTMLInputElement>('#basic-password').value
        }
      case 'api-key': {
        const location = element<HTMLSelectElement>('#api-key-location').value
        return {
          type: 'api-key',
          key: element<HTMLInputElement>('#api-key-name').value,
          value: element<HTMLInputElement>('#api-key-value').value,
          location: location === 'query' ? 'query' : 'header'
        }
      }
      case 'custom':
        return {type: 'custom', value: element<HTMLInputElement>('#custom-authorization').value}
      default:
        return {type: 'none'}
    }
  }

  /** Leave room for the request editor when expanding the response section. */
  private maximumResponseHeight(): number {
    const main = element('main')
    const heading = element('.request-heading')
    const reserved = heading.offsetHeight + this.responseResizer.offsetHeight + 120
    return Math.max(140, main.clientHeight - reserved)
  }

  /** Clamp the response height to the viewport and update separator accessibility. */
  private setResponseHeight(height: number): void {
    const maximum = this.maximumResponseHeight()
    const bounded = Math.min(height, maximum)
    const nextHeight = Math.max(140, bounded)
    const pixels = Math.round(nextHeight)
    this.responseSection.style.flexBasis = `${pixels}px`
    this.responseResizer.setAttribute('aria-valuenow', String(pixels))
    this.responseResizer.setAttribute('aria-valuemax', String(maximum))
    this.responseResizer.setAttribute('aria-valuetext', `${pixels} pixels`)
  }

  /** Restore the preferred height within the available space without overwriting it. */
  private fitResponse = (): void => {
    const bounds = this.responseSection.getBoundingClientRect()
    const height = this.preferredResponseHeight ?? bounds.height
    this.setResponseHeight(height)
  }

  /** Remember a user-selected height for this panel and future sidebar sessions. */
  private rememberResponseHeight(): void {
    const bounds = this.responseSection.getBoundingClientRect()
    this.preferredResponseHeight = Math.round(bounds.height)
    saveResponseHeight(this.preferredResponseHeight)
  }

  /** Capture a pointer so dragging works outside the divider itself. */
  private startResponseResize = (event: PointerEvent): void => {
    if (event.button !== 0 || this.resizeStart) return
    event.preventDefault()
    const bounds = this.responseSection.getBoundingClientRect()
    this.resizeStart = {pointerId: event.pointerId, y: event.clientY, height: bounds.height}
    this.responseResizer.setPointerCapture(event.pointerId)
    this.responseResizer.focus()
    document.body.classList.add('is-resizing')
  }

  /** Grow the response when its divider moves upward and shrink it downward. */
  private moveResponseResize = (event: PointerEvent): void => {
    if (!this.resizeStart || this.resizeStart.pointerId !== event.pointerId) return
    const distance = this.resizeStart.y - event.clientY
    this.setResponseHeight(this.resizeStart.height + distance)
  }

  /** Release pointer capture and save the selected height after a resize ends. */
  private finishResponseResize = (event: PointerEvent): void => {
    if (!this.resizeStart || this.resizeStart.pointerId !== event.pointerId) return
    this.resizeStart = undefined
    if (this.responseResizer.hasPointerCapture(event.pointerId)) {
      this.responseResizer.releasePointerCapture(event.pointerId)
    }
    document.body.classList.remove('is-resizing')
    this.rememberResponseHeight()
  }

  /** Resize and save with arrow keys, Home, or End. Shift increases the step size. */
  private handleResponseResizeKey = (event: KeyboardEvent): void => {
    const keys = ['ArrowUp', 'ArrowDown', 'Home', 'End']
    if (!keys.includes(event.key)) return
    event.preventDefault()
    const step = event.shiftKey ? 40 : 10
    const bounds = this.responseSection.getBoundingClientRect()
    let height = bounds.height
    if (event.key === 'ArrowUp') height += step
    if (event.key === 'ArrowDown') height -= step
    if (event.key === 'Home') height = 140
    if (event.key === 'End') height = this.maximumResponseHeight()
    this.setResponseHeight(height)
    this.rememberResponseHeight()
  }

  /** Cancel an active request even if the URL field currently fails validation. */
  private handleSendClick = (event: MouseEvent): void => {
    if (!this.runningId) return
    event.preventDefault()
    void this.cancelRunningRequest()
  }

  /** Cancel the displayed running request, including one started before the panel reopened. */
  private async cancelRunningRequest(): Promise<void> {
    if (!this.runningId) return
    try {
      await controlSavedRequest({type: 'cancel-http-request', id: this.runningId})
    } catch {
      this.showStorageError('Could not cancel this request. Try again.')
    }
  }

  /** Send or cancel a request. A cURL command in the URL field is imported instead of sent. */
  private sendRequest = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault()
    if (this.runningId) {
      await this.cancelRunningRequest()
      return
    }
    if (isCurlCommand(this.url.value)) {
      await this.importCurl(this.url.value)
      return
    }
    this.error.hidden = true
    this.hideImportNotice()
    let id: string | undefined
    try {
      const draft: RequestDraft = {
        method: this.method.value,
        url: this.url.value,
        params: this.readRows('params'),
        headers: this.readRows('headers'),
        body: this.body.value,
        bodyType: this.bodyType.value,
        authorization: this.readAuthorization()
      }
      const request = buildRequest(draft)
      const payload = toPayload(request)
      const editor = this.readEditorState()
      id = crypto.randomUUID()
      this.resetResponse()
      this.responseId = id
      this.runningId = id
      this.setLoading(true)
      this.updateWorkspaceLabel()
      this.persistWorkspace()
      const result = await sendThroughBackground(payload, editor, id)
      if (this.disposed || this.responseId !== id) return
      this.showResult(result)
    } catch (error) {
      if (this.disposed || (id && this.responseId !== id)) return
      let message = 'Could not send the request. Check the URL and network connection.'
      if (error instanceof Error) message = error.message
      this.showError(message)
      this.responseEmpty.hidden = false
      element('#empty-title').textContent = 'No response received'
      element('#empty-description').textContent = 'Check the request details and try again.'
    } finally {
      if (id && this.responseId === id) {
        this.runningId = undefined
        this.setLoading(false)
        this.updateWorkspaceLabel()
      }
    }
  }

  /** Show response metadata as text, including the complete content type and final URL in tooltips. */
  private renderResponseStats(response: HttpResponsePayload): void {
    const status = `${response.status} ${response.statusText}`.trim()
    element('#response-status').textContent = status
    const isSuccess = response.status >= 200 && response.status < 300
    element('#response-status').dataset.success = String(isSuccess)
    element('#response-time').textContent = `${response.durationMs} ms`
    element('#response-size').textContent = formatSize(response.size)
    element('#response-header-count').textContent = String(response.headers.length)

    let contentType = ''
    for (const [name, value] of response.headers) {
      if (name.toLowerCase() === 'content-type') contentType = value
    }
    const [mediaType] = contentType.split(';')
    const typeElement = element('#response-type')
    typeElement.textContent = mediaType.trim() || 'Not provided'
    typeElement.title = contentType || 'The server did not send a Content-Type header.'

    const urlElement = element('#response-url')
    urlElement.textContent = response.url
    urlElement.title = response.url
  }

  /** Tell the user which entered headers the browser controls and did not send. */
  private showSkippedHeaders(names: string[]): void {
    const displayNames = names.map(displayHeaderName)
    this.responseNote.hidden = names.length === 0
    this.responseNote.textContent = `Not sent, because the browser sets these headers: ${displayNames.join(', ')}.`
  }

  /** Reset response state while a request is running and update the send control. */
  private setLoading(loading: boolean): void {
    this.send.textContent = loading ? 'Cancel' : 'Send'
    this.send.classList.toggle('is-loading', loading)
    element('#response-section').setAttribute('aria-busy', String(loading))
    if (!loading) return
    this.copyLabel.textContent = 'Copy'
    this.responseStats.hidden = true
    this.responseNote.hidden = true
    this.responseTools.hidden = true
    this.responseContent.hidden = true
    element('#response-headers-panel').hidden = true
    this.responseEmpty.hidden = false
    element('#empty-title').textContent = 'Sending request…'
    element('#empty-description').textContent = 'Waiting for the server to respond.'
  }

  /** Switch between response body and response headers. */
  private handleResponseTab = (event: MouseEvent): void => {
    const target = event.target as HTMLElement
    const tab = target.closest<HTMLButtonElement>('[role="tab"]')
    if (!tab) return
    this.selectTab(tab)
    this.responseTab = tab.dataset.response!
    this.renderResponse()
  }

  /** Render server text safely, without interpreting it as HTML. */
  private renderResponse = (): void => {
    const pretty = this.responseFormat.value === 'pretty'
    this.responseContent.textContent = formatResponse(this.responseBody, pretty)
    if (!this.responseBody) this.responseContent.textContent = '(empty body)'
    const headers = this.responseHeaders || '(no response headers)'
    element('#response-headers-panel').textContent = headers
    this.responseContent.hidden = this.responseTab !== 'body'
    element('#response-headers-panel').hidden = this.responseTab !== 'headers'
    this.responseFormat.hidden = this.responseTab !== 'body'
    this.copyLabel.textContent = 'Copy'
  }

  /** Copy the visible response text and report clipboard failures in the button. */
  private copyResponse = async (): Promise<void> => {
    const pretty = this.responseFormat.value === 'pretty'
    const body = formatResponse(this.responseBody, pretty)
    const text = this.responseTab === 'headers' ? this.responseHeaders : body
    try {
      await navigator.clipboard.writeText(text)
      this.copyLabel.textContent = 'Copied'
    } catch {
      this.copyLabel.textContent = 'Copy failed'
    }
  }

  /** Submit the editor with Command+Enter or Control+Enter. */
  private handleShortcut = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' || (!event.metaKey && !event.ctrlKey)) return
    event.preventDefault()
    if (this.runningId) {
      void this.cancelRunningRequest()
      return
    }
    this.form.requestSubmit()
  }

  /** Save the draft and resize preference, and detach panel listeners while background requests continue. */
  private dispose = (): void => {
    this.persistWorkspace()
    this.disposed = true
    if (this.resizeStart) this.rememberResponseHeight()
    chrome.storage.onChanged.removeListener(this.handleStorageChange)
    document.body.classList.remove('is-resizing')
    window.removeEventListener('resize', this.fitResponse)
    document.removeEventListener('keydown', this.handleShortcut)
  }
}

new SidebarApp()
