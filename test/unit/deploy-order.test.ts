import { describe, it, expect } from 'vitest'
// @ts-expect-error — plain .mjs module, no type declarations
import { requiredEndpoints, classify, redact, readFrontendSources } from '../../scripts/check-deploy-order.mjs'

/**
 * FU-7: the frontend and the API worker deploy independently, so the frontend can ship first
 * and call endpoints that do not exist yet. That is not hypothetical — as of 2026-09-04 the
 * live worker 404s `/apply`, `/approval-mode`, `/applications` and `/approve`, all four of
 * which the shipped frontend calls.
 */
describe('requiredEndpoints — derived, not hand-written', () => {
  it('finds the calls in a source file', () => {
    const src = 'fetch(`${config.apiUrl}/approve`); fetch(`${config.apiUrl}/lookup?x=1`)'
    expect(requiredEndpoints([src])).toEqual(['/approve', '/lookup'])
  })

  it('deduplicates across files and sorts', () => {
    expect(requiredEndpoints(['`${config.apiUrl}/b`', '`${config.apiUrl}/a`', '`${config.apiUrl}/b`']))
      .toEqual(['/a', '/b'])
  })

  it('ignores URLs that are not on the API base (control)', () => {
    // Without this, any absolute URL in the frontend would become a "required endpoint" and
    // the check would fail on things the API worker was never supposed to serve.
    expect(requiredEndpoints(['fetch("https://etherscan.io/tx/0x1")'])).toEqual([])
  })

  it('the real frontend yields a non-trivial list (control)', () => {
    // A regex that silently matched nothing would make the whole check pass vacuously —
    // exactly the failure the script itself refuses to exit 0 on.
    const found = requiredEndpoints(readFrontendSources())
    expect(found.length).toBeGreaterThan(8)
    expect(found).toContain('/apply')
    expect(found).toContain('/register')
  })
})

describe('classify — present, missing, unknown are three different facts', () => {
  it('404 on both verbs means the route is absent', () => {
    expect(classify(404, 404)).toBe('missing')
  })

  it('a 400 or 401 means the route EXISTS and rejected the probe', () => {
    // /register answers 400 to an empty body and /check-label 400 to a missing param — both
    // are present. Treating "not 200" as "missing" would report every write endpoint absent.
    expect(classify(404, 400)).toBe('present')
    expect(classify(400, 404)).toBe('present')
    expect(classify(404, 401)).toBe('present')
    expect(classify(200, 404)).toBe('present')
  })

  it('a transport failure is unknown, NOT present and NOT missing', () => {
    // Present would greenlight a deploy against a worker nobody could reach; missing would
    // block a deploy over a flaky network. Neither is honest.
    expect(classify(null, null)).toBe('unknown')
  })

  it('the three outcomes are distinct (control)', () => {
    expect(new Set([classify(404, 404), classify(404, 400), classify(null, null)]).size).toBe(3)
  })

  it('one verb reachable and one not is still a judgement, not unknown', () => {
    // Half-failure resolves toward the evidence we do have rather than collapsing to unknown.
    expect(classify(null, 404)).toBe('present')
  })
})

describe('redact', () => {
  it('keeps scheme and host only', () => {
    expect(redact('https://api.example.test/secret/path?key=abc')).toBe('https://api.example.test')
  })

  it('never echoes a query string (control)', () => {
    expect(redact('https://x.test/?apikey=SENTINEL')).not.toContain('SENTINEL')
    expect('https://x.test/?apikey=SENTINEL').toContain('SENTINEL')
  })

  it('says so rather than throwing on junk', () => {
    expect(redact('not a url')).toMatch(/unparseable/)
  })
})
