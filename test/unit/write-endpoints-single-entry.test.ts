import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Every write endpoint goes through `handleManage`, and `handleManage` rejects a bodyless POST
 * before touching anything.
 *
 * This is the reasoning that makes `pnpm check:deploy-order` safe to point at production: its
 * POST probe sends `{}`, which dies on the `from` check inside that single handler — before any
 * signature verification, before KV, before a transaction. A reviewer declined to run the check
 * against the live worker for exactly this worry, and lost the only probe that distinguishes a
 * deployed POST-only endpoint from an absent one.
 *
 * The reasoning has one load-bearing premise — ONE entry point — and that is precisely what the
 * next endpoint added to this worker can break, silently and while every other test stays green.
 * So the premise is pinned here rather than left in a comment.
 */
const WORKER = join(__dirname, '..', '..', 'workers', 'api', 'src', 'index.ts')
const src = readFileSync(WORKER, 'utf8')

/** Paths dispatched with a POST-style body, as written in the router. */
export function dispatchedWritePaths(source: string): string[] {
  return [...source.matchAll(/path === '(\/[a-z-]+)'\)\s*\{\s*response = await handleManage\(/g)].map(
    (m) => m[1],
  )
}

/** Every `path === '…'` the router tests, regardless of handler. */
export function allDispatched(source: string): string[] {
  return [...source.matchAll(/path === '(\/[a-z-]+)'/g)].map((m) => m[1])
}

const WRITE_PATHS = [
  '/register',
  '/apply',
  '/approve',
  '/set-addr',
  '/transfer-subnode',
  '/set-text',
  '/set-contenthash',
]

describe('every write endpoint has exactly one entry point', () => {
  it('the router is readable at all (control)', () => {
    // Without this, a regex that stopped matching would make every assertion below vacuous.
    expect(allDispatched(src).length).toBeGreaterThan(WRITE_PATHS.length)
  })

  it('all seven write paths dispatch into handleManage', () => {
    const via = new Set(dispatchedWritePaths(src))
    expect(WRITE_PATHS.filter((p) => !via.has(p))).toEqual([])
  })

  it('handleManage rejects a body with no `from` before anything else', () => {
    // The specific statement the safety argument rests on. If it moves below a signature check
    // or a KV read, `{}` stops being inert and the probe stops being safe.
    const body = src.slice(src.indexOf('async function handleManage'))
    const fromCheck = body.indexOf("throw badReq('Invalid from address')")
    expect(fromCheck).toBeGreaterThan(-1)
    for (const later of ['requireValidSignature', 'RECORD_CACHE', 'writer.']) {
      const at = body.indexOf(later)
      if (at > -1) expect(fromCheck).toBeLessThan(at)
    }
  })

  it('WOULD catch an endpoint that bypasses handleManage (must-fail control)', () => {
    const forged = "if (path === '/sneaky') { response = await handleOther(request, env, path) }"
    expect(dispatchedWritePaths(forged)).toEqual([])
    expect(allDispatched(forged)).toEqual(['/sneaky'])
  })
})
