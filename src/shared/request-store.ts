/**
 * Store the editor workspace and sent requests locally.
 * Each sent request has its own entry key. A separate index key holds the short list data, so the history list never
 * reads response bodies. Only the background context changes history, so it can serialize updates and deletion.
 */
import type {HttpResultMessage} from './http-messages'
import {summarizeSavedRequest} from './request-state.ts'
import type {HistorySummary, SavedRequest, WorkspaceState} from './request-state'
import {readStorage, removeStorage, writeStorage} from './storage.ts'

/** Prefix for the entry keys of sent requests. Use it to recognize entry changes in storage events. */
export const HISTORY_KEY_PREFIX = 'browsercurl.history.'

/** Key for the history index: the list data of every sent request, newest first. */
export const HISTORY_INDEX_KEY = 'browsercurl.historyIndex'

/** The largest number of sent requests that history keeps. Saving a new request deletes the oldest ones. */
export const HISTORY_LIMIT = 100

/** Key for the editor workspace. Draft changes never create history entries. */
const WORKSPACE_KEY = 'browsercurl.workspace'

/** Pending history writes in this context, so deletion cannot race a response update. */
let historyWrites = Promise.resolve()

/** Return the entry key of one sent request. */
function entryKey(id: string): string {
  return HISTORY_KEY_PREFIX + id
}

/** Read the history index, or undefined when storage has no index yet. */
async function readIndex(): Promise<HistorySummary[] | undefined> {
  const items = await readStorage(HISTORY_INDEX_KEY)
  return items[HISTORY_INDEX_KEY] as HistorySummary[] | undefined
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
  const key = entryKey(id)
  const items = await readStorage(key)
  return items[key] as SavedRequest | undefined
}

/** List the history data of sent requests, newest first, without reading requests or response bodies. */
export async function listHistorySummaries(): Promise<HistorySummary[]> {
  const index = await readIndex()
  return index ?? []
}

/**
 * Save the full request before the background starts its network operation. Background use only.
 * When history has more than HISTORY_LIMIT requests, this deletes the oldest ones.
 */
export function createSavedRequest(request: SavedRequest): Promise<void> {
  /** Add this request as a distinct send attempt, and remove the requests that no longer fit. */
  async function create(): Promise<void> {
    const index = await listHistorySummaries()
    const summary = summarizeSavedRequest(request)
    const updatedIndex = [summary, ...index]
    const removedSummaries = updatedIndex.splice(HISTORY_LIMIT)
    await writeStorage({[entryKey(request.id)]: request, [HISTORY_INDEX_KEY]: updatedIndex})
    if (!removedSummaries.length) return
    const removedKeys = removedSummaries.map((removed) => entryKey(removed.id))
    try {
      await removeStorage(removedKeys)
    } catch (error) {
      // The new request is saved. The old entries stay in storage, but history no longer lists them.
      console.error('Could not remove old history entries.', error)
    }
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
    const index = await listHistorySummaries()
    const summary = summarizeSavedRequest(saved)
    /** Replace the finished request's list data and keep every other item. */
    function updateSummary(item: HistorySummary): HistorySummary {
      return item.id === id ? summary : item
    }
    const updatedIndex = index.map(updateSummary)
    await writeStorage({[entryKey(id)]: saved, [HISTORY_INDEX_KEY]: updatedIndex})
  }
  return mutateHistory(finish)
}

/**
 * Remove the whole saved item in order with pending response writes. Background use only.
 * The entry goes first. If the index write then fails, history still lists the item, and the user can delete it again.
 */
export function deleteSavedRequest(id: string): Promise<void> {
  /** Remove credentials, request data, and response together, and then remove the item from the list. */
  async function remove(): Promise<void> {
    await removeStorage(entryKey(id))
    const index = await listHistorySummaries()
    /** Keep every item except the deleted one. */
    function isKept(item: HistorySummary): boolean {
      return item.id !== id
    }
    const updatedIndex = index.filter(isKept)
    await writeStorage({[HISTORY_INDEX_KEY]: updatedIndex})
  }
  return mutateHistory(remove)
}

/**
 * Remove history entries when storage has no index, and create an empty index.
 * This happens on a new install, and when storage holds entries from the earlier format, which had no index.
 */
async function removeUnindexedEntries(): Promise<void> {
  const items = await readStorage(null)
  /** Return true for the entry keys of sent requests. */
  function isEntryKey(key: string): boolean {
    return key.startsWith(HISTORY_KEY_PREFIX)
  }
  const keys = Object.keys(items).filter(isEntryKey)
  if (keys.length) await removeStorage(keys)
  await writeStorage({[HISTORY_INDEX_KEY]: []})
}

/** Mark unfinished attempts as interrupted after the background restarts. Background use only. */
export function recoverInterruptedRequests(): Promise<void> {
  /** Update old pending records before newly received requests enter the write queue. */
  async function recover(): Promise<void> {
    const index = await readIndex()
    if (!index) {
      await removeUnindexedEntries()
      return
    }
    const updates: Record<string, unknown> = {}
    const updatedIndex: HistorySummary[] = []
    for (const summary of index) {
      if (summary.state !== 'running') {
        updatedIndex.push(summary)
        continue
      }
      const saved = await loadSavedRequest(summary.id)
      if (!saved) continue
      saved.result = {type: 'error', message: 'The browser stopped before this request finished.'}
      updates[entryKey(saved.id)] = saved
      updatedIndex.push(summarizeSavedRequest(saved))
    }
    if (updatedIndex.length === index.length && !Object.keys(updates).length) return
    updates[HISTORY_INDEX_KEY] = updatedIndex
    await writeStorage(updates)
  }
  return mutateHistory(recover)
}
