/** Open the sidebar and send HTTP requests for it. */
import {createHttpRequestHandlers} from './requests/http-runner'
import {createChromiumHeaderRuleRunner, createFirefoxHeaderRuleRunner} from './requests/header-rules'
import {recoverInterruptedRequests} from './history/request-store'

// Named one by one so the bundler can fold each build down to a single branch.
const isFirefoxLike =
  import.meta.env.EXTENSION_PUBLIC_BROWSER === 'firefox' ||
  import.meta.env.EXTENSION_PUBLIC_BROWSER === 'gecko-based'

if (isFirefoxLike) {
  // Firefox refuses sidebarAction.open() outside a user input handler, and a
  // message listener is not one, so the toolbar click is the only route.
  browser.browserAction.onClicked.addListener(() => {
    browser.sidebarAction.open()
  })
}

if (!isFirefoxLike) {
  // setPanelBehavior only affects FUTURE action clicks, registering it
  // inside onClicked would swallow the first toolbar click.
  chrome.sidePanel?.setPanelBehavior({openPanelOnActionClick: true})
}

const runWithHeaderRules = isFirefoxLike ? createFirefoxHeaderRuleRunner() : createChromiumHeaderRuleRunner()
const requestHandlers = createHttpRequestHandlers(runWithHeaderRules)
chrome.runtime.onConnect.addListener(requestHandlers.handleHttpPort)
chrome.runtime.onMessage.addListener(requestHandlers.handleControlMessage)

/** Report storage failure at startup without blocking the panel's request listeners. */
function reportRecoveryFailure(error: unknown): void {
  console.error('Could not restore request history.', error)
}
void recoverInterruptedRequests().catch(reportRecoveryFailure)
