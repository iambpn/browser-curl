/** Remember a user-approved directory with IndexedDB, which supports file system handles. */

/** A directory with the permission methods that browsers expose for external folders. */
export interface SyncDirectory extends FileSystemDirectoryHandle {
  /** Check access without opening a permission prompt during automatic sync. */
  queryPermission(options: {mode: 'readwrite'}): Promise<PermissionState>
}

/** Open the small handle database, creating its only store on first use. */
function openDatabase(): Promise<IDBDatabase> {
  /** Attach database lifecycle handlers and return the opened connection. */
  function open(resolve: (database: IDBDatabase) => void, reject: (error: Error) => void): void {
    const request = indexedDB.open('browsercurl.diskSync', 1)
    /** Create the directory store before the first transaction. */
    request.onupgradeneeded = (): void => { request.result.createObjectStore('directories') }
    /** Surface database failures instead of silently losing the chosen folder. */
    request.onerror = (): void => {
      const error = request.error ?? new Error('Could not open folder storage.')
      reject(error)
    }
    /** Return the opened connection to the transaction owner. */
    request.onsuccess = (): void => { resolve(request.result) }
  }
  return new Promise(open)
}

/** Read or write one directory handle and close the connection after the transaction settles. */
async function directoryTransaction(key: string, directory?: SyncDirectory): Promise<SyncDirectory | undefined> {
  const database = await openDatabase()
  try {
    /** Resolve only when the whole transaction commits, including a directory write. */
    function transact(resolve: (value: SyncDirectory | undefined) => void, reject: (error: Error) => void): void {
      const mode = directory ? 'readwrite' : 'readonly'
      const transaction = database.transaction('directories', mode)
      const store = transaction.objectStore('directories')
      const request = directory ? store.put(directory, key) : store.get(key)
      /** Return the read handle only after successful transaction completion. */
      transaction.oncomplete = (): void => { resolve(directory ?? request.result) }
      /** Reject aborted transactions, including structured-clone or disk failures. */
      transaction.onabort = (): void => {
        const error = transaction.error ?? new Error('Could not save folder access.')
        reject(error)
      }
    }
    return await new Promise(transact)
  } finally {
    database.close()
  }
}

/** Store the chosen directory under a fresh key before saving settings that reference it. */
export async function saveSyncDirectory(directory: SyncDirectory): Promise<string> {
  const key = crypto.randomUUID()
  await directoryTransaction(key, directory)
  return key
}

/** Load a previously approved folder without asking for new access. */
export function loadSyncDirectory(key: string): Promise<SyncDirectory | undefined> {
  return directoryTransaction(key)
}
