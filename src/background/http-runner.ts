/**
 * Send HTTP requests for the sidebar from the background context.
 * The extension has host access, so the browser does not apply CORS checks to these requests.
 */
import {sortRequestHeaders} from './locked-headers'
import type {HeaderRuleRunner} from './header-rules'
import {HTTP_REQUEST_PORT, REQUEST_TIMEOUT_MS} from '../shared/http-messages'
import type {
  HeaderPair,
  HttpRequestPayload,
  HttpResponsePayload,
  HttpResultMessage,
  HttpSendMessage
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

/** Return true only for ports that an extension page opened, such as the sidebar. */
function isExtensionPage(port: chrome.runtime.Port): boolean {
  const extensionRoot = chrome.runtime.getURL('')
  const senderUrl = port.sender?.url ?? ''
  return port.sender?.id === chrome.runtime.id && senderUrl.startsWith(extensionRoot)
}

/**
 * Create a port listener that sends one request for each sidebar port.
 * The request stops when the sidebar disconnects the port or after the timeout.
 */
export function createHttpPortListener(
  runWithHeaderRules: HeaderRuleRunner
): (port: chrome.runtime.Port) => void {
  /** Serve one request on a sidebar port and clean up when the request ends. */
  function handleHttpPort(port: chrome.runtime.Port): void {
    if (port.name !== HTTP_REQUEST_PORT) return
    if (!isExtensionPage(port)) {
      port.disconnect()
      return
    }

    const controller = new AbortController()
    let isPortOpen = true
    let timedOut = false

    /** Stop a request that takes longer than the timeout. */
    function abortTimedOutRequest(): void {
      timedOut = true
      controller.abort()
    }
    const timeout = setTimeout(abortTimedOutRequest, REQUEST_TIMEOUT_MS)

    /** Stop the request when the sidebar cancels it or closes. */
    function handleDisconnect(): void {
      isPortOpen = false
      clearTimeout(timeout)
      controller.abort()
    }

    /** Send the result only if the sidebar still waits for it. */
    function reply(message: HttpResultMessage): void {
      if (!isPortOpen) return
      port.postMessage(message)
      port.disconnect()
      isPortOpen = false
    }

    /** Run the request from the first send message and report its result. */
    async function handleSendMessage(message: HttpSendMessage): Promise<void> {
      port.onMessage.removeListener(handleSendMessage)
      if (message?.type !== 'send') return
      try {
        const response = await sendHttpRequest(message.request, controller.signal, runWithHeaderRules)
        reply({type: 'response', response})
      } catch (error) {
        const errorMessage = describeFailure(error, message.request.url, timedOut)
        reply({type: 'error', message: errorMessage})
      } finally {
        clearTimeout(timeout)
      }
    }

    port.onDisconnect.addListener(handleDisconnect)
    port.onMessage.addListener(handleSendMessage)
  }

  return handleHttpPort
}
