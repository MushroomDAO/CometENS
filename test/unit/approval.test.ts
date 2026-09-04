import { describe, it, expect } from 'vitest'
import {
  resolveMode,
  buildApplication,
  decideOnSubmit,
  checkResubmission,
  applyDecision,
  applicationId,
  applicationKey,
  publicView,
  isAuthorisedApprover,
  ApprovalError,
  type Application,
} from '../../server/gateway/approval'

const PARENTS = ['community.eth', 'forest.community.eth']
const OWNER = `0x${'11'.repeat(20)}`
const NOW = 1_760_000_000

const valid = () => buildApplication({ label: 'alice', parent: 'community.eth', owner: OWNER }, PARENTS, NOW)

describe('resolveMode', () => {
  it('defaults to auto when unset or empty', () => {
    // The title says only what is asserted. An earlier version was titled "…so an existing
    // deployment behaves identically after upgrading", which claimed a behavioural property
    // this assertion does not check — and it was FALSE at the time, because /apply skipped
    // authentication entirely in auto mode. Endpoint behaviour is asserted in
    // test/unit/apply-auth.test.ts, where the auth actually lives.
    expect(resolveMode(undefined)).toBe('auto')
    expect(resolveMode('')).toBe('auto')
  })

  it('accepts both documented values', () => {
    expect(resolveMode('auto')).toBe('auto')
    expect(resolveMode('manual')).toBe('manual')
  })

  it('REFUSES an unrecognised value instead of falling back to auto', () => {
    // A typo like "manaul" falling back to auto would quietly hand out every name the
    // operator meant to review, and nothing would look wrong.
    expect(() => resolveMode('manaul')).toThrow(ApprovalError)
    expect(() => resolveMode('MANUAL')).toThrow()
    try {
      resolveMode('manaul')
    } catch (e) {
      expect((e as ApprovalError).status).toBe(503)
      expect((e as ApprovalError).hint).toContain('refusing to guess')
    }
  })
})

describe('buildApplication — validation', () => {
  it('builds a pending application for valid input', () => {
    const a = valid()
    expect(a).toMatchObject({ label: 'alice', parent: 'community.eth', owner: OWNER, status: 'pending', name: 'alice.community.eth' })
    expect(a.decidedAt).toBeUndefined()
  })

  it('normalises case', () => {
    const a = buildApplication({ label: 'ALICE', parent: 'Community.ETH', owner: OWNER }, PARENTS, NOW)
    expect(a.name).toBe('alice.community.eth')
  })

  it.each([
    ['empty label', { label: '', parent: 'community.eth', owner: OWNER }],
    ['label with underscore', { label: 'a_b', parent: 'community.eth', owner: OWNER }],
    ['label too long', { label: 'a'.repeat(64), parent: 'community.eth', owner: OWNER }],
    ['parent not .eth', { label: 'alice', parent: 'community.com', owner: OWNER }],
    ['bad owner', { label: 'alice', parent: 'community.eth', owner: '0xshort' }],
  ])('rejects %s', (_label, input) => {
    expect(() => buildApplication(input as any, PARENTS, NOW)).toThrow(ApprovalError)
  })

  it('rejects a parent this deployment does not serve, and says which it does', () => {
    try {
      buildApplication({ label: 'alice', parent: 'other.eth', owner: OWNER }, PARENTS, NOW)
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as ApprovalError).message).toContain('other.eth')
      expect((e as ApprovalError).hint).toContain('community.eth')
    }
  })

  it('every rejection carries an actionable hint', () => {
    // An error the applicant cannot act on is the same as no error message.
    try {
      buildApplication({ label: 'a_b', parent: 'community.eth', owner: OWNER }, PARENTS, NOW)
    } catch (e) {
      expect((e as ApprovalError).hint?.length ?? 0).toBeGreaterThan(0)
    }
  })
})

describe('decideOnSubmit — the two modes actually differ', () => {
  it('auto grants immediately', () => {
    expect(decideOnSubmit('auto')).toBe('grant')
  })
  it('manual queues', () => {
    expect(decideOnSubmit('manual')).toBe('queue')
  })
  it('the two modes do not produce the same action (control)', () => {
    // Without this, a bug making both return 'grant' would leave every test above passing
    // while manual mode silently handed out names.
    expect(decideOnSubmit('auto')).not.toBe(decideOnSubmit('manual'))
  })
})

