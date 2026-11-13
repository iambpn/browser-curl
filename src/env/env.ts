/** Collection env data and edits. Callers supply IDs and persist changes; no browser APIs are used here. */
import type {EditorState} from '../history/request-state'
import {editorUrlParts, encodeEditorParameter} from '../requests/editor-url.ts'

export interface EnvVariable {
  name: string
  value: string
}

export interface EnvFork {
  id: string
  name: string
  variables: EnvVariable[]
}

export interface LevelEnv {
  baseNames: string[]
  forks: EnvFork[]
}

export function createEnv(): LevelEnv {
  return {baseNames: [], forks: []}
}

/** Trim before comparing; names remain case-sensitive. Validate before mutating. */
function variableName(input: string): string {
  const name = input.trim()
  if (!name) throw new Error('Enter a variable name.')
  if (/[{}]/.test(name)) throw new Error('Variable names cannot contain { or }.')
  return name
}

export function addBaseName(env: LevelEnv, input: string): void {
  const name = variableName(input)
  if (env.baseNames.includes(name)) throw new Error('This variable name already exists.')
  env.baseNames.push(name)
  for (const fork of env.forks) {
    if (!fork.variables.some((variable) => variable.name === name)) fork.variables.push({name, value: ''})
  }
}

/** Removing a base name never removes local fork values. */
export function removeBaseName(env: LevelEnv, name: string): void {
  env.baseNames = env.baseNames.filter((existing) => existing !== name)
}

/** Rename as remove/add, validating first so a rejected edit loses no names or values. */
export function renameBaseName(env: LevelEnv, oldName: string, input: string): void {
  const name = variableName(input)
  if (!env.baseNames.includes(oldName)) throw new Error('This variable is no longer available.')
  if (name === oldName) return
  if (env.baseNames.includes(name)) throw new Error('This variable name already exists.')
  removeBaseName(env, oldName)
  addBaseName(env, name)
}

export function createFork(env: LevelEnv, id: string, input: string): EnvFork {
  const name = forkName(env, input)
  const fork = {id, name, variables: env.baseNames.map((name) => ({name, value: ''}))}
  env.forks.push(fork)
  return fork
}

function forkName(env: LevelEnv, input: string, exceptId?: string): string {
  const name = input.trim()
  if (!name) throw new Error('Enter a fork name.')
  if (env.forks.some((fork) => fork.id !== exceptId && fork.name === name)) throw new Error('This fork name already exists.')
  return name
}

export function renameFork(env: LevelEnv, forkId: string, input: string): void {
  const fork = findFork(env, forkId)
  fork.name = forkName(env, input, forkId)
}

/** Call against the latest saved env so values added in another panel also require confirmation. */
export function deleteFork(env: LevelEnv, forkId: string, confirmed = false): boolean {
  const fork = findFork(env, forkId)
  if (!confirmed && fork.variables.some(({value}) => value !== '')) return false
  env.forks.splice(env.forks.indexOf(fork), 1)
  return true
}

export function setForkValue(env: LevelEnv, forkId: string, name: string, value: string): void {
  const variable = env.forks.find(({id}) => id === forkId)?.variables.find((variable) => variable.name === name)
  if (!variable) throw new Error('This variable is no longer available.')
  variable.value = value
}

function findFork(env: LevelEnv, forkId: string): EnvFork {
  const fork = env.forks.find(({id}) => id === forkId)
  if (!fork) throw new Error('This fork is no longer available.')
  return fork
}

export function addForkVariable(env: LevelEnv, forkId: string, input: string): void {
  const name = variableName(input)
  const fork = findFork(env, forkId)
  if (env.baseNames.includes(name) || fork.variables.some((variable) => variable.name === name)) {
    throw new Error('This variable name already exists.')
  }
  fork.variables.push({name, value: ''})
}

export function deleteForkVariable(env: LevelEnv, forkId: string, name: string): void {
  const fork = findFork(env, forkId)
  if (env.baseNames.includes(name)) throw new Error('Variables from the base cannot be deleted in a fork.')
  const index = fork.variables.findIndex((variable) => variable.name === name)
  if (index === -1) throw new Error('This variable is no longer available.')
  fork.variables.splice(index, 1)
}

/** Origin is derived from current base membership, never persisted on variables. */
export function forkVariables(env: LevelEnv, forkId: string): (EnvVariable & {fromBase: boolean})[] {
  const fork = findFork(env, forkId)
  return [
    ...env.baseNames.map((name) => ({name, value: fork.variables.find((variable) => variable.name === name)?.value ?? '', fromBase: true})),
    ...fork.variables.filter(({name}) => !env.baseNames.includes(name)).map((variable) => ({...variable, fromBase: false}))
  ]
}

