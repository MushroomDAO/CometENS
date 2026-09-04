import { describe, it, expect } from 'vitest'
import { classifyQuery, describeStatus, describeAddressLookup } from '../../src/lookup'

/**
 * The public lookup page takes one input and works out for itself what it is. That decision
 * is the whole UX: get it wrong and the page silently answers a different question than the
 * one asked — which is worse than refusing, because the visitor believes the answer.
 */

describe('classifyQuery — addresses', () => {
  it('accepts a well-formed address and lowercases it', () => {
    const r = classifyQuery('0xB5600060E6DE5E11D3636731964218E53CAADF0E')
    expect(r.kind).toBe('address')
    expect(r.value).toBe('0xb5600060e6de5e11d3636731964218e53caadf0e')
  })

  it('trims surrounding whitespace', () => {
    expect(classifyQuery(`  0x${'ab'.repeat(20)}  `).kind).toBe('address')
  })

  it('calls a wrong-length 0x string an address typo, not a bad name', () => {
    // Saying "that is not a valid name" would send someone looking in the wrong place.
    const r = classifyQuery('0xabc')
    expect(r.kind).toBe('invalid')
    expect(r.reason).toContain('地址')
    expect(r.reason).toContain('42')
  })
})

describe('classifyQuery — names', () => {
  it('accepts a full name and lowercases it', () => {
    const r = classifyQuery('Alice.Community.eth')
    expect(r.kind).toBe('name')
    expect(r.value).toBe('alice.community.eth')
  })

  it('accepts deeper names', () => {
    expect(classifyQuery('alice.forest.community.eth').kind).toBe('name')
  })

  it('refuses a bare label rather than guessing the parent', () => {
    // Appending a root domain silently would answer a question the visitor did not ask.
    const r = classifyQuery('alice')
    expect(r.kind).toBe('invalid')
    expect(r.reason).toContain('父域名')
    expect(r.reason).toContain('alice.')
  })

  it('rejects input with characters a label cannot contain', () => {
    expect(classifyQuery('alice bob.eth').kind).toBe('invalid')
    expect(classifyQuery('alice_bob.eth').kind).toBe('invalid')
  })
})

describe('classifyQuery — empty', () => {
  it('reports empty separately from invalid', () => {
    // These get different UI treatment: empty is an empty-state, invalid is an error.
    expect(classifyQuery('').kind).toBe('empty')
    expect(classifyQuery('   ').kind).toBe('empty')
  })
})

describe('describeStatus — three distinct resolution states', () => {
  it('says plainly when a name is unregistered', () => {
    const rows = describeStatus({ name: 'a.eth', registered: false })
    expect(rows.some((r) => r.value.includes('未注册'))).toBe(true)
  })

  it('reports resolvable', () => {
    const rows = describeStatus({ name: 'a.eth', registered: true, l1Resolvable: true })
    expect(rows.some((r) => r.value.includes('可解析'))).toBe(true)
  })

  it('distinguishes "not yet" from "could not determine"', () => {
    // Collapsing these into one boolean would tell a visitor their name is broken when the
    // gateway is merely unreachable.
    const notYet = describeStatus({ name: 'a.eth', registered: true, l1Resolvable: false })
    const unknown = describeStatus({ name: 'a.eth', registered: true, l1Resolvable: 'unknown', detail: 'gateway down' })
    expect(notYet.some((r) => r.value.includes('尚不可用'))).toBe(true)
    expect(unknown.some((r) => r.value.includes('无法确定'))).toBe(true)
    // Control: the two must not produce the same text.
    expect(JSON.stringify(notYet)).not.toBe(JSON.stringify(unknown))
  })

  it('surfaces the estimated time when there is one', () => {
    const rows = describeStatus({
      name: 'a.eth', registered: true, l1Resolvable: false, estimatedResolvableAt: 1_760_000_000,
    })
    expect(rows.some((r) => /之后/.test(r.value))).toBe(true)
  })

  it('always includes the name, copyable', () => {
    const rows = describeStatus({ name: 'alice.community.eth', registered: true, l1Resolvable: true })
    expect(rows[0]).toMatchObject({ value: 'alice.community.eth', copy: true })
  })
})

describe('describeAddressLookup', () => {
  it('returns nothing when the address owns no names', () => {
    // An empty array lets the caller render an empty-state instead of a success with no rows.
    expect(describeAddressLookup({ found: false, names: [] }, '0x1')).toEqual([])
    expect(describeAddressLookup({ found: true, names: [] }, '0x1')).toEqual([])
  })

  it('lists every name, not just the first', () => {
    const rows = describeAddressLookup({ found: true, names: ['a.eth', 'b.eth', 'c.eth'] }, '0xabc')
    expect(rows.filter((r) => r.value.endsWith('.eth'))).toHaveLength(3)
  })
})
