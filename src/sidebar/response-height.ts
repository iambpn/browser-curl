/** Store the response panel's preferred height without saving request data. */

/** Local preference shared by sidebar sessions in this extension. */
const RESPONSE_HEIGHT_KEY = 'browsercurl.responseHeight'

/** Read a valid pixel height, or use the default if storage is missing or unavailable. */
export function loadResponseHeight(): number | undefined {
  try {
    const stored = localStorage.getItem(RESPONSE_HEIGHT_KEY)
    if (stored === null) return undefined
    const height = Number(stored)
    if (!Number.isFinite(height) || height < 140) return undefined
    return Math.round(height)
  } catch {
    return undefined
  }
}

/** Save a user-selected pixel height without interrupting resizing if storage fails. */
export function saveResponseHeight(height: number): void {
  if (!Number.isFinite(height) || height < 140) return
  const pixels = Math.round(height)
  try {
    localStorage.setItem(RESPONSE_HEIGHT_KEY, String(pixels))
  } catch {
    // The panel remains resizable when browser storage is unavailable.
  }
}
