/** In-panel collection browsing and Save as forms. Collection writes stay in the side panel. */
import {
  addCollectionFolder, addCollectionRequest, COLLECTION_INDEX_KEY, COLLECTION_KEY_PREFIX, createCollection,
  deleteCollectionItem, findCollectionRequest, listCollections, loadCollection, renameCollectionItem, updateCollectionRequest
} from '../collections/collection-store'
import type {Collection, CollectionFolder, CollectionItem} from '../collections/collection-store'
import type {CollectionRequestLink, EditorState} from '../history/request-state'
import {resolveRequestName} from '../history/request-state'

/** Find a required control in the sidebar's static markup. */
function element<T extends HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector)
  if (!node) throw new Error(`Missing collections element: ${selector}`)
  return node
}

/** Compare complete editor values, treating an absent row group like the editor's default blank row. */
function editorValues(editor: EditorState): string {
  const rows = (entries: EditorState['params']) => (entries.length ? entries : [{enabled: true, key: '', value: ''}])
    .map(({enabled, key, value}) => [enabled, key, value])
  return JSON.stringify([
    editor.name, editor.method, editor.url, rows(editor.params), rows(editor.headers),
    editor.body, editor.bodyType, editor.authType,
    Object.entries(editor.authValues).sort(([a], [b]) => a.localeCompare(b))
  ])
}

/** An untouched editor (on startup or after Clear) has only default controls and blank inputs. */
function isEmptyEditor(editor: EditorState): boolean {
  return !editor.name && !editor.url && !editor.body && editor.method === 'GET' && editor.bodyType === 'json'
    && ['none', 'bearer'].includes(editor.authType)
    && [...editor.params, ...editor.headers].every((row) => row.enabled && !row.key && !row.value)
    && Object.entries(editor.authValues).every(([key, value]) => value === (key === 'api-key-location' ? 'header' : ''))
}

/** Coordinate collection dialogs with the editor through its existing snapshot interface. */
export class CollectionsPanel {
  private dialog = element<HTMLDialogElement>('#collections-dialog')
  private list = element('#collections-list')
  private empty = element('#collections-empty')
  private error = element('#collections-error')
  private saveDialog = element<HTMLDialogElement>('#save-as-dialog')
  private form = element<HTMLFormElement>('#save-as-form')
  private name = element<HTMLInputElement>('#save-request-name')
  private picker = element<HTMLSelectElement>('#save-collection')
  private newName = element<HTMLInputElement>('#new-collection-name')
  private saveError = element('#save-as-error')
  private confirm = element<HTMLButtonElement>('#confirm-save-as')
  private status = element('#collection-save-status')
  private warning = element('#collection-unsaved-warning')
  private deleteWarning = element('#collection-delete-warning')
  private pendingDelete: {collectionId: string; itemId: string; name: string} | undefined
  private collapsed = new Set<string>()
  private creatingIn: {collectionId: string; folderId?: string} | undefined
  private createForm = element<HTMLFormElement>('#collection-item-form')
  private createName = element<HTMLInputElement>('#collection-item-name')
  private pendingLoad: CollectionRequestLink | undefined
  private openRevision = 0
  private refresh = 0
  private pickerRefresh = 0
  private pickerReady = false
  private saving = false
  private statusTimer: ReturnType<typeof setTimeout> | undefined
  private disposed = false

  constructor(
    private readEditor: () => EditorState,
    private openEditor: (editor: EditorState, link: CollectionRequestLink) => void,
    private readLink: () => CollectionRequestLink | undefined,
    private linkEditor: (link: CollectionRequestLink, name?: string) => void,
    private readEditorRevision: () => number
  ) {
    element('#show-collections').addEventListener('click', this.show)
    element('#close-collections').addEventListener('click', () => this.dialog.close())
    element('#save-as').addEventListener('click', this.showSaveAs)
    element('#save-request').addEventListener('click', this.saveLinked)
    element('#cancel-save-as').addEventListener('click', () => this.saveDialog.close())
    this.picker.addEventListener('change', this.updateNewCollection)
    this.form.addEventListener('submit', this.save)
    this.list.addEventListener('click', this.openRequest)
    element('#new-collection').addEventListener('click', () => this.showCreate())
    element('#cancel-collection-item').addEventListener('click', () => { this.createForm.hidden = true })
    this.createForm.addEventListener('submit', this.createItem)
    element('#cancel-collection-delete').addEventListener('click', this.cancelDelete)
    element('#confirm-collection-delete').addEventListener('click', () => {
      if (this.pendingDelete) void this.deleteItem(this.pendingDelete, true)
    })
    this.dialog.addEventListener('close', this.cancelDelete)
    element('#cancel-collection-load').addEventListener('click', this.cancelLoad)
    element('#discard-collection-changes').addEventListener('click', () => {
      if (this.pendingLoad) void this.loadRequest(this.pendingLoad, true)
    })
    this.dialog.addEventListener('close', this.cancelLoad)
    chrome.storage.onChanged.addListener(this.storageChanged)
    window.addEventListener('pagehide', this.dispose, {once: true})
  }

