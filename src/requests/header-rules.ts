/**
 * Set headers that fetch() cannot send, such as Cookie, Origin, Referer, and User-Agent.
 * Chromium uses declarativeNetRequest session rules. Firefox uses a blocking webRequest listener.
 * Both remove the extension's own Origin header when the editor has no Origin header, so the request matches curl.
 * Both also report the request headers that the browser sends, through a webRequest onSendHeaders listener.
 */
import type {HeaderPair} from './http-messages'

/** The headers to add to the fetch() call that runs while the rule is active. */
export type SendWithRule<T> = (markerHeaders: HeaderPair[]) => Promise<T>

/**
 * Receive the request headers that the browser reports just before it sends the request.
 * Names are lowercase. The browser leaves out some headers, such as Host and Content-Length.
 * A redirect can call the recorder again with the headers of the next request.
 */
export type SentHeadersRecorder = (headers: HeaderPair[]) => void

/**
 * Run one fetch() call while the browser rewrites its locked headers.
 * The runner removes the rule after the send callback resolves or fails.
 * recordSentHeaders receives the headers that the browser reports for this request, if it reports them before the send ends.
 */
export type HeaderRuleRunner = <T>(
  url: URL,
  ruleHeaders: HeaderPair[],
  send: SendWithRule<T>,
  recordSentHeaders: SentHeadersRecorder
) => Promise<T>

/** One HTTP header in a webRequest event. Binary headers have no text value. */
interface WebRequestHeader {
  name: string
  value?: string
}

/** The URL patterns that the webRequest listeners watch. The host permissions cover the same sites. */
const WEB_REQUEST_URLS = ['http://*/*', 'https://*/*']

/** Convert webRequest headers into pairs with lowercase names. Headers without a text value are left out. */
function toHeaderPairs(headers: WebRequestHeader[] = []): HeaderPair[] {
  const pairs: HeaderPair[] = []
  for (const header of headers) {
    if (header.value === undefined) continue
    pairs.push([header.name.toLowerCase(), header.value])
  }
  return pairs
}

/** Chromium's tab ID for requests that do not come from a tab, such as service worker requests. */
const TAB_ID_NONE = -1

/** Remove session rules that a previous service worker instance did not remove. */
async function removeStaleSessionRules(): Promise<void> {
  const rules = await chrome.declarativeNetRequest.getSessionRules()
  if (!rules.length) return
  const removeRuleIds = rules.map((rule) => rule.id)
  await chrome.declarativeNetRequest.updateSessionRules({removeRuleIds})
}

/** Build the header operations for one Chromium rule. */
function chromiumHeaderOperations(
  ruleHeaders: HeaderPair[]
): chrome.declarativeNetRequest.ModifyHeaderInfo[] {
  const {HeaderOperation} = chrome.declarativeNetRequest
  const operations: chrome.declarativeNetRequest.ModifyHeaderInfo[] = []
  for (const [header, value] of ruleHeaders) {
    operations.push({header, operation: HeaderOperation.SET, value})
  }
  const hasOrigin = ruleHeaders.some(([header]) => header === 'origin')
  if (!hasOrigin) operations.push({header: 'origin', operation: HeaderOperation.REMOVE})
  return operations
}

/**
 * Create the Chromium rule runner.
 * A rule matches by host, so the runner sends one request at a time for each host.
 * Requests to different hosts still run in parallel.
 * The same one-request-per-host order lets the runner match each reported header list to its request by host.
 */
export function createChromiumHeaderRuleRunner(): HeaderRuleRunner {
  const ready = removeStaleSessionRules()
  const hostQueues = new Map<string, Promise<void>>()
  const extensionOrigin = new URL(chrome.runtime.getURL('')).origin
  /** The recorder of the running request on each host. A recorder is removed after it receives one header list. */
  const sentHeaderRecorders = new Map<string, SentHeadersRecorder>()
  let nextRuleId = 1

  /**
   * Pass the headers that Chromium sends to the running request for the same host.
   * Requests from web pages and other extensions are ignored.
   */
  function recordChromiumSentHeaders(details: chrome.webRequest.WebRequestHeadersDetails): void {
    if (details.initiator !== extensionOrigin) return
    const host = new URL(details.url).host
    const record = sentHeaderRecorders.get(host)
    if (!record) return
    sentHeaderRecorders.delete(host)
    record(toHeaderPairs(details.requestHeaders))
  }

  // extraHeaders makes Chromium report Cookie, Referer, Origin, Accept-Language, and Accept-Encoding.
  chrome.webRequest.onSendHeaders.addListener(
    recordChromiumSentHeaders,
    {urls: WEB_REQUEST_URLS, tabId: TAB_ID_NONE},
    ['requestHeaders', 'extraHeaders']
  )

  /** Wait for earlier requests to the same host, run the task, and then let the next request start. */
  async function runInHostQueue<T>(host: string, task: () => Promise<T>): Promise<T> {
    const previous = hostQueues.get(host) ?? Promise.resolve()
    let release = (): void => {}
    /** Store the function that lets the next request for this host start. */
    function storeRelease(resolve: () => void): void {
      release = resolve
    }
    const current = new Promise<void>(storeRelease)
    hostQueues.set(host, current)
    await previous
    try {
      return await task()
    } finally {
      release()
      if (hostQueues.get(host) === current) hostQueues.delete(host)
    }
  }

  /** Add a session rule for the request host, send the request, and remove the rule. */
  async function runWithChromiumRule<T>(
    url: URL,
    ruleHeaders: HeaderPair[],
    send: SendWithRule<T>,
    recordSentHeaders: SentHeadersRecorder
  ): Promise<T> {
    await ready
    const {ResourceType, RuleActionType} = chrome.declarativeNetRequest
    const ruleId = nextRuleId
    nextRuleId += 1
    const rule: chrome.declarativeNetRequest.Rule = {
      id: ruleId,
      priority: 1,
      action: {
        type: RuleActionType.MODIFY_HEADERS,
        requestHeaders: chromiumHeaderOperations(ruleHeaders)
      },
      condition: {
        requestDomains: [url.hostname],
        initiatorDomains: [chrome.runtime.id],
        tabIds: [TAB_ID_NONE],
        resourceTypes: [ResourceType.XMLHTTPREQUEST, ResourceType.OTHER]
      }
    }

    /** Keep the rule and the header recorder active only while this request is in the network stack. */
    async function sendWithRule(): Promise<T> {
      await chrome.declarativeNetRequest.updateSessionRules({addRules: [rule]})
      sentHeaderRecorders.set(url.host, recordSentHeaders)
      try {
        return await send([])
      } finally {
        sentHeaderRecorders.delete(url.host)
        await chrome.declarativeNetRequest.updateSessionRules({removeRuleIds: [ruleId]})
      }
    }
    return runInHostQueue(url.host, sendWithRule)
  }

  return runWithChromiumRule
}

