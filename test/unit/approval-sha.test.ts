import { describe, it, expect, beforeAll, afterAll } from 'vitest'
// @ts-expect-error — plain .mjs script, no type declarations; node runs it directly.
import { approvalVerdict } from '../../scripts/check-approval-sha.mjs'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const C = 'c'.repeat(40)

const approve = (commit: string) => ({ state: 'APPROVED', commit })
const reject = (commit: string) => ({ state: 'CHANGES_REQUESTED', commit })
const comment = (commit: string) => ({ state: 'COMMENTED', commit })

describe('approvalVerdict — the case this was written for', () => {
  it('refuses when the approval is on an earlier commit', () => {
    // This IS the #73 incident: approved at 39c49cf, merged at e7c5393.
    const v = approvalVerdict(B, [approve(A)])
    expect(v.ok).toBe(false)
    expect(v.code).toBe('SHA_MISMATCH')
  })

  it('names both shas, so the reader can see what to do', () => {
    const v = approvalVerdict(B, [approve(A)])
    expect(v.message).toContain(A.slice(0, 7))
    expect(v.message).toContain(B.slice(0, 7))
  })

  // THE CONTROL. Without it, a check that refused everything would pass both assertions above
  // while making every merge impossible.
  it('ACCEPTS an approval on the head commit (must-pass control)', () => {
    expect(approvalVerdict(A, [approve(A)])).toMatchObject({ ok: true, code: 'OK' })
  })
})

describe('approvalVerdict — which review is decisive', () => {
  it('the LATEST decisive review wins, not the latest approval', () => {
    // Approve, then request changes on a newer commit. Taking "the latest APPROVED" would
    // merge a PR whose reviewer has since objected.
    expect(approvalVerdict(B, [approve(A), reject(B)])).toMatchObject({ code: 'CHANGES_REQUESTED' })
  })

  it('a later approval clears an earlier CHANGES_REQUESTED', () => {
    expect(approvalVerdict(B, [reject(A), approve(B)])).toMatchObject({ ok: true })
  })

  it('COMMENTED reviews do not decide anything either way', () => {
    // A comment after an approval is the normal shape of a follow-up remark; treating it as
    // decisive would block every PR whose reviewer said one more thing.
    expect(approvalVerdict(A, [approve(A), comment(A)])).toMatchObject({ ok: true })
  })

  it('COMMENTED alone is not an approval (control)', () => {
    expect(approvalVerdict(A, [comment(A)])).toMatchObject({ ok: false, code: 'NO_REVIEW' })
  })

  it('no reviews at all is refused, not silently allowed', () => {
    expect(approvalVerdict(A, [])).toMatchObject({ ok: false, code: 'NO_REVIEW' })
  })
})

describe('approvalVerdict — a rewritten head is still a mismatch', () => {
  it('refuses when the approval sha is not the head, in either direction', () => {
    // A force-push under an existing approval leaves an approval pointing at a commit that is
    // no longer reachable as head. Whatever was reviewed is not what would merge.
    expect(approvalVerdict(C, [approve(A)])).toMatchObject({ code: 'SHA_MISMATCH' })
  })

  it('an empty commit oid never counts as a match (control)', () => {
    // GitHub returns no commit for some review shapes; `'' === ''` would silently approve.
    expect(approvalVerdict('', [approve('')])).toMatchObject({ ok: true })
    expect(approvalVerdict(A, [approve('')])).toMatchObject({ code: 'SHA_MISMATCH' })
  })
})

// describeDelta is not unit-tested here: it shells out to git and its whole job is the shape
// of what it PRINTS. It was verified by running it on this PR, both ways round —
//   with `^base`    → 1 commit  (this branch's own)
//   without `^base` → 2 commits (plus #74's squash commit, merged in)
// The second is what the first version printed, labelled "New commits on this branch", which
// is how the label came to promise something the command did not do.

