/** Collection env data and edits. Callers supply IDs and persist changes; no browser APIs are used here. */
import type {EditorState} from '../history/request-state'

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

export function createFork(env: LevelEnv, id: string, input: string): EnvFork {
  const name = input.trim()
  if (!name) throw new Error('Enter a fork name.')
  if (env.forks.some((fork) => fork.name === name)) throw new Error('This fork name already exists.')
  const fork = {id, name, variables: env.baseNames.map((name) => ({name, value: ''}))}
  env.forks.push(fork)
  return fork
}

export function setForkValue(env: LevelEnv, forkId: string, name: string, value: string): void {
  const variable = env.forks.find(({id}) => id === forkId)?.variables.find((variable) => variable.name === name)
  if (!variable) throw new Error('This variable is no longer available.')
  variable.value = value
}

/** The empty option represents No env; callers render its label. Accept a chain for later nested levels. */
export function pickerOptions(envs: readonly (LevelEnv | undefined)[]): {name: string | null; label: string}[] {
  const names = new Set(envs.flatMap((env) => env?.forks.map(({name}) => name) ?? []))
  return [{name: null, label: 'No env'}, ...[...names].sort().map((name) => ({name, label: name}))]
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
  resolved.url = replace(editor.url)
  for (const rows of [resolved.params, resolved.headers]) {
    for (const row of rows) {
      if (!row.enabled) continue
      row.key = replace(row.key)
      row.value = replace(row.value)
    }
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
