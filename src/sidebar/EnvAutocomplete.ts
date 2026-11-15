/** Request-field autocomplete uses a custom list because native datalists cannot show source icons. */
import {variableReferenceAt} from '../env/suggestions'
import type {EnvSuggestion, VariableReference} from '../env/suggestions'
import {collectionKindIcon} from './collection-icons'

/** Labels pair with icons so every source remains clear without recognizing its symbol. */
const SOURCE_LABELS = {collection: 'Collection', folder: 'Folder', api: 'API'}

/** Only fields whose contents support environment substitution receive suggestions. */
function requestField(target: EventTarget | null): HTMLInputElement | HTMLTextAreaElement | undefined {
  const isTextField = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
  if (!isTextField) return
  if (target.matches('#request-url, #request-body, .entry-row input[type="text"], .auth-fields input')) return target
}

/** Keep typing in the field while a separate list supports pointer and keyboard selection. */
export class EnvAutocomplete {
  private list = document.createElement('div')
  private field: HTMLInputElement | HTMLTextAreaElement | undefined
  private reference: VariableReference | undefined
  private suggestions: EnvSuggestion[] = []
  private selectedIndex = 0
  private revision = 0

  /** Attach delegated listeners so newly added parameter and header rows also work. */
  constructor(private form: HTMLFormElement, private loadSuggestions: () => Promise<EnvSuggestion[]>) {
    this.list.id = 'env-suggestions'
    this.list.className = 'env-suggestions'
    this.list.setAttribute('role', 'listbox')
    this.list.setAttribute('aria-label', 'Environment variables')
    this.list.hidden = true
    document.body.append(this.list)
    form.addEventListener('input', this.handleInput)
    form.addEventListener('click', this.handleInput)
    form.addEventListener('keydown', this.handleKeyDown)
    form.addEventListener('keyup', this.handleCaretKey)
    form.addEventListener('focusout', this.close)
    this.list.addEventListener('pointerdown', this.chooseWithPointer)
    document.addEventListener('pointerdown', this.handleOutsidePointer)
    window.addEventListener('resize', this.close)
    document.addEventListener('scroll', this.handleScroll, true)
  }

  /** Remove the list and its listeners when the owning sidebar closes. */
  dispose(): void {
    this.close()
    this.form.removeEventListener('input', this.handleInput)
    this.form.removeEventListener('click', this.handleInput)
    this.form.removeEventListener('keydown', this.handleKeyDown)
    this.form.removeEventListener('keyup', this.handleCaretKey)
    this.form.removeEventListener('focusout', this.close)
    this.list.removeEventListener('pointerdown', this.chooseWithPointer)
    document.removeEventListener('pointerdown', this.handleOutsidePointer)
    window.removeEventListener('resize', this.close)
    document.removeEventListener('scroll', this.handleScroll, true)
    this.list.remove()
  }

  /** Hide suggestions and invalidate pending reads without changing any editor value. */
  close = (): void => {
    this.revision += 1
    this.list.hidden = true
    this.field?.removeAttribute('aria-controls')
    this.field?.removeAttribute('aria-expanded')
    this.field?.removeAttribute('aria-autocomplete')
    this.field?.removeAttribute('aria-activedescendant')
    this.field = undefined
    this.reference = undefined
    this.suggestions = []
  }

  /** Recheck the active reference after typing, clicking, or moving the caret. */
  private handleInput = (event: Event): void => {
    const field = requestField(event.target)
    const isComposing = event instanceof InputEvent && event.isComposing
    if (!field || field.disabled || isComposing) {
      this.close()
      return
    }
    void this.refresh(field)
  }

  /** Load current names and ignore results from a field or reference the user already left. */
  private async refresh(field: HTMLInputElement | HTMLTextAreaElement): Promise<void> {
    const caret = field.selectionStart ?? 0
    const reference = variableReferenceAt(field.value, caret, field.selectionEnd ?? caret)
    this.close()
    if (!reference) return
    this.field = field
    this.reference = reference
    const revision = this.revision
    try {
      const available = await this.loadSuggestions()
      if (revision !== this.revision || document.activeElement !== field) return
      const query = reference.query.toLowerCase()
      /** Match the typed name without changing the variable's original case. */
      function matchesQuery(suggestion: EnvSuggestion): boolean {
        const name = suggestion.name.toLowerCase()
        return name.includes(query)
      }
      this.suggestions = available.filter(matchesQuery)
      if (!this.suggestions.length) {
        this.close()
        return
      }
      this.selectedIndex = 0
      this.render()
    } catch {
      if (revision === this.revision) this.close()
    }
  }

