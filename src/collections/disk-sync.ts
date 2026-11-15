/** One-way Postman backups, with saved fingerprints identifying exports that still need disk writes. */
import {exportCollection, listCollections, loadCollection} from './collection-store.ts'
import {readStorage, writeStorage} from '../shared/storage.ts'
import {loadSyncDirectory} from './sync-directory.ts'

/** Local choices and progress for automatic disk sync. */
export const DISK_SYNC_KEY = 'browsercurl.diskSync'
/** Serialize settings and disk writes across the background and open sidebars. */
export const DISK_SYNC_LOCK = 'browsercurl.diskSync.write'

/** A null collection list includes future collections. Fingerprints record only successful file commits. */
export interface DiskSyncSettings {
  enabled: boolean
  directoryKey: string
  directoryName: string
  collectionIds: string[] | null
  fileNames: Record<string, string>
  fingerprints: Record<string, string>
  syncing?: boolean
  lastSyncedAt?: number
  error?: string
}

/** Read the saved configuration, or return undefined before first setup. */
export async function loadDiskSyncSettings(): Promise<DiskSyncSettings | undefined> {
  const items = await readStorage(DISK_SYNC_KEY)
  return items[DISK_SYNC_KEY] as DiskSyncSettings | undefined
}

/** Save choices without losing progress written by an earlier background export. */
export function saveDiskSyncSettings(settings: DiskSyncSettings): Promise<void> {
  if (settings.enabled && !settings.directoryKey) throw new Error('Choose a folder before enabling automatic sync.')
  if (settings.enabled && settings.collectionIds?.length === 0) throw new Error('Select at least one collection.')
  /** Merge current filenames and fingerprints while no export can change them. */
  async function save(): Promise<void> {
    const current = await loadDiskSyncSettings()
    const sameDirectory = current?.directoryKey === settings.directoryKey
    const fileNames = sameDirectory ? current.fileNames : {}
    const fingerprints = sameDirectory ? current.fingerprints ?? {} : {}
    const lastSyncedAt = sameDirectory ? current.lastSyncedAt : undefined
    const updated = {...settings, fileNames, fingerprints, lastSyncedAt, syncing: false, error: undefined}
    await writeStorage({[DISK_SYNC_KEY]: updated})
  }
  return navigator.locks.request(DISK_SYNC_LOCK, save)
}

/** Keep filenames short and unique, then reuse them after collection renames. */
function syncFileName(exportName: string, id: string): string {
  const name = exportName.replace(/\.postman_collection\.json$/, '')
  const trimmedName = name.replace(/[. ]+$/g, '')
  const safeName = trimmedName.slice(0, 60) || 'Collection'
  return `${safeName}-${id}.postman_collection.json`
}

/** Hash exported JSON without storing a second copy of request credentials in sync progress. */
async function fingerprint(json: string): Promise<string> {
  const encoder = new TextEncoder()
  const bytes = encoder.encode(json)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  let result = ''
  for (const byte of new Uint8Array(digest)) {
    const hex = byte.toString(16)
    result += hex.padStart(2, '0')
  }
  return result
}

/** Return a recovery step without exposing file contents or credentials. */
function syncError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'NotAllowedError') {
    return 'Folder access is required. Choose the folder again, then save sync settings.'
  }
  return 'Could not sync every collection. Check folder access and available disk space, then select Retry.'
}

/** Write only changed exports. Failed commits retain their earlier fingerprint for a later retry. */
export function syncCollectionsToDisk(): Promise<void> {
  /** Compare saved source data with completed exports while configuration changes wait. */
  async function syncChangedCollections(): Promise<void> {
    const settings = await loadDiskSyncSettings()
    if (!settings?.enabled) return
    settings.fingerprints ??= {}
    settings.syncing = true
    settings.error = undefined
    await writeStorage({[DISK_SYNC_KEY]: settings})
    try {
      const directory = await loadSyncDirectory(settings.directoryKey)
      if (!directory) throw new DOMException('Folder access is missing.', 'NotAllowedError')
      const permission = await directory.queryPermission({mode: 'readwrite'})
      if (permission !== 'granted') throw new DOMException('Folder access is required.', 'NotAllowedError')
      const index = await listCollections()
      for (const {id} of index) {
        const selected = settings.collectionIds?.includes(id) ?? true
        if (!selected) continue
        try {
          // Removed collections leave their existing disk backups in place.
          const collection = await loadCollection(id)
          if (!collection) continue
          const result = await exportCollection(id)
          const hash = await fingerprint(result.json)
          if (settings.fingerprints[id] === hash) continue
          if (!settings.fileNames[id]) {
            settings.fileNames[id] = syncFileName(result.fileName, id)
            await writeStorage({[DISK_SYNC_KEY]: settings})
          }
          const file = await directory.getFileHandle(settings.fileNames[id], {create: true})
          const writable = await file.createWritable()
          try {
            await writable.write(result.json)
            await writable.close()
          } catch (error) {
            try { await writable.abort() } catch { /* A failed stream may already be closed. */ }
            throw error
          }
          settings.fingerprints[id] = hash
          // A worker restart can recover remaining work from saved collections and these completed fingerprints.
          await writeStorage({[DISK_SYNC_KEY]: settings})
        } catch (error) {
          settings.error = syncError(error)
        }
      }
      if (!settings.error) settings.lastSyncedAt = Date.now()
    } catch (error) {
      settings.error = syncError(error)
    }
    settings.syncing = false
    await writeStorage({[DISK_SYNC_KEY]: settings})
  }
  return navigator.locks.request(DISK_SYNC_LOCK, syncChangedCollections)
}

/** Check enabled backups on Run, sidebar opening or closing, and explicit retries without exporting draft values. */
export async function requestDiskSync(): Promise<void> {
  const settings = await loadDiskSyncSettings()
  if (!settings?.enabled) return
  /** Send a trusted extension message and wait for the background-owned batch. */
  function request(resolve: () => void, reject: (error: Error) => void): void {
    /** Surface messaging failures while the callback-scoped browser error remains available. */
    function finish(result: {error?: string} | undefined): void {
      const error = chrome.runtime.lastError?.message ?? result?.error
      if (error) reject(new Error(error))
      else if (!result) reject(new Error('The background did not respond. Select Retry to try again.'))
      else resolve()
    }
    chrome.runtime.sendMessage({type: 'sync-collections-to-disk'}, finish)
  }
  return new Promise(request)
}
