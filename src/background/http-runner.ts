/**
 * Send HTTP requests for the sidebar from the background context.
 * The extension has host access, so the browser does not apply CORS checks to these requests.
 */
import {sortRequestHeaders} from './locked-headers.ts'
import type {HeaderRuleRunner} from './header-rules'
import {HTTP_REQUEST_PORT, REQUEST_TIMEOUT_MS} from '../shared/http-messages.ts'
import {createSavedRequest, deleteSavedRequest, finishSavedRequest} from '../shared/request-store.ts'
import {resolveRequestName} from '../shared/request-state.ts'
import type {
  HeaderPair,
  HttpRequestPayload,
  HttpResponsePayload,
  HttpResultMessage,
  HttpSendMessage,
  HttpControlMessage
} from '../shared/http-messages'

/** Send one request with the locked headers applied, and read the complete response body. */
async function sendHttpRequest(
  request: HttpRequestPayload,
  signal: AbortSignal,
  runWithHeaderRules: HeaderRuleRunner
): Promise<HttpResponsePayload> {
  const url = new URL(request.url)
  const sortedHeaders = sortRequestHeaders(request.headers)
  let startedAt = 0

  /** Start fetch() after the rule is active. The rule stays active until the response headers arrive. */
  function startFetch(markerHeaders: HeaderPair[]): Promise<Response> {
    const headers = new Headers(sortedHeaders.fetchHeaders)
    for (const [name, value] of markerHeaders) headers.set(name, value)
    startedAt = performance.now()
    return fetch(url, {
      method: request.method,
      headers,
      body: request.body,
      credentials: 'omit',
      cache: 'no-store',
      signal
    })
  }

  const response = await runWithHeaderRules(url, sortedHeaders.ruleHeaders, startFetch)
  const buffer = await response.arrayBuffer()
  const elapsed = performance.now() - startedAt
  const headers: HeaderPair[] = []
  for (const [name, value] of response.headers) headers.push([name, value])

  return {
    status: response.status,
    statusText: response.statusText,
    url: response.url,
    headers,
    body: new TextDecoder().decode(buffer),
    size: buffer.byteLength,
    durationMs: Math.round(elapsed),
    skippedHeaders: sortedHeaders.skippedHeaders
  }
}

/** Convert a fetch() failure into a message that tells the user what to check. */
function describeFailure(error: unknown, url: string, timedOut: boolean): string {
  if (timedOut) return `The request timed out after ${REQUEST_TIMEOUT_MS / 1000} seconds.`
  if (error instanceof TypeError) {
    return `Could not connect to ${url}. Check the URL, the server, and your network connection.`
  }
  if (error instanceof Error) return error.message
  return 'Could not send the request.'
}

/** Return true only for messages from extension pages, such as the sidebar. */
function isExtensionPage(sender: chrome.runtime.MessageSender | undefined): boolean {
  const extensionRoot = chrome.runtime.getURL('')
  const senderUrl = sender?.url ?? ''
  return sender?.id === chrome.runtime.id && senderUrl.startsWith(extensionRoot)
}

/**
 * Own running requests independently of panel lifetimes, and serialize persistence through the shared store.
 * Requests stop on explicit cancellation or timeout. Closing a panel only detaches its reply port.
 */
