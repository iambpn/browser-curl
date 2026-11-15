/** Configure automatic backups and observe exports owned by the background. */
import {COLLECTION_INDEX_KEY, listCollections} from '../collections/collection-store'
import {DISK_SYNC_KEY, loadDiskSyncSettings, requestDiskSync, saveDiskSyncSettings} from '../collections/disk-sync'
import type {DiskSyncSettings} from '../collections/disk-sync'
import {loadSyncDirectory, saveSyncDirectory} from '../collections/sync-directory'
import type {SyncDirectory} from '../collections/sync-directory'

/** Find a sync control in the sidebar's static markup. */
function control<T extends HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector)
  if (!node) throw new Error(`Missing disk sync control: ${selector}`)
  return node
}

/** Optional external-directory picker, absent in browsers such as Firefox. */
type DirectoryPickerWindow = Window & {
  /** Ask the user for read/write access to a folder after a direct button click. */
  showDirectoryPicker?: (options: {id: string; mode: 'readwrite'}) => Promise<SyncDirectory>
}

/** Configure all collections or a selected set without changing the collection editor. */
export class DiskSyncPanel {
  private form = control<HTMLFormElement>('#disk-sync-form')
  private enabled = control<HTMLInputElement>('#disk-sync-enabled')
  private scope = control<HTMLSelectElement>('#disk-sync-scope')
  private collections = control('#disk-sync-collections')
  private folder = control('#disk-sync-folder')
  private status = control('#disk-sync-status')
  private error = control('#disk-sync-error')
  private saveButton = control<HTMLButtonElement>('#save-disk-sync')
  private chooseButton = control<HTMLButtonElement>('#choose-sync-folder')
  private retryButton = control<HTMLButtonElement>('#retry-disk-sync')
  private directory: SyncDirectory | undefined
  private directoryChanged = false
  private settings: DiskSyncSettings | undefined
  private collectionIds = new Set<string>()
  private disposed = false
  private refresh = 0

  /** Detect folder support, attach controls, and restore saved choices before enabling the form. */
  constructor() {
    const pickerWindow = window as DirectoryPickerWindow
    if (!pickerWindow.showDirectoryPicker) {
      control('#disk-sync-unsupported').hidden = false
      this.form.hidden = true
      return
    }
    this.form.addEventListener('submit', this.save)
    this.scope.addEventListener('change', this.updateScope)
    this.chooseButton.addEventListener('click', this.chooseDirectory)
    this.retryButton.addEventListener('click', this.retry)
    chrome.storage.onChanged.addListener(this.storageChanged)
    chrome.runtime.onMessage.addListener(this.handleSyncFailure)
    window.addEventListener('pagehide', this.dispose, {once: true})
    void this.restore()
  }

  /** Restore settings and the approved handle; permission is checked again before every export. */
  private async restore(): Promise<void> {
    try {
      const settings = await loadDiskSyncSettings()
      this.settings = settings
      if (settings) {
        this.directory = await loadSyncDirectory(settings.directoryKey)
        this.enabled.checked = settings.enabled
        this.scope.value = settings.collectionIds === null ? 'all' : 'selected'
        this.collectionIds = new Set(settings.collectionIds ?? [])
        this.folder.textContent = settings.directoryName || 'No folder selected'
      }
      await this.renderCollections()
      if (this.disposed) return
      this.updateScope()
      this.form.inert = false
      this.showStatus(settings)
      if (settings?.enabled) void this.retry()
    } catch {
      this.showError('Could not load sync settings. Close and reopen the sidebar to try again.')
    }
  }

  /** Open the native folder picker directly from a click to preserve user activation. */
  private chooseDirectory = async (): Promise<void> => {
    const pickerWindow = window as DirectoryPickerWindow
    if (!pickerWindow.showDirectoryPicker || this.chooseButton.disabled) return
    this.chooseButton.disabled = true
    try {
      const directory = await pickerWindow.showDirectoryPicker({id: 'browsercurl-sync', mode: 'readwrite'})
      if (this.disposed) return
      const savedKey = this.settings?.directoryKey
      const savedDirectory = savedKey ? await loadSyncDirectory(savedKey) : undefined
      const sameDirectory = savedDirectory ? await directory.isSameEntry(savedDirectory) : false
      if (this.disposed) return
      this.directory = directory
      this.directoryChanged = !sameDirectory
      this.folder.textContent = directory.name
      this.error.hidden = true
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      this.showError('Could not open this folder. Choose a folder you can write to.')
    } finally {
      this.chooseButton.disabled = false
    }
  }

  /** Show checkboxes only for a selected set; All collections also includes future additions. */
  private updateScope = (): void => {
    this.collections.hidden = this.scope.value !== 'selected'
  }

