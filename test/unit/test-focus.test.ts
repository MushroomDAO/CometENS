import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

/**
 * No committed `.only`, and no unconditional `.skip`.
 *
 * `.only` is the quietest way to make a suite lie: vitest runs that one case, reports the file
 * as passed, and the gate is green while almost nothing ran. It leaves no failure to notice —
 * you would have to compare test counts across commits to see it, and nobody does.
 *
 * `.skip` is louder (vitest prints a skip count) but still turns a guard into decoration, and
 * a skip added "for now" outlives the reason. `skipIf` is a different thing and allowed: the
 * condition is in the source, so the reader can see when it applies — test/integration uses it
 * to stand down when no live RPC is configured.
 *
 * Written while the count is zero, which is the point: this is cheap now and expensive to
 * introduce after someone has a reason to want an exemption.
 */
const REPO = join(__dirname, '..', '..')

function testSources(): string[] {
  return execFileSync('git', ['ls-files', '-z', 'test', 'src', 'server', 'sdk'], { cwd: REPO, encoding: 'utf8' })
    .split('\0')
    .filter((f) => f.endsWith('.test.ts') && !f.endsWith('test-focus.test.ts'))
}

/**
 * `.only` / `.skip` as a call on a test function, through any chain of modifiers.
 *
 * The first version required `only` to follow the test function DIRECTLY, so
 * `it.concurrent.only(...)` slipped past — and that is not a contrived spelling: reaching for
 * `it.concurrent.only` while debugging one slow async case needs no motive at all, which is
 * precisely the "reached for it without thinking" this guard exists to catch.
 *
 * Measured: injecting `it.concurrent.only` into design-system.test.ts left that file at
 * 1 passed | 35 skipped, this guard at 6 passed, and the whole gate green. The 35 that
 * vanished are the design-system assertions #48 and #54 took several rounds to build.
 */
const FOCUS = /\b(?:it|test|describe)(?:\s*\.\s*\w+)*\s*\.\s*only\b/
const SKIP = /\b(?:it|test|describe)(?:\s*\.\s*\w+)*\s*\.\s*skip\b/

describe('no committed .only or unconditional .skip', () => {
  const files = testSources()

  it('the scan sees the test files (control)', () => {
    // Without this, a path filter that matched nothing would report "no .only" forever — the
    // same vacuous-green this file exists to prevent.
    expect(files.length).toBeGreaterThan(20)
    // Named across two directories so a filter that lost a whole tree is caught, not just an
    // empty result. (My first version named a file that lives in an unmerged branch — the
    // control failed for the right reason and told me so immediately.)
    expect(files).toContain('test/e2e/upstream-api.test.ts')
    expect(files).toContain('test/unit/retracted-claims.test.ts')
  })

  it('no .only anywhere', () => {
    const hits = files.filter((f) => FOCUS.test(readFileSync(join(REPO, f), 'utf8')))
    expect(hits).toEqual([])
  })

  it('no unconditional .skip anywhere', () => {
    const hits = files.filter((f) => SKIP.test(readFileSync(join(REPO, f), 'utf8')))
    expect(hits).toEqual([])
  })

  it('skipIf is NOT flagged (control)', () => {
    // Conditional standing-down is legitimate and used by test/integration; a matcher that
    // caught it would make this guard unusable and it would be deleted.
    expect(SKIP.test('describe.skipIf(SKIP)("Integration", () => {})')).toBe(false)
    expect(FOCUS.test('describe.skipIf(SKIP)("Integration", () => {})')).toBe(false)
  })

  it('the matchers DO catch the real thing (control)', () => {
    // Proves absence above means absence, not a pattern that matches nothing.
    expect(FOCUS.test('it.only("x", () => {})')).toBe(true)
    expect(SKIP.test('describe.skip("x", () => {})')).toBe(true)
    expect(FOCUS.test('it . only ("x", () => {})')).toBe(true)
  })

  it('catches .only behind a modifier chain', () => {
    // The spelling that got past the first version. `skipIf` must still be exempt, so the
    // chain part cannot simply be "anything before .skip".
    expect(FOCUS.test('it.concurrent.only("x", () => {})')).toBe(true)
    expect(FOCUS.test('it.sequential.only("x", () => {})')).toBe(true)
    expect(SKIP.test('describe.concurrent.skip("x", () => {})')).toBe(true)
  })

  it('the widened chain does NOT start catching skipIf (control)', () => {
    // The failure mode of the fix: `(?:\.\w+)*` could swallow `skipIf` if `skip` were matched
    // without a boundary. Both spellings, plain and chained.
    expect(SKIP.test('describe.skipIf(SKIP)("Integration", () => {})')).toBe(false)
    expect(SKIP.test('it.concurrent.skipIf(x)("y", () => {})')).toBe(false)
  })

  it('does not flag a test whose NAME contains the word (control)', () => {
    // `it('only the owner may approve')` must not trip this.
    expect(FOCUS.test("it('only the owner may approve', () => {})")).toBe(false)
    expect(SKIP.test("it('skips when unconfigured', () => {})")).toBe(false)
  })
})
