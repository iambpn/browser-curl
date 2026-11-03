/** Send requests through the background script, which has host access and is not limited by CORS. */
import {HTTP_REQUEST_PORT} from '../shared/http-messages'
import type {
  HttpRequestPayload,
  HttpResponsePayload,
  HttpResultMessage,
  HttpSendMessage
} from '../shared/http-messages'

/**
 * Send one request and wait for the complete response.
 * If the signal aborts, the port closes, the background script stops the request, and the promise rejects.
 */
export function sendThroughBackground(
  request: HttpRequestPayload,
  signal: AbortSignal
): Promise<HttpResponsePayload> {
  /** Connect a port for this request and settle the promise with its first result. */
  function connectRequestPort(
    resolve: (response: HttpResponsePayload) => void,
    reject: (error: Error) => void
  ): void {
    const port = chrome.runtime.connect({name: HTTP_REQUEST_PORT})
    let isSettled = false

    /** Remove listeners after the request ends, so a late event cannot change the result. */
    function finish(): void {
      isSettled = true
      signal.removeEventListener('abort', handleAbort)
      port.onMessage.removeListener(handleResult)
      port.onDisconnect.removeListener(handleDisconnect)
    }

    /** Close the port so the background script stops the request. */
    function handleAbort(): void {
      if (isSettled) return
      finish()
      port.disconnect()
      reject(new DOMException('Request canceled.', 'AbortError'))
    }

    /** Resolve with the response, or reject with the background script's error message. */
    function handleResult(message: HttpResultMessage): void {
      if (isSettled) return
      finish()
      if (message.type === 'response') resolve(message.response)
      else reject(new Error(message.message))
    }

    /** Reject if the background script closes the port without a result. */
    function handleDisconnect(): void {
      if (isSettled) return
      finish()
      const lastError = chrome.runtime.lastError?.message
      reject(new Error(lastError ?? 'The background script stopped before the request finished.'))
    }

    port.onMessage.addListener(handleResult)
    port.onDisconnect.addListener(handleDisconnect)
    signal.addEventListener('abort', handleAbort)
    const message: HttpSendMessage = {type: 'send', request}
    port.postMessage(message)
  }

  if (signal.aborted) {
    const canceled = new DOMException('Request canceled.', 'AbortError')
    return Promise.reject(canceled)
  }
  return new Promise(connectRequestPort)
}
