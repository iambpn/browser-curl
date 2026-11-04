/** Format response body text and byte counts for display. */

/** Format JSON when requested and leave other response formats unchanged. */
export function formatResponse(body: string, pretty: boolean): string {
  if (!pretty || !body) return body
  try {
    const parsed = JSON.parse(body)
    return JSON.stringify(parsed, null, 2)
  } catch {
    return body
  }
}

/** Display the response body's byte count with a compact unit. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kilobytes = bytes / 1024
  if (kilobytes < 1024) return `${kilobytes.toFixed(1)} KB`
  const megabytes = kilobytes / 1024
  return `${megabytes.toFixed(1)} MB`
}
