import { describe, it, expect } from 'vitest'
import {
  pendingFirst,
  decided,
  describeApplication,
  statusLabel,
  buildApproveMessage,
  serialiseApproveMessage,
  type QueuedApplication,
} from '../../src/admin-queue'

const app = (over: Partial<QueuedApplication> = {}): QueuedApplication => ({
  id: 'alice.community.eth',
  name: 'alice.community.eth',
  owner: `0x${'11'.repeat(20)}`,
  status: 'pending',
  createdAt: 1_000,
  ...over,
})

describe('pendingFirst — the working queue', () => {
  it('keeps only pending applications', () => {
    const out = pendingFirst([app(), app({ id: 'b', status: 'approved' }), app({ id: 'c', status: 'rejected' })])
    expect(out.map((a) => a.id)).toEqual(['alice.community.eth'])
  })

  it('orders oldest first', () => {
    // Newest-first would let an application languish simply because newer ones keep arriving.
    const out = pendingFirst([app({ id: 'new', createdAt: 300 }), app({ id: 'old', createdAt: 100 })])
    expect(out.map((a) => a.id)).toEqual(['old', 'new'])
  })

  it('returns an empty array rather than undefined when nothing is pending', () => {
    expect(pendingFirst([app({ status: 'approved' })])).toEqual([])
  })
})

describe('decided — the history', () => {
  it('excludes pending', () => {
    expect(decided([app()]).length).toBe(0)
  })

  it('orders newest first', () => {
    const out = decided([
      app({ id: 'older', status: 'approved', decidedAt: 100 }),
      app({ id: 'newer', status: 'rejected', decidedAt: 300 }),
    ])
    expect(out.map((a) => a.id)).toEqual(['newer', 'older'])
  })

  it('falls back to createdAt when decidedAt is missing', () => {
    // Sorting on undefined would silently put such rows at an arbitrary position.
    const out = decided([
      app({ id: 'a', status: 'approved', createdAt: 100 }),
      app({ id: 'b', status: 'approved', createdAt: 300 }),
    ])
    expect(out.map((a) => a.id)).toEqual(['b', 'a'])
  })

  it('pending and decided together cover every application (control)', () => {
    // Without this, a filter bug that dropped rows from BOTH lists would leave every
    // assertion above passing while applications vanished from the UI.
    const all = [app({ id: 'p' }), app({ id: 'a', status: 'approved' }), app({ id: 'r', status: 'rejected' })]
    expect(pendingFirst(all).length + decided(all).length).toBe(all.length)
  })
})

describe('statusLabel — an approval without a tx is not a completed grant', () => {
  it('marks a granted application', () => {
    expect(statusLabel(app({ status: 'approved', txHash: '0xabc' }))).toContain('已批准并发放')
  })

  it('flags an approval with no transaction hash', () => {
    // The API can return ok with no txHash when the writer key is unset. Showing that as a
    // plain "approved" would tell the operator a name exists on-chain when it does not.
    expect(statusLabel(app({ status: 'approved' }))).toContain('未见交易哈希')
  })

  it('the two are distinguishable (control)', () => {
    expect(statusLabel(app({ status: 'approved', txHash: '0xabc' }))).not.toBe(
      statusLabel(app({ status: 'approved' })),
    )
  })

  it('labels pending and rejected', () => {
    expect(statusLabel(app())).toBe('待审批')
    expect(statusLabel(app({ status: 'rejected' }))).toBe('已拒绝')
  })
})

describe('describeApplication', () => {
  it('always shows name and recipient, both copyable', () => {
    const rows = describeApplication(app())
    expect(rows[0]).toMatchObject({ value: 'alice.community.eth', copy: true })
    expect(rows[1]).toMatchObject({ copy: true })
  })

  it('includes the rejection reason when there is one', () => {
    const rows = describeApplication(app({ status: 'rejected', reason: '保留名' }))
    expect(rows.some((r) => r.value === '保留名')).toBe(true)
  })

  it('omits the tx row when there is no transaction', () => {
    expect(describeApplication(app()).some((r) => r.label === '交易')).toBe(false)
  })
})

describe('buildApproveMessage — matches the typed-data schema', () => {
  it('always includes reason as a string', () => {
    // The EIP-712 type declares `reason`; omitting it changes the struct hash and makes the
    // signature unverifiable. Empty string is "no reason given", not a missing field.
    const m = buildApproveMessage('id', 'approve', undefined)
    expect(m.reason).toBe('')
    expect(typeof m.reason).toBe('string')
  })

  it('carries the reason through on rejection', () => {
    expect(buildApproveMessage('id', 'reject', '保留名').reason).toBe('保留名')
  })

  it('sets a deadline in the future and a nonce', () => {
    const now = 1_760_000_000_000
    const m = buildApproveMessage('id', 'approve', undefined, now)
    expect(m.nonce).toBe(BigInt(now))
    expect(m.deadline).toBeGreaterThan(BigInt(Math.floor(now / 1000)))
  })

  it('has exactly the five fields the schema declares (control)', () => {
    // An extra field would be ignored by the signer but change nothing; a MISSING one breaks
    // verification silently. Pinning the shape catches both.
    expect(Object.keys(buildApproveMessage('id', 'approve', undefined)).sort()).toEqual(
      ['deadline', 'decision', 'id', 'nonce', 'reason'].sort(),
    )
  })
})

describe('serialiseApproveMessage', () => {
  it('turns bigints into strings so JSON.stringify does not throw', () => {
    const s = serialiseApproveMessage(buildApproveMessage('id', 'approve', undefined))
    expect(typeof s.nonce).toBe('string')
    expect(typeof s.deadline).toBe('string')
    expect(() => JSON.stringify(s)).not.toThrow()
  })

  it('the unserialised form DOES throw (control)', () => {
    // Proves the serialisation is load-bearing rather than decorative.
    expect(() => JSON.stringify(buildApproveMessage('id', 'approve', undefined))).toThrow()
  })
})
