/** Variable names and source labels for request fields; suggestions never expose stored values. */
import type {Collection, CollectionItem} from '../collections/collection-store'
import type {EnvFork} from './env'

/** A variable's source: collection root, ancestor folder, or the current API request. */
export interface EnvSuggestion {
  name: string
  source: 'collection' | 'folder' | 'api'
  sourceName: string
  /** API sources use their existing HTTP method badge. Containers have no method. */
  method?: string
}

/** The active reference spans the opening braces through an existing closing pair, when present. */
export interface VariableReference {
  start: number
  end: number
  query: string
}

/** Find an API or draft destination's ancestors, excluding unrelated branches. */
function requestPath(item: Collection | CollectionItem, requestId: string): (Collection | CollectionItem)[] | undefined {
  if (item.id === requestId) return [item]
  if ('editor' in item) return
  for (const child of item.requests) {
    const path = requestPath(child, requestId)
    if (path) return [item, ...path]
  }
}

/** Name the source level without including a request's URL or any stored value. */
function levelName(item: Collection | CollectionItem): string {
  if ('editor' in item) return item.editor.name || 'Untitled API'
  return item.name
}

/** Distinguish the root collection, its folders, and the API leaf for icon and text labels. */
function levelSource(item: Collection | CollectionItem, index: number): EnvSuggestion['source'] {
  if ('editor' in item) return 'api'
  return index === 0 ? 'collection' : 'folder'
}

/** Sort variable names for a stable, alphabetic dropdown. */
function compareSuggestionNames(left: EnvSuggestion, right: EnvSuggestion): number {
  return left.name.localeCompare(right.name)
}

/** List Base and chosen-fork names for an API or draft destination, using the nearest nonempty value source. */
export function requestEnvSuggestions(collection: Collection, requestId: string): EnvSuggestion[] {
  const path = requestPath(collection, requestId)
  if (!path) return []
  const suggestions = new Map<string, EnvSuggestion>()
  const resolved = new Set<string>()
  const labels = path.map(levelName)
  /** Match the collection-wide selection at each source level. */
  function isChosenFork(fork: EnvFork): boolean {
    return fork.name === collection.chosenEnv
  }
  for (let index = path.length - 1; index >= 0; index--) {
    const item = path[index]
    const source = levelSource(item, index)
    const sourceLabels = labels.slice(0, index + 1)
    const sourceName = sourceLabels.join(' / ')
    const badge = 'editor' in item ? {method: item.editor.method} : {}
    const fork = item.env?.forks.find(isChosenFork)
    const names = new Set(item.env?.baseNames)
    for (const variable of fork?.variables ?? []) names.add(variable.name)
    for (const name of names) {
      if (!suggestions.has(name)) suggestions.set(name, {name, source, sourceName, ...badge})
    }
    for (const variable of fork?.variables ?? []) {
      if (variable.value === '' || resolved.has(variable.name)) continue
      suggestions.set(variable.name, {name: variable.name, source, sourceName, ...badge})
      resolved.add(variable.name)
    }
  }
  const sorted = [...suggestions.values()]
  return sorted.sort(compareSuggestionNames)
}

/** Find an unfinished or edited {{reference}} at a collapsed caret without consuming surrounding text. */
export function variableReferenceAt(text: string, caret: number, selectionEnd = caret): VariableReference | undefined {
  if (caret !== selectionEnd) return
  const start = text.lastIndexOf('{{', caret - 2)
  if (start < 0 || caret < start + 2) return
  const query = text.slice(start + 2, caret)
  if (/[{}\r\n]/.test(query)) return
  const closing = text.indexOf('}}', caret)
  const remainder = closing < 0 ? '' : text.slice(caret, closing)
  const hasClosing = closing >= 0 && !/[{}\r\n]/.test(remainder)
  const end = hasClosing ? closing + 2 : caret
  return {start, end, query: query.trim()}
}
