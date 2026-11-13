/** Edit one collection, folder, or request env. All writes operate on fresh storage. */
import {editCollectionEnv, findCollectionLevel, loadCollection} from '../collections/collection-store'
import type {Collection} from '../collections/collection-store'
import {addBaseName, addForkVariable, collectionEnvs, createEnv, createFork, deleteFork, deleteForkVariable, forkVariables, pickerOptions, removeBaseName, renameBaseName, renameFork, setForkValue} from '../env/env'
import type {LevelEnv} from '../env/env'

function element<T extends HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector)
  if (!node) throw new Error(`Missing env element: ${selector}`)
  return node
}

export class EnvironmentsEditor {
  private section = element('#env-editor')
  private error = element('#env-error')
  private collection: Collection | undefined
  private levelId: string | undefined
  private tab: string | null = null
  private revision = 0
  private pending = 0
  private completions: Array<{revision: number, run: () => void}> = []
  private renamingBase: string | null = null
  private renamingFork = false
  private confirmingDelete = false

  constructor() {
    element('#env-close').addEventListener('click', this.close)
    element('#collections-dialog').addEventListener('close', this.close)
    element('#env-fork-form').addEventListener('submit', (event) => {
      event.preventDefault()
      if (this.pending) return
      const input = element<HTMLInputElement>('#env-fork-name')
      const name = input.value
      const id = crypto.randomUUID()
      void this.edit((env) => { createFork(env, id, name) }, () => {
        input.value = ''
        this.tab = id
        this.resetActions()
        this.render()
      })
    })
  }

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
      this.tab = null
      this.resetActions()
      this.error.hidden = true
      const name = 'editor' in level ? level.editor.name : level.name
      element('#env-collection-name').textContent = levelId === id ? name : `${collection.name} / ${name}`
      element<HTMLInputElement>('#env-fork-name').value = ''
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
    this.section.hidden = true
    element('#collections-list').hidden = false
    element('.collections-toolbar').hidden = false
    // Restore the tree's empty state after returning from the env editor.
    element('#collections-empty').hidden = Boolean(element('#collections-list').children.length)
  }

  private async edit(change: (env: LevelEnv) => void, done: () => void = () => this.render()): Promise<void> {
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
        // Rebuild only once the saved collection includes every queued edit.
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

  private resetActions(): void {
    this.renamingBase = null
    this.renamingFork = false
    this.confirmingDelete = false
  }

  /** Keep edits and validation in the panel, including keyboard submission and cancellation. */
  private nameForm(id: string, buttonId: string, labelText: string, action: string, submit: (name: string) => void, value = '', cancel?: () => void): HTMLFormElement {
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
      if (!this.pending) submit(input.value)
    })
    return form
  }

  private removeFork(forkId: string, confirmed = false): void {
    if (this.pending) return
    this.renamingFork = false
    let deleted = false
    void this.edit((env) => { deleted = deleteFork(env, forkId, confirmed) }, () => {
      this.confirmingDelete = !deleted
      if (deleted) this.tab = null
      this.render()
      element(deleted ? '#env-tab-base' : '#env-cancel-delete').focus()
    })
  }

  private render(): void {
    const collection = this.collection
    const env = (collection && this.levelId ? findCollectionLevel(collection, this.levelId)?.env : undefined) ?? createEnv()
    element('#env-fork-suggestions').replaceChildren(...(collection ? pickerOptions(collectionEnvs(collection)) : [])
      .filter(({name}) => name !== null).map(({label}) => new Option(label, label)))
    const tabs = [{id: null, name: 'Base'}, ...env.forks]
    element('#env-tabs').replaceChildren(...tabs.map(({id, name}) => {
      const tabId = id === null ? 'env-tab-base' : `env-tab-${id}`
      const button = this.button(name, () => {
        this.tab = id
        this.resetActions()
        this.error.hidden = true
        this.render()
        element(`#${tabId}`).focus()
      })
      button.id = tabId
      button.setAttribute('role', 'tab')
      button.setAttribute('aria-selected', String(this.tab === id))
      button.setAttribute('aria-controls', 'env-content')
      return button
    }))
    const content = element('#env-content')
    content.setAttribute('aria-labelledby', this.tab === null ? 'env-tab-base' : `env-tab-${this.tab}`)
    content.replaceChildren()
    if (this.tab === null) {
      for (const name of env.baseNames) {
        if (this.renamingBase === name) {
          content.append(this.nameForm('env-rename-base-name', 'env-save-base-name', `Rename ${name}`, 'Save name', (newName) => {
            void this.edit((env) => renameBaseName(env, name, newName), () => {
              this.renamingBase = null
              this.render()
              element('#env-tab-base').focus()
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
      content.append(this.nameForm('env-base-name', 'env-add-name', 'Variable name', 'Add name', (name) => {
        void this.edit((env) => addBaseName(env, name), () => {
          this.render()
          element('#env-base-name').focus()
        })
      }))
    } else {
      const fork = env.forks.find(({id}) => id === this.tab)
      if (!fork) { this.tab = null; this.render(); return }
      const actions = document.createElement('div')
      actions.className = 'env-input-row'
      const rename = this.button('Rename fork', () => {
        this.renamingFork = true
        this.confirmingDelete = false
        this.render()
        element<HTMLInputElement>('#env-rename-fork-name').select()
      })
      rename.id = 'env-rename-fork'
      const remove = this.button('Delete fork', () => this.removeFork(fork.id))
      remove.id = 'env-delete-fork'
      actions.append(rename, remove)
      content.append(actions)
      if (this.renamingFork) {
        const form = this.nameForm('env-rename-fork-name', 'env-save-fork-name', 'Fork name', 'Save name', (name) => {
          void this.edit((env) => renameFork(env, fork.id, name), () => {
            this.renamingFork = false
            this.render()
            element('#env-rename-fork').focus()
          })
        }, fork.name, () => { this.renamingFork = false; this.render(); element('#env-rename-fork').focus() })
        form.querySelector('input')!.setAttribute('list', 'env-fork-suggestions')
        content.append(form)
      }
      if (this.confirmingDelete) {
        const warning = document.createElement('div')
        warning.id = 'env-delete-warning'
        warning.className = 'collection-unsaved-warning'
        warning.setAttribute('role', 'alert')
        const message = document.createElement('p')
        message.textContent = `Delete fork “${fork.name}” and all its values? This cannot be undone.`
        const actions = document.createElement('div')
        actions.className = 'save-as-actions'
        const cancel = this.button('Cancel', () => {
          this.confirmingDelete = false
          this.render()
          element('#env-delete-fork').focus()
        })
        cancel.id = 'env-cancel-delete'
        const confirm = this.button('Delete fork', () => this.removeFork(fork.id, true))
        confirm.id = 'env-confirm-delete'
        actions.append(cancel, confirm)
        warning.append(message, actions)
        content.append(warning)
      }
      for (const [index, {name, value, fromBase}] of forkVariables(env, fork.id).entries()) {
        const row = document.createElement('div')
        row.className = 'env-value-row'
        const label = document.createElement('label')
        label.htmlFor = `env-value-${index}`
        label.textContent = name
        const input = document.createElement('input')
        input.id = label.htmlFor
        input.className = 'auth-input'
        input.setAttribute('aria-label', `Value for ${name}`)
        input.value = value
        input.autocomplete = 'off'
        input.addEventListener('input', () => {
          const value = input.value
          void this.edit((env) => setForkValue(env, fork.id, name, value), () => {})
        })
        const heading = document.createElement('div')
        heading.className = 'env-variable-heading'
        heading.append(label)
        if (fromBase) {
          const mark = document.createElement('span')
          mark.className = 'env-base-mark'
          mark.textContent = 'From base'
          heading.append(mark)
        } else {
          const remove = this.button('Delete', () => { void this.edit((env) => deleteForkVariable(env, fork.id, name)) })
          remove.setAttribute('aria-label', `Delete ${name}`)
          heading.append(remove)
        }
        row.append(heading, input)
        content.append(row)
      }
      content.append(this.nameForm('env-variable-name', 'env-add-variable', 'Fork-only variable name', 'Add variable', (name) => {
        void this.edit((env) => addForkVariable(env, fork.id, name), () => {
          this.render()
          element('#env-variable-name').focus()
        })
      }))
    }
  }
}
