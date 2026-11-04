/**
 * Set headers that fetch() cannot send, such as Cookie, Origin, Referer, and User-Agent.
 * Chromium uses declarativeNetRequest session rules. Firefox uses a blocking webRequest listener.
 * Both remove the extension's own Origin header when the editor has no Origin header, so the request matches curl.
 */
import type {HeaderPair} from './http-messages'

/** The headers to add to the fetch() call that runs while the rule is active. */
export type SendWithRule<T> = (markerHeaders: HeaderPair[]) => Promise<T>

/**
 * Run one fetch() call while the browser rewrites its locked headers.
 * The runner removes the rule after the send callback resolves or fails.
 */
export type HeaderRuleRunner = <T>(
  url: URL,
  ruleHeaders: HeaderPair[],
  send: SendWithRule<T>
) => Promise<T>

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
 */
export function createChromiumHeaderRuleRunner(): HeaderRuleRunner {
  const ready = removeStaleSessionRules()
  const hostQueues = new Map<string, Promise<void>>()
  let nextRuleId = 1

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
    send: SendWithRule<T>
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

    /** Keep the rule active only while this request is in the network stack. */
    async function sendWithRule(): Promise<T> {
      await chrome.declarativeNetRequest.updateSessionRules({addRules: [rule]})
      try {
        return await send([])
      } finally {
        await chrome.declarativeNetRequest.updateSessionRules({removeRuleIds: [ruleId]})
      }
    }
    return runInHostQueue(url.host, sendWithRule)
  }

  return runWithChromiumRule
}

/** One HTTP header in a Firefox webRequest event. */
interface FirefoxHeader {
  name: string
  value?: string
}

/** The fields of a Firefox onBeforeSendHeaders event and its reply that the listener uses. */
interface FirefoxHeaderChange {
  requestHeaders?: FirefoxHeader[]
}

/** The request header that links a Firefox request to its rule headers. The listener removes it before sending. */
const FIREFOX_MARKER_HEADER = 'x-browsercurl-request'

/**
 * Create the Firefox rule runner.
 * Each request carries a unique marker header, so parallel requests to one host do not share headers.
 */
export function createFirefoxHeaderRuleRunner(): HeaderRuleRunner {
  const pendingHeaders = new Map<string, HeaderPair[]>()

  /** Replace locked headers on marked requests and remove the marker header. */
  function rewriteRequestHeaders(details: FirefoxHeaderChange): FirefoxHeaderChange {
    const headers = details.requestHeaders ?? []
    const marker = headers.find((header) => header.name.toLowerCase() === FIREFOX_MARKER_HEADER)
    if (!marker) return {}

    const ruleHeaders = pendingHeaders.get(marker.value ?? '') ?? []
    const replacedNames = new Set(ruleHeaders.map(([name]) => name))
    replacedNames.add(FIREFOX_MARKER_HEADER)
    replacedNames.add('origin')
    const requestHeaders: FirefoxHeader[] = []
    for (const header of headers) {
      const name = header.name.toLowerCase()
      if (!replacedNames.has(name)) requestHeaders.push(header)
    }
    for (const [name, value] of ruleHeaders) requestHeaders.push({name, value})
    return {requestHeaders}
  }

  browser.webRequest.onBeforeSendHeaders.addListener(
    rewriteRequestHeaders,
    {urls: ['http://*/*', 'https://*/*']},
    ['blocking', 'requestHeaders']
  )

  /** Store the rule headers under a new marker value while the request runs. */
  async function runWithFirefoxRule<T>(
    _url: URL,
    ruleHeaders: HeaderPair[],
    send: SendWithRule<T>
  ): Promise<T> {
    const marker = crypto.randomUUID()
    pendingHeaders.set(marker, ruleHeaders)
    try {
      return await send([[FIREFOX_MARKER_HEADER, marker]])
    } finally {
      pendingHeaders.delete(marker)
    }
  }

  return runWithFirefoxRule
}
