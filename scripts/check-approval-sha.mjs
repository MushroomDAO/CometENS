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

function main() {
  const pr = process.argv[2]
  if (!pr) {
    console.error('usage: node scripts/check-approval-sha.mjs <pr-number>')
    process.exit(2)
  }
  const raw = execFileSync(
    'gh',
    ['pr', 'view', pr, '--json', 'headRefOid,reviews,state'],
    { encoding: 'utf8' },
  )
  const { headRefOid, reviews, state } = JSON.parse(raw)

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
    console.error('\nChanged since the approval:')
    try {
      console.error(
        execFileSync('git', ['diff', '--stat', `${v.approved}..${v.head}`], { encoding: 'utf8' }).trim() ||
          '  (nothing — the shas differ but the trees match)',
      )
    } catch {
      console.error('  (cannot diff locally; fetch the branch to see)')
    }
    console.error('\nAsk the reviewer to re-approve at the current head, or merge the approved commit.')
  }
  process.exit(1)
}

if (import.meta.url === `file://${process.argv[1]}`) main()
