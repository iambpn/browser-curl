/** Shared collection and folder symbols, plus the HTTP method badge used for APIs. */

/** Books identify a collection in trees, destination pickers, and variable suggestions. */
export const COLLECTION_ROOT_ICON = '\u{1F4DA}'

/** A folder identifies a nested destination in trees, pickers, and variable suggestions. */
export const FOLDER_ICON = '\u{1F4C1}'

/** Build the existing collection/folder symbol or API method badge without adding accessible label text. */
export function collectionKindIcon(kind: 'collection' | 'folder' | 'api', method = 'API'): HTMLSpanElement {
  const icon = document.createElement('span')
  icon.className = 'collection-kind-icon'
  icon.dataset.source = kind
  icon.setAttribute('aria-hidden', 'true')
  if (kind === 'api') {
    icon.classList.add('history-method')
    icon.textContent = method
  } else {
    icon.textContent = kind === 'collection' ? COLLECTION_ROOT_ICON : FOLDER_ICON
  }
  return icon
}
