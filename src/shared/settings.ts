/** Response size limits that the user can change on the extension options page. */
import {readStorage, writeStorage} from './storage.ts'

/** The local storage key for the user's settings. */
export const SETTINGS_KEY = 'browsercurl.settings'

/** The number of bytes in one megabyte. The panel also uses 1024-based units for sizes. */
const BYTES_PER_MEGABYTE = 1024 * 1024

/** Response size limits in megabytes. */
export interface SizeSettings {
  /** The background stops reading a response body at this size and marks the response as cut off. */
  maxResponseMb: number
  /** History saves a response body only when the body is this size or smaller. */
  historyBodyLimitMb: number
}

/** The values to use when the user has not saved settings: a 10 MB response limit and a 2 MB history limit. */
export const DEFAULT_SETTINGS: SizeSettings = {maxResponseMb: 10, historyBodyLimitMb: 2}

/** A permitted range in megabytes, including both ends. */
export interface SettingRange {
  min: number
  max: number
}

/**
 * The permitted range for each setting, in megabytes.
 * maxResponseMb: 1 to 100. Use it to validate the maximum response size.
 * historyBodyLimitMb: 0 to 100. Use it to validate the history limit. 0 means that history never saves response bodies.
 */
export const SETTING_RANGES: Record<keyof SizeSettings, SettingRange> = {
  maxResponseMb: {min: 1, max: 100},
  historyBodyLimitMb: {min: 0, max: 100}
}

/** Convert megabytes to a whole number of bytes. */
export function megabytesToBytes(megabytes: number): number {
  return Math.round(megabytes * BYTES_PER_MEGABYTE)
}

/** Return true when the value is a finite number inside the range. */
export function isInRange(value: unknown, range: SettingRange): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false
  return value >= range.min && value <= range.max
}

/** Use each saved value that is valid, and the default value for each missing or invalid one. */
export function normalizeSettings(saved: unknown): SizeSettings {
  const values = (saved ?? {}) as Partial<Record<keyof SizeSettings, unknown>>
  const settings = {...DEFAULT_SETTINGS}
  for (const name of Object.keys(SETTING_RANGES) as (keyof SizeSettings)[]) {
    const value = values[name]
    if (isInRange(value, SETTING_RANGES[name])) settings[name] = value
  }
  return settings
}

/** Read the saved settings. Missing or invalid values use the defaults. Rejects when storage is unavailable. */
export async function loadSettings(): Promise<SizeSettings> {
  const items = await readStorage(SETTINGS_KEY)
  return normalizeSettings(items[SETTINGS_KEY])
}

/** Save the settings. New requests use them. Requests that already run keep their earlier limits. */
export function saveSettings(settings: SizeSettings): Promise<void> {
  return writeStorage({[SETTINGS_KEY]: settings})
}
