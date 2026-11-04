/**
 * Promise wrappers for chrome.storage.local.
 * The wrappers use callbacks, because the Firefox build uses the chrome namespace, which does not return promises.
 */

/** Read the given local storage keys, or every key when keys is null. */
export function readStorage(keys: string | null): Promise<Record<string, unknown>> {
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

/** Write all given values in one storage operation. Resolve after the browser accepts them. */
export function writeStorage(items: Record<string, unknown>): Promise<void> {
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

/** Delete one key or several keys from local storage. */
export function removeStorage(keys: string | string[]): Promise<void> {
  /** Finish deletion only after storage confirms it. */
  function remove(resolve: () => void, reject: (error: Error) => void): void {
    /** Surface callback-scoped storage errors without reporting success. */
    function finish(): void {
      const error = chrome.runtime.lastError
      if (error) reject(new Error(error.message))
      else resolve()
    }
    chrome.storage.local.remove(keys, finish)
  }
  return new Promise(remove)
}
