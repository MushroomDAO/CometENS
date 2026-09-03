import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A task marked `PR_OPEN` must carry its PR number.
 *
 * Not cosmetic: without the number, "which of these are actually merged" cannot be asked
 * mechanically, and the ledger drifts. It has drifted twice — five entries sat at `PR_OPEN`
 * while all five PRs were merged (#35 #38 #41 #42 #45), and the same thing had been cleaned up
 * once before in #41 without the cause being touched.
 *
 * The cause is where the two transitions happen: `→ DONE` lands AFTER a merge, when the branch
 * is gone and nobody has reason to open this file; `→ PR_OPEN` lands while the branch is in
 * hand and the PR number is on screen. So the number gets written at the cheap moment.
 *
 * ⚠️ THIS GUARD IS VACUOUS TODAY — there are zero `PR_OPEN` entries. Per practices.md
 * 「判据的第一份工作是约束现在」a criterion that cannot be run on the present is not yet a
 * criterion, so the must-fail control below IS the run: it proves the matcher discriminates.
 */
const TASKS = join(__dirname, '..', '..', 'docs', 'agent', 'tasks.md')

/** Task headings whose status is PR_OPEN, with whatever follows the status. */
export function prOpenEntries(source: string): Array<{ line: string; hasNumber: boolean }> {
  const out: Array<{ line: string; hasNumber: boolean }> = []
  for (const line of source.split('\n')) {
    if (!/^### T[B0-9.]+\s/.test(line)) continue
    if (!/`PR_OPEN/.test(line)) continue
    out.push({ line: line.trim(), hasNumber: /`PR_OPEN \(PR #\d+\)`/.test(line) })
  }
  return out
}

describe('every PR_OPEN task carries its PR number', () => {
  const source = readFileSync(TASKS, 'utf8')

  it('the scan reads real task headings (control)', () => {
    // Without this, a heading pattern that matched nothing would make the assertion below
    // vacuous for a second reason — on top of there being no PR_OPEN entries today.
    const headings = source.split('\n').filter((l) => /^### T[B0-9.]+\s/.test(l))
    expect(headings.length).toBeGreaterThan(15)
  })

  it('no PR_OPEN entry is missing its number', () => {
    expect(prOpenEntries(source).filter((e) => !e.hasNumber).map((e) => e.line)).toEqual([])
  })

  it('a numberless PR_OPEN WOULD be caught (must-fail control)', () => {
    // The real run of this criterion, because the corpus has no PR_OPEN entries today. Both
    // spellings that actually appeared in the drift are checked.
    const bad = '### T9.9.9 something  `PR_OPEN`'
    expect(prOpenEntries(bad)).toEqual([{ line: bad, hasNumber: false }])
  })

  it('a numbered PR_OPEN passes (control)', () => {
    // Without this, a matcher that called everything numberless would satisfy the row above.
    const good = '### T9.9.9 something  `PR_OPEN (PR #123)`'
    expect(prOpenEntries(good)).toEqual([{ line: good, hasNumber: true }])
  })

  it('DONE entries are not examined (control)', () => {
    // The convention only constrains PR_OPEN; `DONE (PR #n)` is encouraged but a bare `DONE`
    // from before the convention must not fail the build.
    expect(prOpenEntries('### T1.0.1 x  `DONE`')).toEqual([])
    expect(prOpenEntries('### T1.0.1 x  `DONE (PR #22)`')).toEqual([])
  })
})