export function createHttpRequestHandlers(
  runWithHeaderRules: HeaderRuleRunner
): {
  handleHttpPort: (port: chrome.runtime.Port) => void
  handleControlMessage: (
    message: HttpControlMessage,
    sender: chrome.runtime.MessageSender,
    respond: (result: {error?: string}) => void
  ) => boolean
} {
  const controllers = new Map<string, AbortController>()

  /** Cancel running requests by ID or delete a whole history entry from a trusted extension page. */
  function handleControlMessage(
    message: HttpControlMessage,
    sender: chrome.runtime.MessageSender,
    respond: (result: {error?: string}) => void
  ): boolean {
    if (!isExtensionPage(sender) || typeof message?.id !== 'string') return false
    if (message.type === 'cancel-http-request') {
      controllers.get(message.id)?.abort()
      respond({})
      return false
    }
    if (message.type !== 'delete-saved-request') return false

    /** Confirm deletion after the serialized storage operation finishes. */
    function deleted(): void {
      respond({})
    }
    /** Report a failed deletion so the panel keeps the saved item visible. */
    function deletionFailed(): void {
      respond({error: 'Could not delete this saved request. Try again.'})
    }
    void deleteSavedRequest(message.id).then(deleted, deletionFailed)
    return true
  }

  /** Serve one request on a sidebar port and clean up when the request ends. */
  function handleHttpPort(port: chrome.runtime.Port): void {
    if (port.name !== HTTP_REQUEST_PORT) return
    if (!isExtensionPage(port.sender)) {
      port.disconnect()
      return
    }

    const controller = new AbortController()
    let isPortOpen = true
    let timedOut = false
    let started = false

    /** Stop a request that takes longer than the timeout. */
    function abortTimedOutRequest(): void {
      timedOut = true
      controller.abort()
    }
    /** Detach the panel without canceling the background request or its persistence. */
    function handleDisconnect(): void {
      isPortOpen = false
    }

    /** Send the result only if the sidebar still waits for it. */
    function reply(message: HttpResultMessage): void {
      port.onMessage.removeListener(handlePortMessage)
      port.onDisconnect.removeListener(handleDisconnect)
      if (!isPortOpen) return
      isPortOpen = false
      try {
        port.postMessage(message)
        port.disconnect()
      } catch {
        // The panel can close between completion and delivery. Its saved result remains available.
      }
    }

    /** Reset the worker idle timer only while this bounded request is running. */
    function keepRequestAlive(): void {
      void chrome.runtime.getPlatformInfo()
    }

    /** Save a send attempt first, then persist its complete result even after the panel closes. */
    async function runRequest(message: HttpSendMessage): Promise<void> {
      controllers.set(message.id, controller)
      try {
        await createSavedRequest({
          id: message.id,
          name: resolveRequestName(message.editor.name, message.request.url),
          sentAt: Date.now(),
          editor: message.editor,
          request: message.request
        })
      } catch {
        controllers.delete(message.id)
        reply({type: 'error', message: 'Could not save this request. The request was not sent.'})
        return
      }

      const timeout = setTimeout(abortTimedOutRequest, REQUEST_TIMEOUT_MS)
      const keepAlive = setInterval(keepRequestAlive, 10000)
      let result: HttpResultMessage
      try {
        const response = await sendHttpRequest(message.request, controller.signal, runWithHeaderRules)
        result = {type: 'response', response}
      } catch (error) {
        let errorMessage = describeFailure(error, message.request.url, timedOut)
        if (controller.signal.aborted && !timedOut) errorMessage = 'Request canceled.'
        result = {type: 'error', message: errorMessage}
      } finally {
        clearTimeout(timeout)
        clearInterval(keepAlive)
        controllers.delete(message.id)
      }

      try {
        await finishSavedRequest(message.id, result)
      } catch {
        result.storageError = 'Could not save the result. The saved request has no response. Try sending it again.'
        try {
          await finishSavedRequest(message.id, {type: 'error', message: result.storageError})
        } catch {
          // The live panel still receives the result and warning when storage remains unavailable.
        }
      }
      reply(result)
    }

    /** Accept one send message. Explicit cancellation uses the separate ID-based control listener. */
    function handlePortMessage(message: HttpSendMessage): void {
      if (message?.type !== 'send' || started) return
      started = true
      void runRequest(message)
    }

    port.onDisconnect.addListener(handleDisconnect)
    port.onMessage.addListener(handlePortMessage)
  }

  return {handleHttpPort, handleControlMessage}
}
