/**
 * The Cloudflare globals the worker's signature mentions, defined locally.
 *
 * `@cloudflare/workers-types` would supply these, but adding it to tsconfig's `types` makes it
 * GLOBAL — it then overrides the DOM/Node definitions of `Response`, `fetch` and friends across
 * every file in the project. Measured: 72 errors → 93, with 30 new `TS18046 … is of type
 * 'unknown'` that exist only because of the override. The package is meant to scope to
 * `workers/`, and the root project is not that scope.
 *
 * What the tests actually need is narrow: a value to pass as the worker's `ctx`, and a shape
 * for the KV bindings they fake. Declaring that here costs a file and no global effects.
 */

/** The third argument to `worker.fetch`. Tests pass an empty object; nothing calls into it. */
export interface TestExecutionContext {
  waitUntil(promise: Promise<unknown>): void
  passThroughOnException(): void
}

/** The subset of KV the worker uses, which is also all the in-memory fakes implement. */
export interface TestKVNamespace {
  get(key: string): Promise<string | null>
  put(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
  list(opts?: { prefix?: string }): Promise<{ keys: Array<{ name: string }>; list_complete: boolean }>
}