describe('checkResubmission', () => {
  it('allows a first application', () => {
    expect(checkResubmission(null).ok).toBe(true)
  })

  it('refuses while one is pending, and says to wait', () => {
    const r = checkResubmission(valid())
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.status).toBe(409)
      expect(r.error.hint).toContain('wait')
    }
  })

  it('refuses when already granted, and says who owns it', () => {
    const approved: Application = { ...valid(), status: 'approved' }
    const r = checkResubmission(approved)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.hint).toContain(OWNER)
  })

  it('does NOT silently reopen a rejected application', () => {
    // Reopening would undo an admin's decision without anyone noticing.
    const rejected: Application = { ...valid(), status: 'rejected', reason: 'reserved name' }
    const r = checkResubmission(rejected)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.hint).toContain('reserved name')
  })
})

describe('applyDecision — state machine', () => {
  it('approves a pending application and records who and when', () => {
    const out = applyDecision(valid(), 'approve', '0xadmin', NOW + 60)
    expect(out.status).toBe('approved')
    expect(out.decidedBy).toBe('0xadmin')
    expect(out.decidedAt).toBe(NOW + 60)
  })

  it('rejects with a reason', () => {
    const out = applyDecision(valid(), 'reject', '0xadmin', NOW + 60, 'reserved')
    expect(out.status).toBe('rejected')
    expect(out.reason).toBe('reserved')
  })

  it('refuses to re-decide an approved application', () => {
    // Flipping approved → rejected would leave the name minted while the record disagrees,
    // and the two would never reconcile.
    const approved = applyDecision(valid(), 'approve', '0xadmin', NOW)
    expect(() => applyDecision(approved, 'reject', '0xadmin2', NOW + 1)).toThrow(ApprovalError)
  })

  it('refuses to re-decide a rejected application', () => {
    const rejected = applyDecision(valid(), 'reject', '0xadmin', NOW)
    expect(() => applyDecision(rejected, 'approve', '0xadmin2', NOW + 1)).toThrow(ApprovalError)
  })

  it('does not mutate the input record', () => {
    const a = valid()
    applyDecision(a, 'approve', '0xadmin', NOW)
    expect(a.status).toBe('pending')
  })
})

describe('keys and public view', () => {
  it('ids are deterministic, so a resubmission is recognisable', () => {
    expect(applicationId('Community.eth', 'ALICE')).toBe(applicationId('community.eth', 'alice'))
  })

  it('namespaces KV keys away from the address→names registry', () => {
    expect(applicationKey('alice.community.eth')).toBe('app:alice.community.eth')
  })

  it('the public view omits internal fields', () => {
    const decided = applyDecision(valid(), 'approve', '0xSECRETADMIN', NOW)
    const view = publicView(decided)
    // decidedBy identifies an operator account and is not the applicant's business.
    expect(JSON.stringify(view)).not.toContain('0xSECRETADMIN')
    expect(view).toMatchObject({ name: 'alice.community.eth', status: 'approved' })
  })

  it('the view control: it does include what an applicant needs', () => {
    // Without this, a publicView that returned {} would pass the assertion above.
    const view = publicView(valid())
    expect(view.name).toBe('alice.community.eth')
    expect(view.status).toBe('pending')
    expect(view.owner).toBe(OWNER)
  })
})

describe('isAuthorisedApprover — only the contract owner decides', () => {
  const OWNER_ADDR = `0x${'ab'.repeat(20)}`
  const OTHER = `0x${'cd'.repeat(20)}`

  it('accepts the contract owner regardless of case', () => {
    expect(isAuthorisedApprover(OWNER_ADDR.toUpperCase().replace('0X', '0x'), OWNER_ADDR)).toBe(true)
  })

  it('rejects anyone else', () => {
    expect(isAuthorisedApprover(OTHER, OWNER_ADDR)).toBe(false)
  })

  it('rejects when either side is missing — fail closed', () => {
    // An unreadable owner must not mean "allow"; that is how a chain hiccup becomes an
    // authorisation bypass.
    expect(isAuthorisedApprover(OWNER_ADDR, undefined)).toBe(false)
    expect(isAuthorisedApprover(undefined, OWNER_ADDR)).toBe(false)
    expect(isAuthorisedApprover(OWNER_ADDR, '')).toBe(false)
  })

  it('rejects malformed addresses rather than string-comparing them', () => {
    expect(isAuthorisedApprover('0xshort', '0xshort')).toBe(false)
  })
})
