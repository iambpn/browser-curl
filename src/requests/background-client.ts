/** Send requests through the background script, which has host access and is not limited by CORS. */
import {HTTP_REQUEST_PORT} from './http-messages'
import type {
  HttpRequestPayload,
  HttpControlMessage,
  HttpResultMessage,
  HttpSendMessage
} from './http-messages'
import type {EditorState} from '../history/request-state'

/**
 * Send one request and wait for the complete response.
 * Closing the panel detaches this client. The background still stores the complete result.
 */
export function sendThroughBackground(
  request: HttpRequestPayload,
  editor: EditorState,
  id: string
): Promise<HttpResultMessage> {
  /** Connect a port for this request and settle the promise with its first result. */
  function connectRequestPort(
    resolve: (response: HttpResultMessage) => void,
    reject: (error: Error) => void
  ): void {
    const port = chrome.runtime.connect({name: HTTP_REQUEST_PORT})
    let isSettled = false

    /** Remove listeners after the request ends, so a late event cannot change the result. */
    function finish(): void {
      isSettled = true
      port.onMessage.removeListener(handleResult)
      port.onDisconnect.removeListener(handleDisconnect)
    }

    /** Resolve with the background's complete response or saved failure. */
    function handleResult(message: HttpResultMessage): void {
      if (isSettled) return
      finish()
      resolve(message)
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
    const message: HttpSendMessage = {type: 'send', id, editor, request}
    port.postMessage(message)
  }

  return new Promise(connectRequestPort)
}

/** Cancel by saved ID or delete history through the background's serialized operations. */
export function controlSavedRequest(message: HttpControlMessage): Promise<void> {
  /** Await a trusted background response and expose messaging and storage failures. */
  function send(resolve: () => void, reject: (error: Error) => void): void {
    /** Check the runtime error while it is available inside the callback. */
    function finish(result: {error?: string} | undefined): void {
      const messageError = chrome.runtime.lastError?.message
      const error = messageError ?? result?.error
      if (error) reject(new Error(error))
      else if (!result) reject(new Error('The background script did not respond. Try again.'))
      else resolve()
    }
    chrome.runtime.sendMessage(message, finish)
  }
  return new Promise(send)
}