  /** Refresh collection names while retaining selections and ignoring superseded reads. */
  private async renderCollections(): Promise<void> {
    const refresh = ++this.refresh
    const index = await listCollections()
    if (refresh !== this.refresh || this.disposed) return
    const labels: HTMLLabelElement[] = []
    const selected = new Set<string>()
    for (const {id, name} of index) {
      const label = document.createElement('label')
      const checkbox = document.createElement('input')
      checkbox.type = 'checkbox'
      checkbox.value = id
      checkbox.checked = this.collectionIds.has(id)
      if (checkbox.checked) selected.add(id)
      /** Preserve choices across list updates without inserting saved names as HTML. */
      function selectCollection(): void {
        if (checkbox.checked) selected.add(id)
        else selected.delete(id)
      }
      checkbox.addEventListener('change', selectCollection)
      label.append(checkbox, document.createTextNode(name))
      labels.push(label)
    }
    this.collectionIds = selected
    this.collections.replaceChildren(...labels)
    if (!index.length) this.collections.textContent = 'Create or import a collection first.'
  }

  /** Validate choices, persist the folder before enabling exports, and leave failed forms editable. */
  private save = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault()
    if (this.saveButton.disabled) return
    this.error.hidden = true
    if (this.enabled.checked && !this.directory) return this.showError('Choose a folder before enabling automatic sync.')
    const collectionIds = this.scope.value === 'all' ? null : Array.from(this.collectionIds)
    if (this.enabled.checked && collectionIds?.length === 0) return this.showError('Select at least one collection.')
    this.saveButton.disabled = true
    this.chooseButton.disabled = true
    this.form.inert = true
    try {
      if (this.enabled.checked && this.directory) {
        const permission = await this.directory.queryPermission({mode: 'readwrite'})
        if (permission !== 'granted') throw new Error('Choose the folder again to allow disk sync.')
      }
      let directoryKey = this.settings?.directoryKey ?? ''
      if (this.directory && this.directoryChanged) directoryKey = await saveSyncDirectory(this.directory)
      const settings: DiskSyncSettings = {
        enabled: this.enabled.checked,
        directoryKey,
        directoryName: this.directory?.name ?? '',
        collectionIds,
        fileNames: {},
        fingerprints: {}
      }
      await saveDiskSyncSettings(settings)
      this.settings = settings
      this.directoryChanged = false
      if (settings.enabled) void this.retry()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not save sync settings. Try again.'
      this.showError(message)
    } finally {
      this.saveButton.disabled = false
      this.chooseButton.disabled = false
      this.form.inert = false
    }
  }

  /** Retry saved changes without changing collection data or asking for fresh folder access. */
  private retry = async (): Promise<void> => {
    if (this.disposed || this.retryButton.disabled) return
    this.retryButton.disabled = true
    this.status.textContent = 'Syncing saved collection changes…'
    try {
      await requestDiskSync()
      const settings = await loadDiskSyncSettings()
      this.showStatus(settings)
    } catch {
      this.status.textContent = 'Sync failed. Could not contact the background or save sync progress. Select Retry to try again.'
    } finally {
      if (!this.disposed) this.retryButton.disabled = false
    }
  }

  /** Show actual disk-write progress separately from unsaved form choices. */
  private showStatus = (settings: DiskSyncSettings | undefined): void => {
    if (this.disposed) return
    this.retryButton.hidden = !settings?.enabled
    if (!settings?.enabled) this.status.textContent = 'Automatic disk sync is off.'
    else if (settings.syncing) this.status.textContent = 'Syncing saved collection changes…'
    else if (settings.error) this.status.textContent = `Sync failed. ${settings.error}`
    else if (settings.lastSyncedAt) {
      const date = new Date(settings.lastSyncedAt)
      const time = date.toLocaleString()
      this.status.textContent = `Synced. Last synced: ${time}.`
    } else this.status.textContent = 'Automatic disk sync is enabled. Waiting for the first sync.'
  }

  /** Display recoverable setup errors without closing or clearing the form. */
  private showError(message: string): void {
    if (this.disposed) return
    this.error.textContent = message
    this.error.hidden = false
  }

  /** Refresh choices after collections are created, renamed, or deleted in any sidebar. */
  private storageChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
    if (area !== 'local') return
    if (DISK_SYNC_KEY in changes) this.showStatus(changes[DISK_SYNC_KEY].newValue)
    if (COLLECTION_INDEX_KEY in changes) void this.renderCollections().catch(this.reportCollectionError)
  }

  /** Keep a failed list refresh visible instead of silently dropping selection choices. */
  private reportCollectionError = (): void => {
    this.showError('Could not refresh collections. Close and reopen the sidebar to try again.')
  }

  /** Show progress-storage failures that the background could not save to extension storage. */
  private handleSyncFailure = (message: {type?: string}, sender: chrome.runtime.MessageSender): void => {
    if (message?.type !== 'disk-sync-failed' || sender.id !== chrome.runtime.id) return
    if (this.disposed) return
    this.retryButton.hidden = false
    this.status.textContent = 'Sync failed. Could not read or save sync progress. Select Retry to try again.'
  }

  /** Request a final background check, then detach this sidebar's listeners without canceling disk writes. */
  private dispose = (): void => {
    if (this.settings?.enabled) void requestDiskSync().catch(this.ignoreClosedPage)
    this.disposed = true
    chrome.storage.onChanged.removeListener(this.storageChanged)
    chrome.runtime.onMessage.removeListener(this.handleSyncFailure)
  }

  /** A closing document cannot show errors; saved changes remain available for the next background check. */
  private ignoreClosedPage = (): void => {}
}
