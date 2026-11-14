/** The variable-preserving parser shared with Postman's collection SDK. */
declare module 'postman-url-encoder/parser/index.js' {
  export function parse(url: string): {
    raw: string
    protocol?: string
    auth?: [string, string?]
    host?: string[]
    port?: string
    path?: string[]
    query?: string[]
    hash?: string
  }
}