  /** Render variable names and source paths as text, keeping stored values out of the dropdown. */
  private render(): void {
    this.list.replaceChildren()
    for (const [index, suggestion] of this.suggestions.entries()) {
      const option = document.createElement('div')
      option.id = `env-suggestion-${index}`
      option.className = 'env-suggestion'
      option.dataset.index = String(index)
      option.setAttribute('role', 'option')
      const icon = collectionKindIcon(suggestion.source, suggestion.method)
      const text = document.createElement('span')
      text.className = 'env-suggestion-text'
      const name = document.createElement('span')
      name.className = 'env-suggestion-name'
      name.textContent = `{{${suggestion.name}}}`
      const source = document.createElement('span')
      source.className = 'env-suggestion-source'
      const kind = SOURCE_LABELS[suggestion.source]
      source.textContent = `${kind} · ${suggestion.sourceName}`
      text.append(name, source)
      option.title = source.textContent
      option.append(icon, text)
      this.list.append(option)
    }
    this.list.hidden = false
    this.field!.setAttribute('aria-controls', this.list.id)
    this.field!.setAttribute('aria-expanded', 'true')
    this.field!.setAttribute('aria-autocomplete', 'list')
    this.position()
    this.markSelected()
  }

  /** Place the dropdown below the field, or above it when the viewport has more room there. */
  private position(): void {
    const rect = this.field!.getBoundingClientRect()
    const margin = 8
    const fieldWidth = Math.max(rect.width, 220)
    const preferredWidth = Math.min(fieldWidth, 320)
    const viewportWidth = window.innerWidth - margin * 2
    const width = Math.min(preferredWidth, viewportWidth)
    const below = window.innerHeight - rect.bottom - margin
    const above = rect.top - margin
    const openAbove = below < 140 && above > below
    const room = openAbove ? above : below
    const availableHeight = Math.max(0, room - 4)
    const maxHeight = Math.min(220, availableHeight)
    this.list.style.width = `${width}px`
    this.list.style.maxHeight = `${maxHeight}px`
    const rightEdge = window.innerWidth - margin
    const left = Math.min(rect.left, rightEdge - width)
    this.list.style.left = `${Math.max(margin, left)}px`
    const height = this.list.getBoundingClientRect().height
    const topEdge = rect.top - height
    const top = openAbove ? topEdge - 4 : rect.bottom + 4
    this.list.style.top = `${top}px`
  }

  /** Reflect keyboard selection visually and expose the active option to assistive tools. */
  private markSelected(): void {
    const options = Array.from(this.list.children)
    for (const [index, option] of options.entries()) {
      const isSelected = index === this.selectedIndex
      option.setAttribute('aria-selected', String(isSelected))
    }
    const selected = this.list.children[this.selectedIndex] as HTMLElement
    this.field?.setAttribute('aria-activedescendant', selected.id)
    selected.scrollIntoView({block: 'nearest'})
  }

  /** Navigate without moving the caret; Enter and Tab insert, and Escape dismisses. */
  private handleKeyDown = (event: KeyboardEvent): void => {
    if (this.list.hidden || event.target !== this.field || event.isComposing) return
    if (event.ctrlKey || event.metaKey || event.altKey) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const direction = event.key === 'ArrowDown' ? 1 : -1
      const nextIndex = this.selectedIndex + direction
      const wrappedIndex = nextIndex + this.suggestions.length
      this.selectedIndex = wrappedIndex % this.suggestions.length
      this.markSelected()
    } else if (event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey)) {
      event.preventDefault()
      this.choose(this.selectedIndex)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      this.close()
    }
  }

  /** Recheck references when horizontal movement changes which text precedes the caret. */
  private handleCaretKey = (event: KeyboardEvent): void => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) this.handleInput(event)
  }

  /** Select before blur so clicking an option keeps the field focused. */
  private chooseWithPointer = (event: PointerEvent): void => {
    if (event.button !== 0 || !(event.target instanceof Element)) return
    const option = event.target.closest<HTMLElement>('[role="option"]')
    if (!option) return
    event.preventDefault()
    this.choose(Number(option.dataset.index))
  }

  /** Insert a complete reference, preserve its surrounding text, and trigger normal saves and URL sync. */
  private choose(index: number): void {
    const field = this.field
    const reference = this.reference
    const suggestion = this.suggestions[index]
    if (!field || !reference || !suggestion) return
    const caret = field.selectionStart ?? 0
    const current = variableReferenceAt(field.value, caret, field.selectionEnd ?? caret)
    const sameRange = current?.start === reference.start && current?.end === reference.end
    if (!sameRange || current?.query !== reference.query) {
      this.close()
      return
    }
    const replacement = `{{${suggestion.name}}}`
    field.setRangeText(replacement, reference.start, reference.end, 'end')
    this.close()
    field.dispatchEvent(new Event('input', {bubbles: true}))
  }

  /** Dismiss on outside interactions, including dialogs and request actions. */
  private handleOutsidePointer = (event: PointerEvent): void => {
    if (!(event.target instanceof Node)) return
    if (event.target !== this.field && !this.list.contains(event.target)) this.close()
  }

  /** Keep list scrolling usable, but dismiss when the page or a request panel moves the anchor. */
  private handleScroll = (event: Event): void => {
    if (event.target instanceof Node && this.list.contains(event.target)) return
    this.close()
  }
}