/** The fields of a Firefox onBeforeSendHeaders or onSendHeaders event that the listeners use. */
interface FirefoxHeaderDetails {
  requestId: string
  requestHeaders?: WebRequestHeader[]
}

/** The reply of the Firefox onBeforeSendHeaders listener. An empty reply keeps the headers unchanged. */
interface FirefoxHeaderChange {
  requestHeaders?: WebRequestHeader[]
}

/** The rule headers and the header recorder of one running Firefox request. */
interface FirefoxPendingRequest {
  ruleHeaders: HeaderPair[]
  recordSentHeaders: SentHeadersRecorder
}

/** The request header that links a Firefox request to its rule headers. The listener removes it before sending. */
const FIREFOX_MARKER_HEADER = 'x-browsercurl-request'

/**
 * Create the Firefox rule runner.
 * Each request carries a unique marker header, so parallel requests to one host do not share headers.
 * The marker also links the browser's request ID to the request, so the reported headers reach the right request.
 */
export function createFirefoxHeaderRuleRunner(): HeaderRuleRunner {
  const pendingRequests = new Map<string, FirefoxPendingRequest>()
  /** The marker of each running request, by the browser's request ID, until the browser reports the sent headers. */
  const markersByRequestId = new Map<string, string>()

  /** Replace locked headers on marked requests and remove the marker header. */
  function rewriteRequestHeaders(details: FirefoxHeaderDetails): FirefoxHeaderChange {
    const headers = details.requestHeaders ?? []
    const marker = headers.find((header) => header.name.toLowerCase() === FIREFOX_MARKER_HEADER)
    if (!marker) return {}

    const markerValue = marker.value ?? ''
    const pending = pendingRequests.get(markerValue)
    if (pending) markersByRequestId.set(details.requestId, markerValue)
    const ruleHeaders = pending?.ruleHeaders ?? []
    const replacedNames = new Set(ruleHeaders.map(([name]) => name))
    replacedNames.add(FIREFOX_MARKER_HEADER)
    replacedNames.add('origin')
    const requestHeaders: WebRequestHeader[] = []
    for (const header of headers) {
      const name = header.name.toLowerCase()
      if (!replacedNames.has(name)) requestHeaders.push(header)
    }
    for (const [name, value] of ruleHeaders) requestHeaders.push({name, value})
    return {requestHeaders}
  }

  /** Pass the headers that Firefox sends, after the rewrite, to the request that the marker identified. */
  function recordFirefoxSentHeaders(details: FirefoxHeaderDetails): void {
    const marker = markersByRequestId.get(details.requestId)
    if (marker === undefined) return
    markersByRequestId.delete(details.requestId)
    const pending = pendingRequests.get(marker)
    pending?.recordSentHeaders(toHeaderPairs(details.requestHeaders))
  }

  browser.webRequest.onBeforeSendHeaders.addListener(
    rewriteRequestHeaders,
    {urls: WEB_REQUEST_URLS},
    ['blocking', 'requestHeaders']
  )
  browser.webRequest.onSendHeaders.addListener(
    recordFirefoxSentHeaders,
    {urls: WEB_REQUEST_URLS},
    ['requestHeaders']
  )

  /** Remove the request ID links of a finished request. Firefox sends no headers for a request that fails early. */
  function forgetRequestIds(marker: string): void {
    for (const [requestId, requestMarker] of markersByRequestId) {
      if (requestMarker === marker) markersByRequestId.delete(requestId)
    }
  }

  /** Store the rule headers and the header recorder under a new marker value while the request runs. */
  async function runWithFirefoxRule<T>(
    _url: URL,
    ruleHeaders: HeaderPair[],
    send: SendWithRule<T>,
    recordSentHeaders: SentHeadersRecorder
  ): Promise<T> {
    const marker = crypto.randomUUID()
    pendingRequests.set(marker, {ruleHeaders, recordSentHeaders})
    try {
      return await send([[FIREFOX_MARKER_HEADER, marker]])
    } finally {
      pendingRequests.delete(marker)
      forgetRequestIds(marker)
    }
  }

  return runWithFirefoxRule
}
