/** Store complete requests locally. Only the background context mutates history to serialize updates and deletion. */
import type {HttpResultMessage} from './http-messages'
import type {SavedRequest, WorkspaceState} from './request-state'

/** Prefix for individual sent requests. Use it to recognize history changes in storage events. */
export const HISTORY_KEY_PREFIX = 'browsercurl.history.'

/** Key for the editor workspace. Draft changes never create history entries. */
const WORKSPACE_KEY = 'browsercurl.workspace'

/** Pending history writes in this context, so deletion cannot race a response update. */
let historyWrites = Promise.resolve()

/** Read selected local storage keys, or all keys when listing sent requests. */
function readStorage(keys: string | null): Promise<Record<string, unknown>> {
  /** Resolve the storage read or report the browser's storage error. */
  function read(resolve: (items: Record<string, unknown>) => void, reject: (error: Error) => void): void {
    /** Check the callback-scoped runtime error before returning the stored values. */
    function finish(items: Record<string, unknown>): void {
      const error = chrome.runtime.lastError
      if (error) reject(new Error(error.message))
      else resolve(items)
    }
    chrome.storage.local.get(keys, finish)
  }
  return new Promise(read)
}

/** Write a snapshot immediately to the browser, including when the panel is about to close. */
function writeStorage(items: Record<string, unknown>): Promise<void> {
  /** Resolve only after the browser accepts the values, and surface storage failures. */
  function write(resolve: () => void, reject: (error: Error) => void): void {
    /** Read the callback-scoped runtime error after the write completes. */
    function finish(): void {
      const error = chrome.runtime.lastError
      if (error) reject(new Error(error.message))
      else resolve()
    }
    chrome.storage.local.set(items, finish)
  }
  return new Promise(write)
}

/** Delete one complete request and response from local storage. */
function removeStorage(key: string): Promise<void> {
  /** Finish deletion only after storage confirms it. */
  function remove(resolve: () => void, reject: (error: Error) => void): void {
    /** Surface callback-scoped storage errors without reporting success. */
    function finish(): void {
      const error = chrome.runtime.lastError
      if (error) reject(new Error(error.message))
      else resolve()
    }
    chrome.storage.local.remove(key, finish)
  }
  return new Promise(remove)
}

/** Serialize history mutations and allow the next operation to run after a failed write. */
function mutateHistory(operation: () => Promise<void>): Promise<void> {
  const mutation = historyWrites.then(operation)
  /** Keep a rejected mutation from blocking later history operations. */
  function allowNextWrite(): void {}
  historyWrites = mutation.catch(allowNextWrite)
  return mutation
}

/** Restore the workspace without reading or exposing unrelated extension preferences. */
export async function loadWorkspace(): Promise<WorkspaceState | undefined> {
  const items = await readStorage(WORKSPACE_KEY)
  return items[WORKSPACE_KEY] as WorkspaceState | undefined
}

/** Persist the complete draft and optional history preview without adding a sent request. */
export function saveWorkspace(workspace: WorkspaceState): Promise<void> {
  return writeStorage({[WORKSPACE_KEY]: workspace})
}

/** Read a single sent request, or return undefined after it is deleted. */
export async function loadSavedRequest(id: string): Promise<SavedRequest | undefined> {
  const key = HISTORY_KEY_PREFIX + id
  const items = await readStorage(key)
  return items[key] as SavedRequest | undefined
}

/** List complete sent requests newest first. Drafts and other preferences are excluded. */
export async function listSavedRequests(): Promise<SavedRequest[]> {
  const items = await readStorage(null)
  const requests: SavedRequest[] = []
  for (const [key, value] of Object.entries(items)) {
    if (key.startsWith(HISTORY_KEY_PREFIX)) requests.push(value as SavedRequest)
  }
  /** Compare send times without changing stored history order. */
  function newestFirst(left: SavedRequest, right: SavedRequest): number {
    return right.sentAt - left.sentAt
  }
  return requests.sort(newestFirst)
}

/** Save the full request before the background starts its network operation. Background use only. */
export function createSavedRequest(request: SavedRequest): Promise<void> {
  /** Add this request as a distinct send attempt. */
  function create(): Promise<void> {
    const key = HISTORY_KEY_PREFIX + request.id
    return writeStorage({[key]: request})
  }
  return mutateHistory(create)
}

/** Save a response or failure without restoring a request deleted during its network operation. Background use only. */
export function finishSavedRequest(id: string, result: HttpResultMessage): Promise<void> {
  /** Read and update within the background's serialized mutation queue. */
  async function finish(): Promise<void> {
    const saved = await loadSavedRequest(id)
    if (!saved) return
    saved.result = result
    const key = HISTORY_KEY_PREFIX + id
    await writeStorage({[key]: saved})
  }
  return mutateHistory(finish)
}

/** Remove the whole saved item in order with pending response writes. Background use only. */
export function deleteSavedRequest(id: string): Promise<void> {
  /** Remove credentials, request data, and response together. */
  function remove(): Promise<void> {
    return removeStorage(HISTORY_KEY_PREFIX + id)
  }
  return mutateHistory(remove)
}

/** Mark unfinished attempts as interrupted after the background restarts. Background use only. */
export function recoverInterruptedRequests(): Promise<void> {
  /** Update old pending records before newly received requests enter the write queue. */
  async function recover(): Promise<void> {
    const requests = await listSavedRequests()
    const updates: Record<string, SavedRequest> = {}
    for (const saved of requests) {
      if (saved.result) continue
      saved.result = {type: 'error', message: 'The browser stopped before this request finished.'}
      updates[HISTORY_KEY_PREFIX + saved.id] = saved
    }
    if (Object.keys(updates).length) await writeStorage(updates)
  }
  return mutateHistory(recover)
}