/** The env module only needs the tree and IDs, not editor snapshots or storage. */
interface EnvLevel {
  id: string
  env?: LevelEnv
  requests?: readonly EnvLevel[]
}

/** Include every branch, since the chosen env belongs to the whole collection. */
export function collectionEnvs(collection: EnvLevel): (LevelEnv | undefined)[] {
  return [collection.env, ...(collection.requests ?? []).flatMap(collectionEnvs)]
}

/** A linked request resolves its own env, then its folders from inner to outer, then the collection. */
export function requestEnvChain(collection: EnvLevel, requestId: string): (LevelEnv | undefined)[] | undefined {
  if (!collection.requests) return collection.id === requestId ? [collection.env] : undefined
  for (const item of collection.requests) {
    const chain = requestEnvChain(item, requestId)
    if (chain) return [...chain, collection.env]
  }
}

/** The empty option represents No env; callers render its label. */
export function pickerOptions(envs: readonly (LevelEnv | undefined)[]): {name: string | null; label: string}[] {
  const names = new Set(envs.flatMap((env) => env?.forks.map(({name}) => name) ?? []))
  return [{name: null, label: 'No env'}, ...[...names].sort().map((name) => ({name, label: name}))]
}

/** Removing a level or its last matching fork also removes a stale collection selection. */
export function resetMissingChosenEnv(collection: EnvLevel & {chosenEnv?: string | null}): void {
  if (collection.chosenEnv && !pickerOptions(collectionEnvs(collection)).some(({name}) => name === collection.chosenEnv)) {
    collection.chosenEnv = null
  }
}

export type EnvResolution = {editor: EditorState; missing?: never} | {missing: string[]; editor?: never}

/** Resolve a current editor snapshot without changing the source snapshot. */
export function resolveEditor(chain: readonly (LevelEnv | undefined)[], chosenEnv: string | null, editor: EditorState): EnvResolution {
  const values = new Map<string, string>()
  if (chosenEnv !== null) {
    for (const env of chain) {
      const fork = env?.forks.find(({name}) => name === chosenEnv)
      for (const variable of fork?.variables ?? []) {
        if (variable.value !== '' && !values.has(variable.name)) values.set(variable.name, variable.value)
      }
    }
  }
  const missing = new Set<string>()
  const replace = (text: string): string => text.replace(/\{\{([^{}]*)\}\}/g, (reference, inside: string) => {
    const name = inside.trim()
    const value = values.get(name)
    if (value !== undefined) return value
    missing.add(name)
    return reference
  })
  const resolved = structuredClone(editor)
  // Params own the literal URL query, including disabled imported rows. Resolve it only through rows.
  const {address, search, hash} = editorUrlParts(editor.url)
  const resolvedAddress = replace(address)
  const resolveRows = (rows: EditorState['params']): void => {
    for (const row of rows) {
      if (!row.enabled) continue
      row.key = replace(row.key)
      row.value = replace(row.value)
    }
  }
  // Query rows occur before the fragment in the URL; retain that first-use order.
  resolveRows(resolved.params)
  const resolvedHash = replace(hash)
  resolved.url = resolvedAddress + resolvedHash
  resolveRows(resolved.headers)
  // A URL value can supply its own query. Add those rows after replacement to preserve one-pass semantics.
  const introduced = editorUrlParts(resolvedAddress)
  const introducedParams = new URLSearchParams(introduced.search.replace(/\{\{[^{}]*\}\}/g, encodeURIComponent))
  resolved.params.unshift(...Array.from(introducedParams, ([key, value]) => ({enabled: true, key, value})))
  if (search) {
    const query = resolved.params.filter((row) => row.enabled && row.key.trim())
      .map((row) => `${encodeEditorParameter(row.key)}=${encodeEditorParameter(row.value)}`).join('&')
    resolved.url = introduced.address + (query ? `?${query}` : '') + introduced.hash + resolvedHash
  }
  resolved.body = replace(editor.body)
  const authFields: Record<string, string[]> = {
    bearer: ['bearer-token'], basic: ['basic-username', 'basic-password'],
    'api-key': ['api-key-name', 'api-key-value', 'api-key-location'], custom: ['custom-authorization']
  }
  for (const field of authFields[editor.authType] ?? []) {
    if (field in resolved.authValues) resolved.authValues[field] = replace(resolved.authValues[field])
  }
  return missing.size ? {missing: [...missing]} : {editor: resolved}
}
