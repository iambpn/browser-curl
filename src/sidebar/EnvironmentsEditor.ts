/** Edit one collection, folder, or request env. All writes operate on fresh storage. */
import {editCollectionEnv, findCollectionLevel, loadCollection} from '../collections/collection-store'
import type {Collection, CollectionItem} from '../collections/collection-store'
import {addBaseName, addForkVariable, collectionEnvs, createEnv, deleteFork, deleteForkVariable, forkEnv, forkVariables, pickerOptions, removeBaseName, renameBaseName, renameFork, setForkValue} from '../env/env'
import type {EnvVariable, LevelEnv} from '../env/env'

/** Find a required control in the sidebar's static markup. */
function element<T extends HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector)
  if (!node) throw new Error(`Missing env element: ${selector}`)
  return node
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'

/**
 * Stroked 24x24 SVG paths for the env tab actions.
 * - `fork`: create a fork from the selected tab.
 * - `rename`: edit the selected fork's name in its tab.
 * - `remove`: delete the selected fork after a second click.
 */
const ICON_PATHS = {
  fork: [
    'M9 6a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z', 'M21 6a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z', 'M15 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
    'M18 9v2a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V9', 'M12 12v3'
  ],
  rename: ['M12 20h9', 'M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z'],
  remove: ['M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6m4-6v6']
} as const

/** Build a decorative icon from stroked paths. Screen readers use the button label instead. */
function icon(paths: readonly string[]): SVGSVGElement {
  const svg = document.createElementNS(SVG_NAMESPACE, 'svg')
  const attributes = {
    width: '15', height: '15', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7',
    'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false'
  }
  for (const [name, value] of Object.entries(attributes)) svg.setAttribute(name, value)
  for (const definition of paths) {
    const path = document.createElementNS(SVG_NAMESPACE, 'path')
    path.setAttribute('d', definition)
    svg.append(path)
  }
  return svg
}

/**
 * Return the names of the folders that contain `levelId`, outermost first, after `path`.
 * Returns undefined when no item in `items` has that ID.
 */
function containerNames(items: readonly CollectionItem[], levelId: string, path: string[]): string[] | undefined {
  for (const item of items) {
    if (item.id === levelId) return path
    if (!('requests' in item)) continue
    const found = containerNames(item.requests, levelId, [...path, item.name])
    if (found) return found
  }
}

/** Explain which outer levels a folder or request env inherits from. Returns null for the collection itself. */
function inheritedEnvNote(collection: Collection, levelId: string): string | null {
  if (levelId === collection.id) return null
  const containers = containerNames(collection.requests, levelId, [collection.name])
  if (!containers) return null
  const level = findCollectionLevel(collection, levelId)
  const kind = level && 'editor' in level ? 'request' : 'folder'
  return `This ${kind} inherits envs from ${containers.join(' / ')}. ` +
    'For the chosen env, a value set here wins. Empty or missing values come from the outer levels.'
}

/** Edit the env of one collection level: Base names, forks, and fork values. */
export class EnvironmentsEditor {
  private section = element('#env-editor')
  private error = element('#env-error')
  private collection: Collection | undefined
  private levelId: string | undefined
  private tab: string | null = null
  private renderedTab: string | null = null
  private revision = 0
  private pending = 0
  private completions: Array<{revision: number, run: () => void}> = []
  private unsavedValues = new Map<string, {value: string}>()
  private inputEdits = new WeakMap<HTMLInputElement, number>()
  private renamingBase: string | null = null
  private renamingFork = false
  private confirmingDelete = false
  /** True while render() replaces fields, so their blur handlers do not treat it as the user leaving. */
  private rendering = false

  constructor() {
    this.section.addEventListener('input', (event) => {
      if (event.target instanceof HTMLInputElement) {
        this.inputEdits.set(event.target, (this.inputEdits.get(event.target) ?? 0) + 1)
      }
    })
    element('#env-close').addEventListener('click', this.close)
    element('#collections-dialog').addEventListener('close', this.close)
    // Tabs are rebuilt on the first click, so listen on their stable container.
    element('#env-tabs').addEventListener('dblclick', this.renameDoubleClickedTab)
  }

