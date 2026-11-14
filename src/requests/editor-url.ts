/** URL text helpers shared by editor synchronization and env resolution, before HTTP validation. */
/** Split editor text without validating or normalizing an unresolved URL. Skip delimiters inside references. */
export function editorUrlParts(text: string): {address: string; search: string; hash: string} {
  let query = -1
  let fragment = text.length
  for (const match of text.matchAll(/\{\{[^{}]*\}\}|[?#]/g)) {
    if (match[0] === '#') {
      fragment = match.index
      break
    }
    if (match[0] === '?' && query < 0) query = match.index
  }
  return {
    address: text.slice(0, query < 0 ? fragment : query),
    search: query < 0 ? '' : text.slice(query, fragment),
    hash: text.slice(fragment)
  }
}

/** Encode literal query text while leaving variable references available to the resolver and editor. */
export function encodeEditorParameter(value: string): string {
  return value.split(/(\{\{[^{}]*\}\})/g).map((part, index) =>
    index % 2 ? part : new URLSearchParams([['', part]]).toString().slice(1)
  ).join('')
}

