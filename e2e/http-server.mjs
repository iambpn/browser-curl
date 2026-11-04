/** Real loopback HTTP endpoints for request, header, response, cancellation, and worker lifecycle tests. */
import {createServer} from 'node:http'
import {gzipSync} from 'node:zlib'

/** Own a local server and held responses. No endpoint sends CORS permission headers. */
export class TestHttpServer {
  requests = []
  held = new Map()
  closedResponses = new Set()
  origin = ''
  server

  /** Connect the request handler after all instance callbacks are initialized. */
  constructor() {
    this.server = createServer(this.handleRequest)
  }

  /** Bind an unused loopback port and expose its origin to the current test. */
  async start() {
    await new Promise(this.listen)
    const address = this.server.address()
    this.origin = `http://127.0.0.1:${address.port}`
  }

  /** Register the listening callback before the server starts accepting connections. */
  listen = (resolve, reject) => {
    this.server.once('error', reject)
    this.server.listen(0, '127.0.0.1', resolve)
  }

  /** Read the real request body before recording and answering it. */
  handleRequest = async (request, response) => {
    const chunks = []
    try {
      for await (const chunk of request) chunks.push(chunk)
      const bytes = Buffer.concat(chunks)
      const body = bytes.toString('utf8')
      const received = {
        method: request.method, url: request.url, headers: request.headers,
        rawHeaders: request.rawHeaders, body
      }
      this.requests.push(received)
      this.respond(received, response)
    } catch {
      response.destroy()
    }
  }

  /** Serve actual HTTP statuses, compression, redirects, failures, and controllable pending responses. */
  respond(received, response) {
    const url = new URL(received.url, this.origin)
    const closedResponses = this.closedResponses
    /** Observe real socket closure for cancellation and timeout assertions outside the browser. */
    function responseClosed() { closedResponses.add(url.pathname) }
    response.once('close', responseClosed)
    if (url.pathname.startsWith('/hold/')) {
      response.setHeader('Content-Type', 'application/json')
      if (url.searchParams.has('stream')) response.flushHeaders()
      this.held.set(url.pathname, response)
      return
    }
    if (url.pathname === '/disconnect') {
      response.destroy()
      return
    }
    if (url.pathname === '/redirect') {
      response.writeHead(302, {Location: '/echo?redirected=yes'})
      response.end()
      return
    }
    response.setHeader('Content-Type', 'application/json; charset=utf-8')
    response.setHeader('X-Test-Response', 'preserved')
    if (url.pathname === '/gzip') {
      response.setHeader('Content-Encoding', 'gzip')
      const compressed = gzipSync('{"compressed":true}')
      response.end(compressed)
      return
    }
    if (url.pathname === '/status/418') {
      response.statusCode = 418
      response.end('{"error":"test status"}')
      return
    }
    response.end(JSON.stringify(received))
  }

  /** Finish a held response only after the test closes or reopens the actual extension page. */
  release(path, body = '{"finished":true}') {
    const response = this.held.get(path)
    if (!response) throw new Error(`No pending response for ${path}`)
    this.held.delete(path)
    response.end(body)
  }

  /** Close all sockets and release the listening port even when a test leaves a request pending. */
  async close() {
    if (!this.server.listening) return
    this.server.closeAllConnections()
    await new Promise(this.stopListening)
  }

  /** Resolve teardown after the loopback listener closes. */
  stopListening = (resolve, reject) => {
    /** Surface a server teardown failure to the test runner. */
    function closed(error) {
      if (error) reject(error)
      else resolve()
    }
    this.server.close(closed)
  }
}