  /** Show the env of one level. `levelId` is the collection ID, or a folder or request ID inside it. */
  async open(id: string, levelId = id): Promise<void> {
    const revision = ++this.revision
    try {
      const collection = await loadCollection(id)
      if (revision !== this.revision) return
      if (!collection) throw new Error('This collection is no longer available.')
      const level = findCollectionLevel(collection, levelId)
      if (!level) throw new Error('This item is no longer available.')
      this.collection = collection
      this.levelId = levelId
      this.unsavedValues.clear()
      this.tab = null
      this.resetActions()
      this.error.hidden = true
      const name = 'editor' in level ? level.editor.name : level.name
      element('#env-collection-name').textContent = levelId === id ? name : `${collection.name} / ${name}`
      const inheritedNote = inheritedEnvNote(collection, levelId)
      const inherited = element('#env-inherited')
      inherited.textContent = inheritedNote ?? ''
      inherited.hidden = inheritedNote === null
      for (const selector of ['#collections-list', '#collections-empty', '.collections-toolbar', '#collection-item-form']) element(selector).hidden = true
      this.section.hidden = false
      this.render()
      element('#env-close').focus()
    } catch (error) {
      const notice = element('#collections-error')
      notice.textContent = error instanceof Error ? error.message : 'Could not read environments.'
      notice.hidden = false
    }
  }

  private close = (): void => {
    this.revision++
    this.collection = undefined
    this.levelId = undefined
    this.unsavedValues.clear()
    this.section.hidden = true
    element('#collections-list').hidden = false
    element('.collections-toolbar').hidden = false
    // Restore the tree's empty state after returning from the env editor.
    element('#collections-empty').hidden = Boolean(element('#collections-list').children.length)
  }

  private async edit(change: (env: LevelEnv) => void, done: () => void = () => this.renderKeepingInput()): Promise<void> {
    const collection = this.collection
    if (!collection) return
    const revision = this.revision
    this.pending++
    this.error.hidden = true
    // Actions that rebuild the fields must wait for saved state to catch up.
    // Live value fields keep their focus and undo history while saves are pending.
    const buttons = this.section.querySelectorAll<HTMLButtonElement>('button:not(#env-close)')
    for (const button of buttons) button.disabled = true
    try {
      const updated = await editCollectionEnv(collection.id, change, this.levelId)
      if (revision !== this.revision) return
      this.collection = updated
      this.completions.push({revision, run: done})
    } catch (error) {
      if (revision !== this.revision) return
      this.error.textContent = error instanceof Error ? error.message : 'Could not save environments. Try again.'
      this.error.hidden = false
      return
    } finally {
      this.pending--
      if (!this.pending) {
        for (const button of this.section.querySelectorAll<HTMLButtonElement>('button:not(#env-close)')) button.disabled = false
        // A structural write can finish before value edits made while it was saving.
        // Wait for all queued writes; renders retain values whose saves failed.
        const completions = this.completions
        this.completions = []
        for (const completion of completions) if (completion.revision === this.revision) completion.run()
      }
    }
  }

