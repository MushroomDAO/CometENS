import { describe, it, expect } from 'vitest'
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
