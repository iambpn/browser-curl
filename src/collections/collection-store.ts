/** Collections keep complete editor snapshots locally, independently of sent-request history. */
import type {CollectionRequestLink, EditorState} from '../history/request-state'
import {readStorage, removeStorage, writeStorage} from '../shared/storage'
import type {ImportedCollection, ImportedItem} from './postman-converter'
import {exportPostmanCollection} from './postman-converter'
import {collectionEnvs, createEnv, pickerOptions, resetMissingChosenEnv} from '../env/env'
import type {LevelEnv} from '../env/env'

/** One entry in the collection index, in creation order. */
export interface CollectionSummary {
  id: string
  name: string
}

/** A named request keeps inactive credentials and disabled rows as well as the active values. */
export interface CollectionRequest {
  id: string
  editor: EditorState
  env?: LevelEnv
}

/** A folder's children keep insertion order, including folders nested to any depth. */
export interface CollectionFolder {
  id: string
  name: string
  requests: CollectionItem[]
  env?: LevelEnv
}

export type CollectionItem = CollectionRequest | CollectionFolder

/** The existing requests field now holds ordered requests and folders, preserving saved flat collections. */
export interface Collection extends CollectionSummary {
  requests: CollectionItem[]
  env?: LevelEnv
  chosenEnv?: string | null
  postmanId?: string
  variables?: unknown[]
}

export const COLLECTION_INDEX_KEY = 'browsercurl.collectionIndex'
export const COLLECTION_KEY_PREFIX = 'browsercurl.collection.'

/** Give every import fresh local IDs, even when its name or Postman ID is already saved. */
export function saveImportedCollection(imported: ImportedCollection): Promise<string> {
  const snapshot = structuredClone(imported)
  return navigator.locks.request(COLLECTION_INDEX_KEY, async () => {
    const identify = (item: ImportedItem): CollectionItem => 'editor' in item
      ? {id: crypto.randomUUID(), editor: item.editor}
      : {id: crypto.randomUUID(), name: item.name, requests: item.requests.map(identify)}
    const collection: Collection = {...snapshot, id: crypto.randomUUID(), requests: snapshot.requests.map(identify), env: createEnv(), chosenEnv: null}
    const index = await listCollections()
    index.push({id: collection.id, name: collection.name})
    await writeStorage({[COLLECTION_KEY_PREFIX + collection.id]: collection, [COLLECTION_INDEX_KEY]: index})
    return collection.id
  })
}

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

/** Export the latest saved tree and persist its Postman ID before offering a download. */
export function exportCollection(id: string): Promise<{json: string; fileName: string}> {
  return navigator.locks.request(COLLECTION_INDEX_KEY, async () => {
    const collection = await loadCollection(id)
    if (!collection) throw new Error('This collection is no longer available.')
    const savedId = collection.postmanId
    const result = exportPostmanCollection(collection)
    if (collection.postmanId !== savedId) await writeStorage({[COLLECTION_KEY_PREFIX + id]: collection})
    return result
  })
}

/**
 * Add a new request to an existing collection, or create a collection with its first request.
 * The index and collection are written together so a rejected save never leaves an empty collection behind.
 */
export function addCollectionRequest(
  destination: {id: string; folderId?: string} | {name: string}, editor: EditorState
): Promise<CollectionRequestLink> {
  const snapshot = structuredClone(editor)
  async function save(): Promise<CollectionRequestLink> {
    if (!snapshot.name.trim()) throw new Error('Enter a request name.')
    const request: CollectionRequest = {id: crypto.randomUUID(), editor: snapshot}
    if ('id' in destination) {
      const collection = await loadCollection(destination.id)
      if (!collection) throw new Error('This collection is no longer available. Choose another collection.')
      childrenOf(collection, destination.folderId).push(request)
      await writeStorage({[COLLECTION_KEY_PREFIX + collection.id]: collection})
      return {collectionId: collection.id, requestId: request.id}
    }
    const name = destination.name.trim()
    if (!name) throw new Error('Enter a collection name.')
    const collection: Collection = {id: crypto.randomUUID(), name, requests: [request], env: createEnv(), chosenEnv: null}
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
    const request = collection && findCollectionRequest(collection, link.requestId)
    if (!collection || !request) return false
    if (!snapshot.name.trim()) throw new Error('Enter a request name.')
    request.editor = snapshot
    await writeStorage({[COLLECTION_KEY_PREFIX + collection.id]: collection})
    return true
  })
}

/** Find an item at any depth without changing its siblings' order. */
function findCollectionItem(collection: Collection | CollectionFolder, id: string): CollectionItem | undefined {
  for (const item of collection.requests) {
    if (item.id === id) return item
    if ('requests' in item) {
      const found = findCollectionItem(item, id)
      if (found) return found
    }
  }
}

/** Locate the env's owner without depending on its current place in the tree. */
export function findCollectionLevel(collection: Collection, id: string): Collection | CollectionItem | undefined {
  return id === collection.id ? collection : findCollectionItem(collection, id)
}

/** Resolve request links independently of the folder that currently contains them. */
export function findCollectionRequest(collection: Collection, id: string): CollectionRequest | undefined {
  const item = findCollectionItem(collection, id)
  return item && 'editor' in item ? item : undefined
}

