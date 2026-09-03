import { describe, it, expect } from 'vitest'
// @ts-expect-error — plain .mjs module, no type declarations
import {
  requiredEndpoints, classify, redact, readFrontendSources,
  countApiMentions, countPathHits, unreadableCallSites,
  DEFINITION_MODULE,
} from '../../scripts/check-deploy-order.mjs'

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

  it('a LONE 404 is unknown — a write endpoint 404s on GET exactly like a missing route', () => {
    // Measured on the live worker: GET /register, /set-addr, /transfer-subnode all return 404,
    // and so does GET /__nope__. A single 404 therefore carries zero information about
    // existence, which is the whole reason for probing two verbs.
    expect(classify(404, null)).toBe('unknown')
    expect(classify(null, 404)).toBe('unknown')
  })

  it('but a lone NON-404 is still present (control)', () => {
    // Without this, "any half-failure is unknown" would pass the assertion above while
    // throwing away readings that genuinely prove the route exists.
    expect(classify(null, 200)).toBe('present')
    expect(classify(401, null)).toBe('present')
  })

  it('and two 404s are still missing (control)', () => {
    // The other side: a rule cautious enough to call everything unknown would satisfy the
    // first assertion and never report a missing endpoint again.
    expect(classify(404, 404)).toBe('missing')
  })

  it('a transient failure can no longer greenlight a deploy', () => {
    // The asymmetry this closes: the sentinel probe failed safe on a blip while a real
    // endpoint failed OPEN, so the same fault either blocked the run or passed it depending on
    // which request it hit. Now neither direction is silent.
    expect(classify(404, null)).not.toBe('present')
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

describe('two independent counts of the same call sites', () => {
  // pr-daemon's general answer to a failure that has now appeared three times: do not only
  // guard a lower bound — guard that two numbers computed DIFFERENT WAYS agree. The second
  // must not be derived from the first, or it is an identity and green forever.
  const sources = readFrontendSources()

  it('counts occurrences, not unique paths (the two are not the same measurement)', () => {
    const src = ['`${config.apiUrl}/a`; `${config.apiUrl}/a`; `${config.apiUrl}/b`']
    expect(countPathHits(src)).toBe(3)
    expect(requiredEndpoints(src)).toHaveLength(2) // deduplicated
    expect(countApiMentions(src)).toBe(3)
  })

  it('a STRING-CONCATENATED call is seen by both instruments', () => {
    // pr-daemon's counter-example, and the input that showed the two counts were not actually
    // independent: `config.apiUrl + '/zz'` contains no `apiUrl}` at all, so with the narrow
    // anchor it was invisible to all four functions AT ONCE — it did not even register as a
    // call site that could not be read.
    //
    // The test for independence is not "are the algorithms different" but "is there an input
    // on which they disagree". This is that input.
    const src = ["fetch(config.apiUrl + '/zz-new-endpoint')"]
    expect(countPathHits(src)).toBe(0)
    expect(countApiMentions(src)).toBe(1)
    expect(unreadableCallSites(src)).toHaveLength(1)
    expect(unreadableCallSites(src)[0]).toContain('zz-new-endpoint')
  })

  it('the definition module is excluded, or every comparison carries a constant offset', () => {
    // config.ts declares and assigns `apiUrl`; those two mentions are the definition, not
    // calls. Counting them put +2 into the gap and broke the identity below.
    expect(DEFINITION_MODULE).toBe('config.ts')
    const withDefinition = ['  apiUrl: string', "  apiUrl: (env.VITE_API_URL || 'https://x')"]
    expect(countApiMentions(withDefinition)).toBe(2)
    expect(countPathHits(withDefinition)).toBe(0)
  })

  it('a call the path pattern cannot read still gets counted as a mention', () => {
    // THE POINT. This is the input on which the two instruments disagree, and it is the only
    // kind of input that can reveal an under-reporting path pattern.
    const src = ['fetch(`${config.apiUrl}${path}`)']
    expect(countPathHits(src)).toBe(0)
    expect(countApiMentions(src)).toBe(1)
    expect(unreadableCallSites(src)).toHaveLength(1)
  })

  it('a readable call is NOT reported as unreadable (control)', () => {
    // Without this, "everything is unreadable" would satisfy the assertion above.
    expect(unreadableCallSites(['fetch(`${config.apiUrl}/lookup`)'])).toEqual([])
  })

  it('the real frontend has exactly ONE unreadable call site today', () => {
    // Pinned rather than tolerated: the existing one is legitimate (`${config.apiUrl}${path}`
    // with a parameter, statically unresolvable), but a NEW spelling the pattern cannot read
    // changes this number and lands here instead of quietly shrinking the checked list.
    const gaps = unreadableCallSites(sources)
    expect(gaps).toHaveLength(1)
    expect(gaps[0]).toContain('${path}')
  })

  it('the gap accounts for the whole difference between the two counts (control)', () => {
    // Ties the pinned number to the arithmetic: if the gap list and the count difference ever
    // disagree, one of the three functions is measuring something else.
    expect(countApiMentions(sources) - countPathHits(sources)).toBe(unreadableCallSites(sources).length)
  })
})