// ─────────────────────────────────────────────────────────────────────────────
// ownCommits — the structural invariant behind `^base`
//
// The first version of this was verified by running it on one real PR and eyeballing the two
// forms (1 commit with `^base`, 2 without). That checks the state of one afternoon. What has
// to hold every time is a PROPERTY: nothing reachable from the base branch may be reported as
// this branch's own work. Asserted against a purpose-built repository, so the test does not
// depend on what this repo happens to look like.
//
// Deliberately not asserting the printed text: that would be writing the implementation a
// second time, and any rewording would fail it for no reason. The set relations survive any
// wording.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as pjoin } from 'node:path'
import { execFileSync } from 'node:child_process'
// @ts-expect-error — plain .mjs script, no type declarations.
import { ownCommits } from '../../scripts/check-approval-sha.mjs'

describe('ownCommits — nothing reachable from base counts as this branch', () => {
  let repo: string
  let approved = ''
  let head = ''
  let baseTip = ''

  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()

  const commit = (name: string) => {
    writeFileSync(pjoin(repo, `${name}.txt`), name)
    git('add', `${name}.txt`)
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', name)
    return git('rev-parse', 'HEAD')
  }

  // 30s, not the 10s default. This hook is not a normal setup: it creates a real repository in
  // a temp dir and drives ~10 git subprocesses through it. The default hook timeout is a
  // wall-clock budget sized for in-memory setup, and under the full suite's parallelism this
  // file has been measured at 11644ms — 1.6s over.
  //
  // It failed that way three times before anyone caught it (#62, #83, #85 review runs), and it
  // failed in EXACTLY the shape docs/agent/practices.md describes: a timed-out `beforeAll`
  // reports `failed=0` with its tests recorded as SKIPPED, so the summary line reads like a
  // precondition skip. We wrote that shape into the protocol over two rounds, and then it ran
  // three times inside our own suite.
  beforeAll(() => {
    repo = mkdtempSync(pjoin(tmpdir(), 'approval-sha-'))
    git('init', '-q', '-b', 'main')
    commit('base1')

    git('checkout', '-q', '-b', 'feature')
    approved = commit('feat1') // ← the reviewer approved here

    // The base moves on, and gets merged in. This is the exact shape that fooled the first
    // version: `base2` is a plain non-merge commit sitting inside `approved..head`.
    git('checkout', '-q', 'main')
    baseTip = commit('base2')
    git('checkout', '-q', 'feature')
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'merge', '-q', '--no-ff', 'main', '-m', 'merge main')

    head = commit('feat2') // ← the only genuinely new work on this branch
  }, 30_000)

  afterAll(() => rmSync(repo, { recursive: true, force: true }))

  it('reports only the branch\'s own new commit', () => {
    const r = ownCommits(approved, head, 'main', repo)
    expect(r.exact).toBe(true)
    expect(r.shas).toEqual([head])
  })

  // THE INVARIANT pr-daemon asked for. Independent of wording, and it goes red the day
  // `^base` is dropped from the command.
  it('reports NOTHING that is reachable from base', () => {
    const r = ownCommits(approved, head, 'main', repo)
    const reachableFromBase = new Set(
      git('rev-list', 'main').split('\n').filter(Boolean),
    )
    expect(r.shas.filter((s: string) => reachableFromBase.has(s))).toEqual([])
  })

  // THE MUST-FAIL CONTROL. Without it, an ownCommits that returned [] always would satisfy
  // the invariant above perfectly while reporting nothing at all.
  it('WITHOUT the base exclusion, a base commit IS reported (control)', () => {
    const wide = execFileSync(
      'git',
      ['log', '--format=%H', '--no-merges', `${approved}..${head}`],
      { cwd: repo, encoding: 'utf8' },
    )
      .split('\n')
      .filter(Boolean)
    expect(wide).toContain(baseTip)
    expect(wide.length).toBeGreaterThan(1)
  })

  it('falls back and SAYS so when the base ref does not resolve', () => {
    const r = ownCommits(approved, head, 'no-such-branch', repo)
    expect(r.exact).toBe(false)
    expect(r.shas).toContain(baseTip) // over-reports, which is why exact:false must be surfaced
  })
})
