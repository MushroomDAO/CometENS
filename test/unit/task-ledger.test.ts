import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
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
 * ⚠️ WAS VACUOUS WHEN WRITTEN — there were zero `PR_OPEN` entries, so per practices.md
 * 「判据的第一份工作是约束现在」the must-fail control below WAS the run: it proved the matcher
 * discriminates even with nothing to discriminate.
 *
 * It is not vacuous any more. T1.7.2 (#74) is the first real entry it examines, and the first
 * thing it did was reject `PR_OPEN` (PR#74) — the number outside the backticks and with no
 * space. Written by the same person who wrote this guard, one commit after writing it. The
 * controls stay regardless: the day the last PR_OPEN entry clears, this goes back to being
 * carried entirely by them.
 */
const TASKS = join(__dirname, '..', '..', 'docs', 'agent', 'tasks.md')
const ROOT = join(__dirname, '..', '..')

/**
 * Squash-merged PR numbers, read from commit subjects: `feat(x): … (#74)`.
 *
 * No network, no CI coupling — the repository already knows which PRs landed. The shape came
 * from the reviewer, who proposed it for a DIFFERENT failure (a completed followup citing a PR
 * that never existed) which has never actually occurred, so it was not built. This one has
 * occurred, which is the difference that decides it.
 */
function mergedPrNumbers(): Set<string> {
  // No `-n` bound, deliberately. An earlier version read only the last 400 subjects, which is
  // the SILENT half of the failure this file just fixed the loud half of:
  //
  //   shallow clone -> the set is EMPTY   -> the "populated" control sees it
  //   an -n bound   -> the set is PARTIAL -> nothing sees it
  //
  // Constructed rather than argued: with `-n 30` the set holds 28 entries — comfortably past
  // the >5 control — while omitting #35, so a task left at `PR_OPEN (PR #35)` passes fully
  // green. With no bound it fails, naming the entry. (Third time in this repo that "derived
  // nothing" is loud and "derived some of it" is silent; see #51.)
  //
  // The bound bought nothing: `--format=%s` over 232 subjects and over 10000 costs the same at
  // this scale. It only sold a silent failure that would arrive with commit 401.
  const log = execFileSync('git', ['log', '--format=%s'], { cwd: ROOT, encoding: 'utf8' })
  return new Set([...log.matchAll(/\(#(\d+)\)/g)].map((m) => m[1]))
}

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

/**
 * A `PR_OPEN` task whose PR has already merged.
 *
 * The guard above checks the FORMAT of the citation. Nothing checked where it POINTS — and the
 * two come apart: T1.7.2 sat at `PR_OPEN (PR #74)` for thirty-five minutes after #74 merged,
 * correctly formatted the whole time. Merging is exactly the "release event" the protocol above
 * says must bring someone back to this file, and nothing did.
 *
 * Found by hand while re-checking whether the BLOCKED tasks' blockers still held — that is,
 * by an audit that happens only when someone thinks to run it. Which is the argument for
 * this test.
 */
describe('no PR_OPEN task points at an already-merged PR', () => {
  const merged = mergedPrNumbers()

  it('every PR_OPEN citation names a PR that has NOT landed', () => {
    const stale = prOpenEntries(readFileSync(TASKS, 'utf8'))
      .map((e) => ({ line: e.line, pr: e.line.match(/PR #(\d+)/)?.[1] }))
      .filter((e) => e.pr && merged.has(e.pr))
      .map((e) => e.line)
    expect(stale, 'a task is still PR_OPEN but its PR is merged — mark it DONE').toEqual([])
  })

  // Without this the assertion above passes on an empty log, a broken regex, or a set that is
  // simply never populated — and would keep passing forever.
  //
  // NOT hypothetical: this fired on the first CI run of the PR that added it. GitHub's default
  // checkout is shallow (one commit), so the set was empty, and the main assertion above went
  // GREEN because "no stale entry" is vacuously true when nothing is known to be merged. The
  // fix is `fetch-depth: 0` in .github/workflows/test.yml; the message below names it, because
  // a bare "expected 0 to be greater than 5" sends the reader to the wrong file.
  it('the merged-PR set is actually populated (control)', () => {
    const shallow =
      execFileSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: ROOT, encoding: 'utf8' }).trim() ===
      'true'
    expect(
      merged.size,
      shallow
        ? 'shallow clone — commit subjects are not visible, so this guard is inert. Set fetch-depth: 0 on actions/checkout.'
        : 'no `(#n)` found in the last 400 commit subjects — the squash-merge convention changed, or the regex broke.',
    ).toBeGreaterThan(5)
  })

  it('an OPEN pr number is absent from the set (control)', () => {
    // Proves the set discriminates rather than containing everything. #9999 has never existed.
    expect(merged.has('9999')).toBe(false)
  })

  it('WOULD catch a stale entry (must-fail control)', () => {
    const pr = [...merged][0]
    const fake = `### T9.9.9 something  \`PR_OPEN (PR #${pr})\``
    expect(/PR #(\d+)/.exec(fake)?.[1]).toBe(pr)
    expect(merged.has(pr)).toBe(true)
  })
})

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