  private button(label: string, run: () => void): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'text-button'
    button.textContent = label
    button.disabled = this.pending > 0
    button.addEventListener('click', () => { if (!this.pending) run() })
    return button
  }

  /** Build an icon-only tab action. The label is its accessible name and hover tooltip. */
  private iconButton(id: string, label: string, paths: readonly string[], run: () => void): HTMLButtonElement {
    const button = this.button('', run)
    button.id = id
    button.className = 'env-icon-button'
    button.title = label
    button.setAttribute('aria-label', label)
    button.append(icon(paths))
    return button
  }

  private resetActions(): void {
    this.renamingBase = null
    this.renamingFork = false
    this.confirmingDelete = false
  }

  /** A submitted name can be consumed only if no newer edit or selection replaced it. */
  private unchangedInput(input: HTMLInputElement): () => boolean {
    const edits = this.inputEdits.get(input)
    const {value, selectionStart, selectionEnd, selectionDirection} = input
    return () => this.inputEdits.get(input) === edits && input.value === value &&
      input.selectionStart === selectionStart && input.selectionEnd === selectionEnd && input.selectionDirection === selectionDirection
  }

  /** Keep edits and validation in the panel, including keyboard submission and cancellation. */
  private nameForm(id: string, buttonId: string, labelText: string, action: string, submit: (name: string, unchanged: () => boolean) => void, value = '', cancel?: () => void): HTMLFormElement {
    const form = document.createElement('form')
    form.className = 'env-form'
    const label = document.createElement('label')
    label.className = 'field-label'
    label.htmlFor = id
    label.textContent = labelText
    const row = document.createElement('div')
    row.className = 'env-input-row'
    const input = document.createElement('input')
    input.id = id
    input.className = 'auth-input'
    input.autocomplete = 'off'
    input.value = value
    const button = document.createElement('button')
    button.type = 'submit'
    button.id = buttonId
    button.className = 'history-button'
    button.textContent = action
    row.append(input, button)
    if (cancel) {
      row.append(this.button('Cancel', cancel))
      form.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          if (!this.pending) cancel()
        }
      })
    }
    form.append(label, row)
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      if (!this.pending) submit(input.value, this.unchangedInput(input))
    })
    return form
  }

  /** Fork the selected tab, then select the new fork and open its name for editing. */
  private forkSelectedTab = (): void => {
    if (this.pending) return
    const sourceId = this.tab
    const id = crypto.randomUUID()
    const content = element('#env-content')
    const contentUnchanged = Array.from(content.querySelectorAll('input'), (input) => this.unchangedInput(input))
    void this.edit((env) => { forkEnv(env, id, sourceId) }, () => {
      // Opening the new tab must not hide a field the user changed or moved into while saving.
      const contentChanged = !contentUnchanged.every((unchanged) => unchanged())
      if (contentChanged || content.contains(document.activeElement)) {
        this.renderKeepingInput()
        return
      }
      this.tab = id
      this.resetActions()
      this.startForkRename()
    })
  }

  /** Replace the selected fork's tab with a name field and select its text. */
  private startForkRename(): void {
    this.renamingFork = true
    this.confirmingDelete = false
    this.render()
    const input = element<HTMLInputElement>('#env-rename-fork-name')
    input.focus()
    input.select()
  }

  /** Double-clicking a fork tab renames that fork. Base cannot be renamed. */
  private renameDoubleClickedTab = (event: MouseEvent): void => {
    const tab = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-fork-id]') : null
    if (!tab || this.pending) return
    this.tab = tab.dataset.forkId!
    this.error.hidden = true
    this.startForkRename()
  }

  /** Save the name in the fork's tab field. Keep the field open if the user edited it during the save. */
  private saveForkName(forkId: string, input: HTMLInputElement): void {
    if (this.pending) return
    const unchanged = this.unchangedInput(input)
    void this.edit((env) => renameFork(env, forkId, input.value), () => {
      this.renamingFork = !unchanged()
      this.renderKeepingInput(`#env-tab-${forkId}`)
    })
  }

  /** Close the fork name field without saving and return focus to its tab. */
  private cancelForkRename(forkId: string): void {
    this.renamingFork = false
    this.render()
    element(`#env-tab-${forkId}`).focus()
  }

  /**
   * Build the name field that replaces a fork's tab. Enter saves and Escape cancels.
   * Leaving the field saves a changed name and closes an unchanged one in place,
   * so the control the user moved to keeps its focus.
   */
  private forkNameField(forkId: string, name: string): HTMLInputElement {
    const input = document.createElement('input')
    input.id = 'env-rename-fork-name'
    input.className = 'env-tab-name'
    input.autocomplete = 'off'
    input.spellcheck = false
    input.value = name
    input.size = Math.max(name.length, 8)
    input.setAttribute('aria-label', 'Fork name')
    input.setAttribute('list', 'env-fork-suggestions')
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        this.saveForkName(forkId, input)
      } else if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        if (!this.pending) this.cancelForkRename(forkId)
      }
    })
    input.addEventListener('blur', () => {
      // Rebuilding the tabs is not the user leaving the field.
      if (this.rendering || this.pending || !input.isConnected) return
      if (input.value.trim() !== name) {
        this.saveForkName(forkId, input)
        return
      }
      this.renamingFork = false
      input.replaceWith(this.tabButton(forkId, name))
    })
    return input
  }

  /** Build one env tab. Fork tabs carry their ID so a double-click can rename them. */
  private tabButton(id: string | null, name: string): HTMLButtonElement {
    const tabId = id === null ? 'env-tab-base' : `env-tab-${id}`
    const button = this.button(name, () => {
      // Rebuilding on the second click of a double-click would remove its target.
      if (this.tab === id) return
      this.tab = id
      this.resetActions()
      this.error.hidden = true
      this.render()
      element(`#${tabId}`).focus()
    })
    button.id = tabId
    if (id !== null) {
      button.dataset.forkId = id
      button.title = 'Double-click to rename'
    }
    button.setAttribute('role', 'tab')
    button.setAttribute('aria-selected', String(this.tab === id))
    button.setAttribute('aria-controls', 'env-content')
    return button
  }

  /** Build the actions for the selected tab: rename and delete for a fork, and fork for every tab. */
  private tabActions(env: LevelEnv): HTMLElement[] {
    const selectedFork = env.forks.find(({id}) => id === this.tab)
    const sourceName = selectedFork?.name ?? 'Base'
    const fork = this.iconButton('env-new-fork', `Fork ${sourceName}`, ICON_PATHS.fork, this.forkSelectedTab)
    if (!selectedFork) return [fork]
    const rename = this.iconButton('env-rename-fork', `Rename ${selectedFork.name}`, ICON_PATHS.rename, () => this.startForkRename())
    return [rename, this.deleteForkControl(selectedFork.id, selectedFork.name), fork]
  }

  /**
   * Build the delete action. The first click shows a tooltip that asks for a second click.
   * Leaving the button or pressing Escape cancels the request.
   */
  private deleteForkControl(forkId: string, forkName: string): HTMLElement {
    const control = document.createElement('span')
    control.className = 'env-delete-control'
    const button = this.iconButton('env-delete-fork', `Delete ${forkName}`, ICON_PATHS.remove, () => {
      if (this.confirmingDelete) this.removeFork(forkId)
      else this.showDeleteConfirmation(true)
    })
    const tooltip = document.createElement('span')
    tooltip.id = 'env-delete-tooltip'
    tooltip.className = 'env-tooltip'
    tooltip.setAttribute('role', 'tooltip')
    tooltip.setAttribute('aria-live', 'polite')
    tooltip.textContent = `Click again to delete “${forkName}” and its values.`
    button.setAttribute('aria-describedby', tooltip.id)
    button.addEventListener('blur', () => { if (!this.rendering) this.showDeleteConfirmation(false) })
    button.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !this.confirmingDelete) return
      event.preventDefault()
      event.stopPropagation()
      this.showDeleteConfirmation(false)
    })
    control.append(button, tooltip)
    return control
  }

  /** Show or hide the delete confirmation in place, so a field the user moved to keeps its focus. */
  private showDeleteConfirmation(isVisible: boolean): void {
    this.confirmingDelete = isVisible
    const button = this.section.querySelector<HTMLButtonElement>('#env-delete-fork')
    const tooltip = this.section.querySelector<HTMLElement>('#env-delete-tooltip')
    if (!button || !tooltip) return
    button.classList.toggle('is-confirming', isVisible)
    // The native hover title would cover the confirmation tooltip.
    const label = button.getAttribute('aria-label') ?? ''
    button.title = isVisible ? '' : label
    tooltip.hidden = !isVisible
  }

  /** Delete a fork and its values, then show Base. Called by the second click on the delete button. */
  private removeFork(forkId: string): void {
    if (this.pending) return
    void this.edit((env) => { deleteFork(env, forkId, true) }, () => {
      this.tab = null
      this.resetActions()
      this.renderKeepingInput('#env-tab-base')
    })
  }

  /** Save completions preserve every surviving draft, plus the live focus and selection. */
  private renderKeepingInput(fallback?: string): void {
    const active = document.activeElement
    const tab = this.renderedTab
    const inputs = Array.from(this.section.querySelectorAll('input'), (input) => ({
      input, value: input.value,
      selection: [input.selectionStart, input.selectionEnd, input.selectionDirection ?? undefined] as const
    }))
    this.render()
    let restoredFocus = false
    for (const {input, value, selection} of inputs) {
      // Fields belong to a tab; a different tab has none of them.
      if (tab !== this.tab) continue
      // Row indices change after deletion; identify values by fork and variable name.
      const restored = Array.from(this.section.querySelectorAll<HTMLInputElement>('input')).find((candidate) =>
        input.dataset.variableKey ? candidate.dataset.variableKey === input.dataset.variableKey : candidate.id === input.id)
      if (!restored) continue
      if (restored.value !== value) restored.value = value
      this.inputEdits.set(restored, this.inputEdits.get(input) ?? 0)
      restored.setSelectionRange(...selection)
      if (input === active) {
        restored.focus()
        restored.setSelectionRange(...selection)
        restoredFocus = true
      }
    }
    if (!restoredFocus && fallback) element(fallback).focus()
  }

  /** Rebuild the tabs and the selected tab's content. Field blur handlers ignore the rebuild. */
  private render(): void {
    this.rendering = true
    try {
      this.renderEnv()
    } finally {
      this.rendering = false
    }
  }

  /** Show the current level's env: name suggestions, tabs, tab actions, and the selected tab's content. */
  private renderEnv(): void {
    const collection = this.collection
    const env = (collection && this.levelId ? findCollectionLevel(collection, this.levelId)?.env : undefined) ?? createEnv()
    const variableKeys = new Set(env.forks.flatMap((fork) => fork.variables.map(({name}) => JSON.stringify([fork.id, name]))))
    for (const key of this.unsavedValues.keys()) if (!variableKeys.has(key)) this.unsavedValues.delete(key)
    element('#env-fork-suggestions').replaceChildren(...(collection ? pickerOptions(collectionEnvs(collection)) : [])
      .filter(({name}) => name !== null).map(({label}) => new Option(label, label)))
    if (this.tab !== null && !env.forks.some(({id}) => id === this.tab)) {
      this.tab = null
      this.resetActions()
    }
    const tabs = [{id: null, name: 'Base'}, ...env.forks]
    element('#env-tabs').replaceChildren(...tabs.map(({id, name}) => {
      const isRenamed = id !== null && id === this.tab && this.renamingFork
      return isRenamed ? this.forkNameField(id, name) : this.tabButton(id, name)
    }))
    element('#env-tab-actions').replaceChildren(...this.tabActions(env))
    this.showDeleteConfirmation(this.confirmingDelete)
    const content = element('#env-content')
    this.renderedTab = this.tab
    content.setAttribute('aria-labelledby', this.tab === null ? 'env-tab-base' : `env-tab-${this.tab}`)
    content.replaceChildren()
    if (this.tab === null) this.renderBase(env, content)
    else content.append(this.forkTable(env, this.tab))
  }

  /** List Base names with rename and remove actions, followed by the form that adds a name. */
  private renderBase(env: LevelEnv, content: HTMLElement): void {
    for (const name of env.baseNames) {
      if (this.renamingBase === name) {
        content.append(this.nameForm('env-rename-base-name', 'env-save-base-name', `Rename ${name}`, 'Save name', (newName, unchanged) => {
          void this.edit((env) => renameBaseName(env, name, newName), () => {
            this.renamingBase = unchanged() ? null : newName.trim()
            this.renderKeepingInput('#env-tab-base')
          })
        }, name, () => { this.renamingBase = null; this.render(); element('#env-tab-base').focus() }))
        continue
      }
      const row = document.createElement('div')
      row.className = 'env-variable-row'
      const label = document.createElement('span')
      label.textContent = name
      const rename = this.button('Rename', () => {
        this.renamingBase = name
        this.render()
        element<HTMLInputElement>('#env-rename-base-name').select()
      })
      rename.setAttribute('aria-label', `Rename ${name}`)
      const remove = this.button('Remove', () => { void this.edit((env) => removeBaseName(env, name)) })
      remove.setAttribute('aria-label', `Remove ${name}`)
      row.append(label, rename, remove)
      content.append(row)
    }
    content.append(this.nameForm('env-base-name', 'env-add-name', 'Variable name', 'Add name', (name, unchanged) => {
      void this.edit((env) => addBaseName(env, name), () => {
        if (unchanged()) element<HTMLInputElement>('#env-base-name').value = ''
        this.renderKeepingInput('#env-base-name')
      })
    }))
  }

  /** Show a fork as a variable and value table, with a last row that adds a fork-only variable. */
  private forkTable(env: LevelEnv, forkId: string): HTMLElement {
    const table = document.createElement('div')
    table.className = 'entry-table env-table'
    const heading = document.createElement('div')
    heading.className = 'env-table-heading'
    heading.setAttribute('aria-hidden', 'true')
    for (const title of ['VARIABLE', 'VALUE', '']) {
      const cell = document.createElement('span')
      cell.textContent = title
      heading.append(cell)
    }
    table.append(heading)
    const variables = forkVariables(env, forkId)
    for (const [index, variable] of variables.entries()) table.append(this.valueRow(forkId, index, variable))
    if (!variables.length) {
      const empty = document.createElement('p')
      empty.className = 'env-table-empty'
      empty.textContent = 'No variables yet. Add names in Base, or add a variable for this fork only below.'
      table.append(empty)
    }
    table.append(this.addVariableRow(forkId))
    return table
  }

  /**
   * Build one table row: the variable name, its value field, and a delete button for a fork-only variable.
   * Base names show a mark instead, because they are removed in the Base tab.
   */
  private valueRow(forkId: string, index: number, {name, value, fromBase}: EnvVariable & {fromBase: boolean}): HTMLElement {
    const row = document.createElement('div')
    row.className = 'env-value-row'
    const nameCell = document.createElement('div')
    nameCell.className = 'env-name-cell'
    const label = document.createElement('label')
    label.htmlFor = `env-value-${index}`
    label.textContent = name
    nameCell.append(label)
    const input = document.createElement('input')
    input.id = label.htmlFor
    input.className = 'env-value-input'
    input.placeholder = 'Value'
    input.spellcheck = false
    input.setAttribute('aria-label', `Value for ${name}`)
    const key = JSON.stringify([forkId, name])
    input.dataset.variableKey = key
    input.value = this.unsavedValues.get(key)?.value ?? value
    input.autocomplete = 'off'
    input.addEventListener('input', () => {
      // Keep failed edits through structural renders, and never let an older
      // successful write clear text entered while that write was pending.
      const draft = {value: input.value}
      this.unsavedValues.set(key, draft)
      void this.edit((env) => setForkValue(env, forkId, name, draft.value), () => {
        if (this.unsavedValues.get(key) === draft) this.unsavedValues.delete(key)
      })
    })
    let action: HTMLElement
    if (fromBase) {
      const mark = document.createElement('span')
      mark.className = 'env-base-mark'
      mark.textContent = 'base'
      mark.title = 'From Base. Rename or remove it in the Base tab.'
      nameCell.append(mark)
      action = document.createElement('span')
    } else {
      action = this.button('×', () => { void this.edit((env) => deleteForkVariable(env, forkId, name), () => this.renderKeepingInput()) })
      action.className = 'remove-button'
      action.title = `Delete ${name}`
      action.setAttribute('aria-label', `Delete ${name}`)
    }
    row.append(nameCell, input, action)
    return row
  }

  /** Build the table's last row, which adds a variable to this fork only. */
  private addVariableRow(forkId: string): HTMLFormElement {
    const form = document.createElement('form')
    form.className = 'env-add-row'
    const input = document.createElement('input')
    input.id = 'env-variable-name'
    input.autocomplete = 'off'
    input.spellcheck = false
    input.placeholder = 'Add a variable for this fork only'
    input.setAttribute('aria-label', 'Fork-only variable name')
    const button = document.createElement('button')
    button.type = 'submit'
    button.id = 'env-add-variable'
    button.className = 'text-button add-button'
    button.textContent = '+ Add'
    button.setAttribute('aria-label', 'Add variable')
    button.disabled = this.pending > 0
    form.append(input, button)
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      if (this.pending) return
      const name = input.value
      const unchanged = this.unchangedInput(input)
      void this.edit((env) => addForkVariable(env, forkId, name), () => {
        if (unchanged()) element<HTMLInputElement>('#env-variable-name').value = ''
        this.renderKeepingInput('#env-variable-name')
      })
    })
    return form
  }
}
