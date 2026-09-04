import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

/**
 * A followup marked done must not name an artifact that isn't there.
 *
 * The ledger exists so that work judged "real but not blocking" is never dropped. That makes a
 * FALSE completion claim in it worse than a missing entry: a missing entry still looks like
 * work, while `- [x] 已完成` reads as settled and nobody opens it again.
 *
 * The failure this guards is one I hit twice in a day, and both times by hand: the WORK landed
 * in one PR while the CHECKBOX landed in another. Merge either alone and the ledger claims a
 * file exists that does not. It cost nothing only because I happened to sequence the merges
 * correctly — the same "it worked because I got lucky" that FU-9 was written to remove.
 *
 * Scope, stated plainly: this catches the cross-PR split. It does NOT catch a tick and its work
 * riding in the SAME unmerged PR, where the file is present on that branch either way. Naming
 * the limit here so the next reader does not mistake this for a general proof that completion
 * claims are true.
 *
 * Open entries (`- [ ]`) are deliberately exempt: a proposal naming the file it intends to add
 * is normal, and FU-9 did exactly that before it was built.
 *
 * WHY NOT THE OBVIOUS DESIGN. The first idea was "a `- [x]` entry must name a PR that exists
 * and is merged". The reviewer pointed out that it makes the very problem it targets WORSE:
 * finish the work and tick the box in one PR, and at CI time that PR is not merged yet, so the
 * guard fails — forcing "merge the work first, then open a second PR just to tick". That is
 * exactly the two-branch shuffle this is meant to remove, promoted from an accident into a
 * requirement. Making it work needs the guard to know its own PR number from the CI event and
 * exempt it, which couples a ledger check to the CI environment.
 *
 * Checking the ARTIFACT instead of the PR sidesteps all of it: work and tick in the same PR ->
 * the file is on that branch -> green, no shuffle. Work and tick in different PRs -> red, which
 * is the case that actually went wrong.
 *
 * I first justified this as "both catch the same failure, and this one is cheaper". THAT IS
 * FALSE, and the reviewer measured it: point a completed entry at a PR that never existed
 * (`#9999`) and this file stays fully green, as does test/unit/task-ledger.test.ts. They are
 * two different failures:
 *
 *   this guard   — the ledger says a file is there, and it is not   (happened twice in a day)
 *   a PR guard   — the ledger cites #n, and #n does not exist       (has never happened)
 *
 * So a dangling PR citation is currently caught by nothing. The decision not to build that
 * guard stands, but on the honest reason: it has zero instances, and this repo does not build
 * protection for failures it has not had. Not "already covered". (The format of a citation IS
 * guarded — task-ledger caught `PR#74` where `PR #74` was required. Its format has an owner;
 * where it points does not.)
 *
 * If it ever does happen, it needs no CI coupling either: squash-merge subjects carry `(#n)`,
 * so `git log --grep='(#n)'` answers it from the repository alone — the same read-only shape
 * as this file. Recorded so that "wait for an instance" is a choice rather than a gap.
 */
const ROOT = join(__dirname, '..', '..')
const LEDGER = join(ROOT, 'docs', 'agent', 'followups.md')

const tracked = new Set(
  execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean),
)

/** Backticked tokens that look like repo paths — a slash and an extension. */
export function pathsIn(line: string): string[] {
  return [...line.matchAll(/`([^`]+)`/g)]
    .map((m) => m[1])
    .filter((t) => t.includes('/') && /\.[a-z]{2,4}$/.test(t))
}

const lines = readFileSync(LEDGER, 'utf8').split('\n')
const done = lines.filter((l) => l.trimStart().startsWith('- [x]'))
const open = lines.filter((l) => l.trimStart().startsWith('- [ ]'))

describe('followups.md — a done entry names only artifacts that exist', () => {
  it('every path named in a completed entry is tracked in the repo', () => {
    const missing = done.flatMap((l) => pathsIn(l).filter((p) => !tracked.has(p)))
    expect(missing, 'a completed followup names files that are not in the repo').toEqual([])
  })

  // Without this the assertion above passes trivially on a ledger that names no paths at all,
  // and would keep passing as the ledger grew.
  it('there is something to check (control)', () => {
    expect(done.flatMap(pathsIn).length).toBeGreaterThan(0)
  })

  it('WOULD catch a path that does not exist (must-fail control)', () => {
    const fake = '- [x] FU-99 · **已完成**:新增 `scripts/does-not-exist.mjs`'
    expect(pathsIn(fake).filter((p) => !tracked.has(p))).toEqual(['scripts/does-not-exist.mjs'])
  })

  it('open entries are exempt — a proposal may name what it intends to add', () => {
    // FU-9 named scripts/check-approval-sha.mjs before it existed. Failing that would push the
    // next person to describe planned work vaguely, which is the opposite of what this file is for.
    const proposal = '- [ ] FU-98 · 做法:新增 `scripts/not-yet-written.mjs`'
    expect(open.concat(proposal).filter((l) => l.startsWith('- [x]'))).toEqual([])
  })
})

describe('pathsIn — what counts as a path', () => {
  it('picks up a repo path', () => {
    expect(pathsIn('see `docs/agent/tasks.md` for more')).toEqual(['docs/agent/tasks.md'])
  })

  it('ignores a bare command or identifier', () => {
    // `pnpm check:skipped` and `PR_OPEN` are backticked all over this repo and are not files.
    expect(pathsIn('run `pnpm check:skipped` when `PR_OPEN`')).toEqual([])
  })

  it('ignores prose that merely contains a slash', () => {
    expect(pathsIn('the `signature/proof` split')).toEqual([])
  })
})
