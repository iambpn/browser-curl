/** Collections keep complete editor snapshots locally, independently of sent-request history. */
import type {CollectionRequestLink, EditorState} from '../history/request-state'
import {readStorage, writeStorage} from '../shared/storage'

/** One entry in the collection index, in creation order. */
export interface CollectionSummary {
  id: string
  name: string
}

/** A named request keeps inactive credentials and disabled rows as well as the active values. */
export interface CollectionRequest {
  id: string
  editor: EditorState
}

/** Requests are stored together under their collection's own storage key. */
export interface Collection extends CollectionSummary {
  requests: CollectionRequest[]
}

export const COLLECTION_INDEX_KEY = 'browsercurl.collectionIndex'
export const COLLECTION_KEY_PREFIX = 'browsercurl.collection.'

/** Read the small collection index without reading editor values or credentials. */
export async function listCollections(): Promise<CollectionSummary[]> {
  const items = await readStorage(COLLECTION_INDEX_KEY)
  return (items[COLLECTION_INDEX_KEY] as CollectionSummary[] | undefined) ?? []
}

/** Read one collection, or undefined if it no longer exists. */
export async function loadCollection(id: string): Promise<Collection | undefined> {
  const key = COLLECTION_KEY_PREFIX + id
  const items = await readStorage(key)
  return items[key] as Collection | undefined
}

/**
 * Add a new request to an existing collection, or create a collection with its first request.
 * The index and collection are written together so a rejected save never leaves an empty collection behind.
 */
export function addCollectionRequest(
  destination: {id: string} | {name: string}, editor: EditorState
): Promise<CollectionRequestLink> {
  const snapshot = structuredClone(editor)
  async function save(): Promise<CollectionRequestLink> {
    if (!snapshot.name.trim()) throw new Error('Enter a request name.')
    const request: CollectionRequest = {id: crypto.randomUUID(), editor: snapshot}
    if ('id' in destination) {
      const collection = await loadCollection(destination.id)
      if (!collection) throw new Error('This collection is no longer available. Choose another collection.')
      collection.requests.push(request)
      await writeStorage({[COLLECTION_KEY_PREFIX + collection.id]: collection})
      return {collectionId: collection.id, requestId: request.id}
    }
    const name = destination.name.trim()
    if (!name) throw new Error('Enter a collection name.')
    const collection: Collection = {id: crypto.randomUUID(), name, requests: [request]}
    const index = await listCollections()
    index.push({id: collection.id, name})
    await writeStorage({[COLLECTION_KEY_PREFIX + collection.id]: collection, [COLLECTION_INDEX_KEY]: index})
    return {collectionId: collection.id, requestId: request.id}
  }
  // Web Locks serialize mutations across every panel on the extension origin. Use one lock
  // for collections and their shared index, covering all reads through the completed write.
  // The browser releases the lock on success, failure, or when the panel closes.
  return navigator.locks.request(COLLECTION_INDEX_KEY, save)
}

/** Replace every editor value under the same write lock as additions. Missing requests are never recreated. */
export function updateCollectionRequest(link: CollectionRequestLink, editor: EditorState): Promise<boolean> {
  const snapshot = structuredClone(editor)
  return navigator.locks.request(COLLECTION_INDEX_KEY, async () => {
    const collection = await loadCollection(link.collectionId)
    const request = collection?.requests.find((request) => request.id === link.requestId)
    if (!collection || !request) return false
    if (!snapshot.name.trim()) throw new Error('Enter a request name.')
    request.editor = snapshot
    await writeStorage({[COLLECTION_KEY_PREFIX + collection.id]: collection})
    return true
  })
}
