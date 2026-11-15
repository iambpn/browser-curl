/** Background ownership lets saved collection changes reach disk after the sidebar closes. */
import {COLLECTION_INDEX_KEY, COLLECTION_KEY_PREFIX} from './collection-store'
import {DISK_SYNC_KEY, syncCollectionsToDisk} from './disk-sync'
import type {DiskSyncSettings} from './disk-sync'

/** Combine rapid saved changes into one export after half a second of quiet. */
const SYNC_DELAY_MS = 500

/** Return true for user configuration changes, excluding the worker's own progress writes. */
function configurationChanged(change: chrome.storage.StorageChange): boolean {
  const before = change.oldValue as DiskSyncSettings | undefined
  const after = change.newValue as DiskSyncSettings | undefined
  if (before?.enabled !== after?.enabled || before?.directoryKey !== after?.directoryKey) return true
  const oldIds = JSON.stringify(before?.collectionIds)
  const newIds = JSON.stringify(after?.collectionIds)
  return oldIds !== newIds
}

/** React to saved collection changes without polling or keeping an idle worker alive. */
export class DiskSyncWorker {
  private timer: ReturnType<typeof setTimeout> | undefined
  private running: Promise<void> | undefined
  private requested = false

  /** Register browser events synchronously, then recover outstanding exports from saved source data. */
  constructor() {
    chrome.storage.onChanged.addListener(this.storageChanged)
    chrome.runtime.onMessage.addListener(this.handleMessage)
    this.schedule()
  }

  /** Reset the short delay when another collection change arrives before the batch starts. */
  private schedule = (): void => {
    this.requested = true
    clearTimeout(this.timer)
    this.timer = setTimeout(this.runScheduled, SYNC_DELAY_MS)
  }

  /** Start a scheduled batch and report persistence failures without discarding saved source data. */
  private runScheduled = (): void => {
    void this.flush().catch(this.reportFailure)
  }

  /** Share an active batch with explicit retries and close events, including changes received during a write. */
  private flush = (): Promise<void> => {
    clearTimeout(this.timer)
    this.requested = true
    this.running ??= this.drain()
    return this.running
  }

  /** Finish queued changes, keeping only an active export alive and releasing the timer afterward. */
  private async drain(): Promise<void> {
    const keepAlive = setInterval(this.keepActiveWriteAlive, 10000)
    try {
      while (this.requested) {
        clearTimeout(this.timer)
        this.requested = false
        await syncCollectionsToDisk()
      }
    } finally {
      clearInterval(keepAlive)
      this.running = undefined
    }
  }

  /** Reset the worker's idle timeout only while a disk export is in progress. */
  private keepActiveWriteAlive = (): void => {
    chrome.runtime.getPlatformInfo(this.platformInfoRead)
  }

  /** Read a callback-scoped keepalive error without exposing it as an unhandled browser error. */
  private platformInfoRead = (): void => { void chrome.runtime.lastError }

  /** Schedule collection mutations and settings changes while ignoring progress, drafts, and request history. */
  private storageChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
    if (area !== 'local') return
    for (const key of Object.keys(changes)) {
      if (key === COLLECTION_INDEX_KEY || key.startsWith(COLLECTION_KEY_PREFIX)) return this.schedule()
    }
    if (changes[DISK_SYNC_KEY] && configurationChanged(changes[DISK_SYNC_KEY])) this.schedule()
  }

  /** Accept flush requests only from this extension's own pages. */
  private handleMessage = (
    message: {type?: string}, sender: chrome.runtime.MessageSender, respond: (result: {error?: string}) => void
  ): boolean => {
    if (message?.type !== 'sync-collections-to-disk') return false
    const extensionRoot = chrome.runtime.getURL('')
    const senderUrl = sender.url ?? ''
    const fromExtension = sender.id === chrome.runtime.id
    const fromExtensionPage = senderUrl.startsWith(extensionRoot)
    if (!fromExtension || !fromExtensionPage) return false
    /** Confirm that the background finished checking pending saved changes. */
    function synced(): void { respond({}) }
    /** Keep a failed persistence operation visible to the user who requested the retry. */
    function failed(): void { respond({error: 'Could not read or save sync progress. Select Retry to try again.'}) }
    void this.flush().then(synced, failed)
    return true
  }

  /** Notify open sidebars even when storage cannot record the failure; saved source data remains recoverable. */
  private reportFailure = (error: unknown): void => {
    console.error('Could not finish collection disk sync.', error)
    chrome.runtime.sendMessage({type: 'disk-sync-failed'}, this.failureReported)
  }

  /** No reply is expected when every sidebar has closed. */
  private failureReported = (): void => { void chrome.runtime.lastError }
}