  /** Open a fresh view of all saved collections. Native dialog Escape returns to the editor. */
  private show = (): void => {
    this.cancelLoad()
    this.createForm.hidden = true
    this.dialog.showModal()
    void this.render()
  }

  /** Read each indexed collection and ignore results superseded by newer storage events. */
  private async render(): Promise<void> {
    const refresh = ++this.refresh
    try {
      const index = await listCollections()
      const collections = await Promise.all(index.map((summary) => loadCollection(summary.id)))
      if (refresh !== this.refresh || this.disposed) return
      const items = collections.filter((collection): collection is Collection => Boolean(collection))
      this.list.replaceChildren(...items.map((collection) => this.collectionItem(collection)))
      this.empty.hidden = items.length !== 0
      this.error.hidden = true
    } catch {
      if (refresh !== this.refresh || this.disposed) return
      this.error.textContent = 'Could not read collections. Close this panel and try again.'
      this.error.hidden = false
    }
  }

  /** Build a recursive tree using textContent for all saved names. */
  private collectionItem(collection: Collection): HTMLLIElement {
    return this.treeItem(collection, collection, 0)
  }

  private treeItem(collection: Collection, item: Collection | CollectionItem, depth: number): HTMLLIElement {
    const node = document.createElement('li')
    const row = document.createElement('div')
    row.className = 'collection-row'
    row.style.paddingLeft = `${12 + depth * 18}px`
    const isRequest = 'editor' in item
    const name = isRequest ? item.editor.name : item.name
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'collection-request'
    if (isRequest) {
      button.dataset.openCollectionRequest = item.id
      button.dataset.collectionId = collection.id
      const method = document.createElement('span')
      method.className = 'history-method'
      method.dataset.collectionMethod = ''
      method.textContent = item.editor.method
      button.append(method)
    } else {
      const collapsed = this.collapsed.has(item.id)
      button.setAttribute('aria-expanded', String(!collapsed))
      button.setAttribute('aria-label', `${collapsed ? 'Expand' : 'Collapse'} ${name}`)
      const icon = document.createElement('span')
      icon.textContent = collapsed ? '▸' : '▾'
      icon.setAttribute('aria-hidden', 'true')
      button.append(icon)
      button.addEventListener('click', () => {
        if (this.collapsed.has(item.id)) this.collapsed.delete(item.id)
        else this.collapsed.add(item.id)
        void this.render()
      })
    }
    const label = document.createElement('span')
    label.className = 'history-name'
    label.dataset.itemName = ''
    if (isRequest) label.dataset.collectionRequestName = ''
    else if (item.id === collection.id) label.dataset.collectionName = ''
    else label.dataset.folderName = ''
    label.textContent = name
    button.append(label)
    row.append(button)
    if (!isRequest) {
      row.append(this.action('Add folder', () => this.showCreate(collection.id, item.id === collection.id ? undefined : item.id)))
    }
    row.append(this.action('Rename', () => this.renameItem(collection.id, item.id, name, row, button)))
    row.append(this.action('Delete', () => { void this.deleteItem({collectionId: collection.id, itemId: item.id, name}) }))
    node.append(row)
    if (!isRequest) {
      const children = document.createElement('ul')
      children.className = 'collection-children'
      children.hidden = this.collapsed.has(item.id)
      children.setAttribute('aria-label', `${name} items`)
      for (const child of item.requests) children.append(this.treeItem(collection, child, depth + 1))
      node.append(children)
    }
    return node
  }

