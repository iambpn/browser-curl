/** Edit one collection, folder, or request env. All writes operate on fresh storage. */
import {editCollectionEnv, findCollectionLevel, loadCollection} from '../collections/collection-store'
import type {Collection} from '../collections/collection-store'
import {addBaseName, collectionEnvs, createEnv, createFork, pickerOptions, removeBaseName, setForkValue} from '../env/env'
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
    // Disable only submit actions; live value fields keep their focus and undo history.
    const buttons = this.section.querySelectorAll<HTMLButtonElement>('button[type="submit"]')
    for (const button of buttons) button.disabled = true
    try {
      const updated = await editCollectionEnv(collection.id, change, this.levelId)
      if (revision !== this.revision) return
      this.collection = updated
      done()
    } catch (error) {
      if (revision !== this.revision) return
      this.error.textContent = error instanceof Error ? error.message : 'Could not save environments. Try again.'
      this.error.hidden = false
    } finally {
      this.pending--
      if (!this.pending) for (const button of this.section.querySelectorAll<HTMLButtonElement>('button[type="submit"]')) button.disabled = false
    }
  }

  private button(label: string, run: () => void): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'text-button'
    button.textContent = label
    button.addEventListener('click', run)
    return button
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
        const row = document.createElement('div')
        row.className = 'env-variable-row'
        const label = document.createElement('span')
        label.textContent = name
        const remove = this.button('Remove', () => { void this.edit((env) => removeBaseName(env, name)) })
        remove.setAttribute('aria-label', `Remove ${name}`)
        row.append(label, remove)
        content.append(row)
      }
      const form = document.createElement('form')
      form.className = 'env-form'
      const label = document.createElement('label')
      label.className = 'field-label'
      label.htmlFor = 'env-base-name'
      label.textContent = 'Variable name'
      const row = document.createElement('div')
      row.className = 'env-input-row'
      const input = document.createElement('input')
      input.id = 'env-base-name'
      input.className = 'auth-input'
      input.autocomplete = 'off'
      const add = document.createElement('button')
      add.id = 'env-add-name'
      add.type = 'submit'
      add.className = 'history-button'
      add.textContent = 'Add name'
      row.append(input, add)
      form.append(label, row)
      form.addEventListener('submit', (event) => {
        event.preventDefault()
        if (this.pending) return
        const name = input.value
        void this.edit((env) => addBaseName(env, name), () => {
          this.render()
          element('#env-base-name').focus()
        })
      })
      content.append(form)
    } else {
      const fork = env.forks.find(({id}) => id === this.tab)
      if (!fork) { this.tab = null; this.render(); return }
      // Base order first, followed by retained names after their removal from the base.
      const names = [...env.baseNames, ...fork.variables.map(({name}) => name).filter((name) => !env.baseNames.includes(name))]
      for (const [index, name] of names.entries()) {
        const row = document.createElement('div')
        row.className = 'env-value-row'
        const label = document.createElement('label')
        label.htmlFor = `env-value-${index}`
        label.textContent = name
        const input = document.createElement('input')
        input.id = label.htmlFor
        input.className = 'auth-input'
        input.setAttribute('aria-label', `Value for ${name}`)
        input.value = fork.variables.find((variable) => variable.name === name)?.value ?? ''
        input.autocomplete = 'off'
        input.addEventListener('input', () => {
          const value = input.value
          void this.edit((env) => setForkValue(env, fork.id, name, value), () => {})
        })
        row.append(label, input)
        content.append(row)
      }
    }
  }
}