function childrenOf(collection: Collection, folderId?: string): CollectionItem[] {
  if (!folderId) return collection.requests
  const folder = findCollectionItem(collection, folderId)
  if (!folder || !('requests' in folder)) throw new Error('This folder is no longer available.')
  return folder.requests
}

/** Create an empty collection and its index entry under the shared write lock. */
export function createCollection(name: string): Promise<void> {
  return navigator.locks.request(COLLECTION_INDEX_KEY, async () => {
    name = name.trim()
    if (!name) throw new Error('Enter a collection name.')
    const collection: Collection = {id: crypto.randomUUID(), name, requests: [], env: createEnv(), chosenEnv: null}
    const index = await listCollections()
    index.push({id: collection.id, name})
    await writeStorage({[COLLECTION_KEY_PREFIX + collection.id]: collection, [COLLECTION_INDEX_KEY]: index})
  })
}

/** Apply env edits to the latest saved collection under the same lock as all collection writes. */
export function editCollectionEnv(id: string, edit: (env: LevelEnv) => void, levelId = id): Promise<Collection> {
  return navigator.locks.request(COLLECTION_INDEX_KEY, async () => {
    const collection = await loadCollection(id)
    if (!collection) throw new Error('This collection is no longer available.')
    const level = findCollectionLevel(collection, levelId)
    if (!level) throw new Error('This item is no longer available.')
    level.env ??= createEnv()
    edit(level.env)
    resetMissingChosenEnv(collection)
    await writeStorage({[COLLECTION_KEY_PREFIX + id]: collection})
    return collection
  })
}

/** Persist the picker selection independently of the current request's editor snapshot. */
export function chooseCollectionEnv(id: string, name: string | null): Promise<void> {
  return navigator.locks.request(COLLECTION_INDEX_KEY, async () => {
    const collection = await loadCollection(id)
    if (!collection) throw new Error('This collection is no longer available.')
    if (!pickerOptions(collectionEnvs(collection)).some((option) => option.name === name)) throw new Error('This env is no longer available.')
    collection.chosenEnv = name
    await writeStorage({[COLLECTION_KEY_PREFIX + id]: collection})
  })
}

/** Append a folder to a collection or folder, preserving creation order. */
export function addCollectionFolder(collectionId: string, name: string, folderId?: string): Promise<void> {
  return navigator.locks.request(COLLECTION_INDEX_KEY, async () => {
    name = name.trim()
    if (!name) throw new Error('Enter a folder name.')
    const collection = await loadCollection(collectionId)
    if (!collection) throw new Error('This collection is no longer available.')
    childrenOf(collection, folderId).push({id: crypto.randomUUID(), name, requests: []})
    await writeStorage({[COLLECTION_KEY_PREFIX + collection.id]: collection})
  })
}

/** Rename a collection, folder, or request without altering editor values or item order. */
export function renameCollectionItem(collectionId: string, itemId: string, name: string): Promise<void> {
  return navigator.locks.request(COLLECTION_INDEX_KEY, async () => {
    name = name.trim()
    if (!name) throw new Error('Enter a name.')
    const collection = await loadCollection(collectionId)
    if (!collection) throw new Error('This collection is no longer available.')
    const item = itemId === collectionId ? collection : findCollectionItem(collection, itemId)
    if (!item) throw new Error('This item is no longer available.')
    if ('editor' in item) item.editor.name = name
    else item.name = name
    const writes: Record<string, unknown> = {[COLLECTION_KEY_PREFIX + collection.id]: collection}
    if (item === collection) {
      const index = await listCollections()
      const summary = index.find(({id}) => id === collectionId)
      if (summary) summary.name = name
      writes[COLLECTION_INDEX_KEY] = index
    }
    await writeStorage(writes)
  })
}

/** Recheck content under the lock so a concurrently filled container also needs confirmation. */
export function deleteCollectionItem(collectionId: string, itemId: string, confirmed = false): Promise<boolean> {
  return navigator.locks.request(COLLECTION_INDEX_KEY, async () => {
    const collection = await loadCollection(collectionId)
    if (itemId === collectionId) {
      if (collection?.requests.length && !confirmed) return false
      const index = (await listCollections()).filter(({id}) => id !== collectionId)
      // Remove credentials first. A retry must clean the index even if removal already succeeded.
      await removeStorage(COLLECTION_KEY_PREFIX + collectionId)
      await writeStorage({[COLLECTION_INDEX_KEY]: index})
      return true
    }
    if (!collection) return true
    const item = findCollectionItem(collection, itemId)
    if (!item) return true
    if ('requests' in item && item.requests.length && !confirmed) return false
    const remove = (parent: Collection | CollectionFolder): boolean => {
      const index = parent.requests.findIndex(({id}) => id === itemId)
      if (index !== -1) {
        parent.requests.splice(index, 1)
        return true
      }
      return parent.requests.some((child) => 'requests' in child && remove(child))
    }
    remove(collection)
    resetMissingChosenEnv(collection)
    await writeStorage({[COLLECTION_KEY_PREFIX + collectionId]: collection})
    return true
  })
}