  private action(name: string, run: () => void): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'text-button collection-action'
    button.textContent = name
    button.addEventListener('click', run)
    return button
  }

  /** Commit inline on blur or Enter, and restore the saved name on empty input or Escape. */
  private renameItem(collectionId: string, itemId: string, name: string, row: HTMLElement, button: HTMLButtonElement): void {
    if (row.querySelector('input')) return
    const input = document.createElement('input')
    input.className = 'auth-input collection-rename'
    input.setAttribute('aria-label', 'Name')
    input.value = name
    button.hidden = true
    row.prepend(input)
    let cancelled = false
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== 'Escape') return
      event.preventDefault()
      cancelled = event.key === 'Escape'
      input.blur()
      button.focus()
    })
    input.addEventListener('blur', async () => {
      const value = input.value.trim()
      input.remove()
      button.hidden = false
      if (cancelled || value === name) return
      if (!value) return this.showError('Enter a name.')
      try {
        await renameCollectionItem(collectionId, itemId, value)
        await this.render()
      } catch {
        this.showError('Could not rename this item. Try again.')
      }
    }, {once: true})
    input.focus()
    input.select()
  }

  private cancelDelete = (): void => {
    this.pendingDelete = undefined
    this.deleteWarning.hidden = true
  }

  /** Recheck current storage before deciding whether a container needs confirmation. */
  private async deleteItem(target: {collectionId: string; itemId: string; name: string}, confirmed = false): Promise<void> {
    const confirm = element<HTMLButtonElement>('#confirm-collection-delete')
    if (confirm.disabled) return
    confirm.disabled = true
    try {
      const deleted = await deleteCollectionItem(target.collectionId, target.itemId, confirmed)
      if (!this.dialog.open || this.disposed) return
      if (!deleted) {
        this.pendingDelete = target
        element('#collection-delete-message').textContent = `Delete “${target.name}” and everything inside it?`
        this.deleteWarning.hidden = false
        element('#cancel-collection-delete').focus()
      } else {
        this.cancelDelete()
        await this.render()
      }
    } catch {
      this.showError('Could not delete this item. Try again.')
    } finally {
      confirm.disabled = false
    }
  }

  private showCreate(collectionId?: string, folderId?: string): void {
    this.creatingIn = collectionId ? {collectionId, folderId} : undefined
    element('#collection-item-label').textContent = collectionId ? 'Folder name' : 'Collection name'
    this.createName.value = ''
    this.createForm.hidden = false
    this.createName.focus()
  }

  private createItem = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault()
    const name = this.createName.value.trim()
    if (!name) return this.showError('Enter a name.')
    const button = element<HTMLButtonElement>('#confirm-collection-item')
    if (button.disabled) return
    button.disabled = true
    try {
      const parent = this.creatingIn
      if (parent) {
        await addCollectionFolder(parent.collectionId, name, parent.folderId)
        this.collapsed.delete(parent.folderId ?? parent.collectionId)
      } else await createCollection(name)
      this.createForm.hidden = true
      await this.render()
    } catch {
      this.showError('Could not create this item. Try again.')
    } finally {
      button.disabled = false
    }
  }

  private showError(message: string): void {
    this.error.textContent = message
    this.error.hidden = false
  }

  /** Reload the selected request at click time instead of opening a stale cached snapshot. */
  private openRequest = async (event: MouseEvent): Promise<void> => {
    const button = (event.target as Element).closest<HTMLButtonElement>('[data-open-collection-request]')
    if (!button) return
    await this.loadRequest({collectionId: button.dataset.collectionId!, requestId: button.dataset.openCollectionRequest!})
  }

  /** Protect current edits with an in-panel choice, then re-read the destination when Discard is selected. */
  private async loadRequest(link: CollectionRequestLink, discard = false): Promise<void> {
    const revision = ++this.openRevision
    try {
      const collection = await loadCollection(link.collectionId)
      const request = collection && findCollectionRequest(collection, link.requestId)
      if (!request) throw new Error('Request is no longer available.')
      const dirty = !discard && await this.hasUnsavedChanges()
      if (revision !== this.openRevision || !this.dialog.open || this.disposed) return
      if (dirty) {
        this.pendingLoad = link
        this.warning.hidden = false
        element('#cancel-collection-load').focus()
        return
      }
      this.openEditor(request.editor, link)
      this.dialog.close()
    } catch {
      if (revision !== this.openRevision || !this.dialog.open || this.disposed) return
      this.error.textContent = 'Could not open this saved request. Close this panel and try again.'
      this.error.hidden = false
    }
  }

  /** Compare against storage at load time, including changes made by another open panel. */
  private async hasUnsavedChanges(): Promise<boolean> {
    const link = this.readLink()
    if (!link) return !isEmptyEditor(this.readEditor())
    const collection = await loadCollection(link.collectionId)
    const request = collection && findCollectionRequest(collection, link.requestId)
    return !request || editorValues(request.editor) !== editorValues(this.readEditor())
  }

  /** Cancel and closing the panel never replace the editor or retain a pending discard action. */
  private cancelLoad = (): void => {
    this.openRevision += 1
    this.pendingLoad = undefined
    this.warning.hidden = true
  }

  /** Suggest the current editor name and offer existing collections alongside New collection. */
  private showSaveAs = (): void => {
    const editor = this.readEditor()
    this.name.value = resolveRequestName(editor.name, editor.url)
    this.newName.value = ''
    this.saveError.hidden = true
    this.status.hidden = true
    this.picker.replaceChildren()
    this.saveDialog.showModal()
    void this.refreshPicker()
  }

  /** Refresh destinations without losing an in-progress form or the user's selected collection. */
  private async refreshPicker(): Promise<void> {
    const refresh = ++this.pickerRefresh
    const selected = this.picker.value
    this.pickerReady = false
    this.confirm.disabled = true
    try {
      const index = await listCollections()
      const collections = await Promise.all(index.map(({id}) => loadCollection(id)))
      if (refresh !== this.pickerRefresh || this.disposed) return
      this.renderPicker(collections.filter((item): item is Collection => Boolean(item)), selected)
      this.pickerReady = true
      this.confirm.disabled = this.saving
    } catch {
      if (refresh !== this.pickerRefresh || this.disposed) return
      this.saveError.textContent = 'Could not read collections. Close this form and try again.'
      this.saveError.hidden = false
    }
  }

  /** Keep New collection selected on first use when the index is empty. */
  private renderPicker(collections: Collection[], selected: string): void {
    const options: HTMLOptionElement[] = []
    const append = (collection: Collection, item: Collection | CollectionFolder, depth: number): void => {
      const value = item.id === collection.id ? collection.id : `${collection.id}/${item.id}`
      options.push(new Option('\u00a0\u00a0'.repeat(depth) + item.name, value))
      for (const child of item.requests) if ('requests' in child) append(collection, child, depth + 1)
    }
    for (const collection of collections) append(collection, collection, 0)
    options.push(new Option('New collection', 'new'))
    this.picker.replaceChildren(...options)
    if (options.some((option) => option.value === selected)) this.picker.value = selected
    this.updateNewCollection()
  }

  /** Require a new collection name only when the user chooses to create one. */
  private updateNewCollection = (): void => {
    const isNew = this.picker.value === 'new'
    element('#new-collection-field').hidden = !isNew
    this.newName.required = isNew
  }

  /** Report success only after storage accepts both the collection and its index. */
  private save = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault()
    if (this.saving || !this.pickerReady) return
    const name = this.name.value.trim()
    const collectionName = this.newName.value.trim()
    const isNew = this.picker.value === 'new'
    if (!name || (isNew && !collectionName)) {
      this.saveError.textContent = !name ? 'Enter a request name.' : 'Enter a collection name.'
      this.saveError.hidden = false
      return
    }
    this.saving = true
    this.confirm.disabled = true
    this.saveError.hidden = true
    try {
      const editorRevision = this.readEditorRevision()
      const editor = this.readEditor()
      const [id, folderId] = this.picker.value.split('/')
      const destination = isNew ? {name: collectionName} : {id, folderId}
      const link = await addCollectionRequest(destination, {...editor, name})
      // The snapshot is saved, but Clear or loading another request must keep its own editor and link.
      if (this.disposed || editorRevision !== this.readEditorRevision()) return
      // Link the saved copy, but apply its name only if the user has not edited the name while saving.
      this.linkEditor(link, this.readEditor().name === editor.name ? name : undefined)
      this.saveDialog.close()
      this.showSavedStatus()
    } catch {
      this.saveError.textContent = 'Could not save this request to the collection. Your request was not saved. Try again.'
      this.saveError.hidden = false
    } finally {
      this.saving = false
      this.confirm.disabled = !this.pickerReady
    }
  }

  /** Save back to the linked request, or let the user choose a destination when the link is absent or deleted. */
  private saveLinked = async (): Promise<void> => {
    if (this.saving) return
    const link = this.readLink()
    if (!link) return this.showSaveAs()
    this.saving = true
    clearTimeout(this.statusTimer)
    this.status.hidden = true
    try {
      const saved = await updateCollectionRequest(link, this.readEditor())
      if (saved) this.showSavedStatus()
      else this.showSaveAs()
    } catch {
      this.status.textContent = 'Could not save this request to the collection. Your request was not saved. Try again.'
      this.status.hidden = false
    } finally {
      this.saving = false
      this.confirm.disabled = !this.pickerReady
    }
  }

  /** Confirm successful storage writes briefly beside the Save actions. */
  private showSavedStatus(): void {
    this.status.textContent = 'Request saved to collection.'
    this.status.hidden = false
    clearTimeout(this.statusTimer)
    this.statusTimer = setTimeout(() => { this.status.hidden = true }, 4000)
  }

  /** Refresh open collection views for changes from this panel or another side panel. */
  private storageChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
    if (area !== 'local' || this.disposed) return
    const changed = Object.keys(changes).some((key) => key === COLLECTION_INDEX_KEY || key.startsWith(COLLECTION_KEY_PREFIX))
    if (!changed) return
    if (this.dialog.open) void this.render()
    if (this.saveDialog.open) void this.refreshPicker()
  }

  /** Detach the collection listener when the side panel closes. */
  private dispose = (): void => {
    this.disposed = true
    clearTimeout(this.statusTimer)
    chrome.storage.onChanged.removeListener(this.storageChanged)
  }
}
