#!/usr/bin/env node
/**
 * Refuse to merge a PR whose approval is for a different commit than its head.
 *
 * Written because I did exactly that: merged #73 at `e7c5393` when the review's APPROVE was
 * on `39c49cf`, three files earlier. What I read was `gh pr view --json reviewDecision`, which
 * returns a bare `APPROVED` — a REPOSITORY-LEVEL SUMMARY THAT CARRIES NO SHA. Reading it as
 * "this commit is approved" is answering a question with evidence narrower than the question
 * (docs/agent/practices.md 「取证规程」). The sha had even been printed earlier in that same
 * session; the information was in hand and went unused, which is why this has to be mechanical
 * rather than a thing to remember.
 *
 * It cost nothing that time only because the reviewer happened to have checked the three extra
 * files before the merge landed. That is luck, and luck is not a control.
 *
 * Scope: this repo. It deliberately does NOT patch pilot's git-guard.sh — that file belongs to
 * the skill, not to this repository, and a repo should not reach into its tooling to enforce a
 * repo-local rule.
 */
import { execFileSync } from 'node:child_process'

/**
 * Decide whether a PR may be merged, given its review history.
 *
 * Pure, so the decision is testable without a network. `reviews` is oldest-first, as the
 * GitHub API returns it.
 */
export function approvalVerdict(headSha, reviews) {
  const decisive = [...reviews]
    .reverse()
    .find((r) => r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED')

  if (!decisive) return { ok: false, code: 'NO_REVIEW', message: 'no APPROVED or CHANGES_REQUESTED review' }

  if (decisive.state === 'CHANGES_REQUESTED') {
    return {
      ok: false,
      code: 'CHANGES_REQUESTED',
      message: `the most recent decisive review requests changes (${short(decisive.commit)})`,
    }
  }

  // An approval on a LATER commit than head cannot happen through the UI, but can through a
  // force-push that rewrote history under an existing approval. Treat it as a mismatch rather
  // than assuming it is fine: whatever was approved is not what is about to merge either way.
  if (decisive.commit !== headSha) {
    return {
      ok: false,
      code: 'SHA_MISMATCH',
      approved: decisive.commit,
      head: headSha,
      message: `approved ${short(decisive.commit)}, head is ${short(headSha)}`,
    }
  }
  return { ok: true, code: 'OK', message: `approved at ${short(headSha)}` }
}

const short = (s) => (typeof s === 'string' ? s.slice(0, 7) : String(s))

/**
 * Show what the reviewer has not seen — split by WHY it is new to them.
 *
 * The first version printed one `git diff --stat approved..head`, which on this very script's
 * own PR listed five files the reviewer had in fact already approved: they arrived by merging
 * the base branch in. Literally correct ("changed since the approval") and misleading in
 * practice, because a reader scans that list as "code written since you looked".
 *
 * The fix is to LABEL the two kinds, not to filter one out. Content merged in from the base
 * HAS been reviewed — in its own PR, on its own. What has never been reviewed is this branch's
 * interaction with it, and that is exactly the failure docs/agent/practices.md 「合并前协议」
 * was written for: two PRs green separately, red together, and neither review could see it.
 * Filtering the merged content away would hide the half that the merge-protocol lesson says
 * matters most.
 */
/**
 * The commits this branch itself added since the approval.
 *
 * `approved..head` alone is NOT that set: a squash-merge commit brought in from the base is
 * itself a non-merge commit and lands squarely in that range. Excluding the base (`^base`) is
 * what makes the label true — without it, #74's squash commit was listed as new work on this
 * branch, and a label that names something the command does not compute is how a reader ends
 * up re-reviewing the wrong thing.
 *
 * `exact: false` means the base ref was not resolvable (a fresh clone, a differently-named
 * remote) and the wider range was used. The caller must SAY so: over-reporting is tolerable,
 * over-reporting silently is not.
 *
 * Exported with an injectable `cwd` so the structural invariant — nothing reachable from base
 * may appear here — can be asserted against a purpose-built repository rather than against
 * whatever this one happens to look like today. Verifying it by running it on one real PR, as
 * the first version did, tests the state of that afternoon; this tests the property.
 */
export function ownCommits(approved, head, base, cwd = process.cwd()) {
  for (const args of [
    ['log', '--format=%H', '--no-merges', `${approved}..${head}`, `^${base}`],
    ['log', '--format=%H', '--no-merges', `${approved}..${head}`],
  ]) {
    try {
      const out = execFileSync('git', args, { encoding: 'utf8', cwd, stdio: ['ignore', 'pipe', 'ignore'] })
      return { shas: out.split('\n').filter(Boolean), exact: args.length === 5 }
    } catch {
      // fall through to the wider range
    }
  }
  return null
}

function describeDelta(approved, head, base) {
  const stat = (range) => {
    try {
      return execFileSync('git', ['diff', '--stat', range], { encoding: 'utf8' }).trim()
    } catch {
      return null
    }
  }
  const full = stat(`${approved}..${head}`)
  if (full === null) {
    console.error('\n  (cannot diff locally; fetch the branch to see what changed)')
    return
  }
  if (!full) {
    console.error('\n  (the shas differ but the trees match — nothing to re-read)')
    return
  }

  const commits = ownCommits(approved, head, base)
  if (commits?.exact) {
    console.error('\nNew commits on this branch since the approval:')
  } else {
    console.error('\nCommits since the approval (could not exclude the base branch, so this')
    console.error('OVER-REPORTS — merged-in commits are listed here too):')
  }
  const lines = commits?.shas.length
    ? execFileSync('git', ['log', '--oneline', '--no-walk', ...commits.shas], { encoding: 'utf8' }).trim()
    : ''
  console.error(lines ? indent(lines) : '  (none — everything below arrived via a merge)')

  console.error('\nFull file delta since the approval (may include base-branch content merged in,')
  console.error('already reviewed on its own but never reviewed IN COMBINATION with this branch):')
  console.error(indent(full))
}

const indent = (t) => t.split('\n').map((l) => `  ${l}`).join('\n')

function main() {
  const pr = process.argv[2]
  if (!pr) {
    console.error('usage: node scripts/check-approval-sha.mjs <pr-number>')
    process.exit(2)
  }
  const raw = execFileSync(
    'gh',
    ['pr', 'view', pr, '--json', 'headRefOid,reviews,state,baseRefName'],
    { encoding: 'utf8' },
  )
  const { headRefOid, reviews, state, baseRefName } = JSON.parse(raw)
  const baseRef = `origin/${baseRefName}`

  if (state === 'MERGED') {
    console.log(`#${pr} is already merged — nothing to gate.`)
    return
  }

  const v = approvalVerdict(
    headRefOid,
    (reviews ?? []).map((r) => ({ state: r.state, commit: r.commit?.oid ?? '' })),
  )

  if (v.ok) {
    console.log(`#${pr}: ${v.message}`)
    return
  }

  console.error(`REFUSING: #${pr} — ${v.message}`)
  if (v.code === 'SHA_MISMATCH') {
    describeDelta(v.approved, v.head, baseRef)
    console.error('\nAsk the reviewer to re-approve at the current head, or merge the approved commit.')
  }
  process.exit(1)
}

if (import.meta.url === `file://${process.argv[1]}`) main()
