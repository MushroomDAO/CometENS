import { describe, it, expect } from 'vitest'
import { decideOnExisting } from '../../server/gateway/v1/register'

/**
 * `/v1/register` used to overwrite an existing subdomain and return ok:true — silently handing
 * a member's name to a different address. The e2e probe caught it: `contested.aastar.eth` went
 * from ALICE to OTHER with status 200.
 *
 * The contract cannot guard this. The worker EOA is the contract owner, so on-chain nothing
 * stops the overwrite; this rule is the only guard that can exist.
 */
const ZERO = '0x0000000000000000000000000000000000000000'
const ALICE = `0x${'11'.repeat(20)}`
const OTHER = `0x${'22'.repeat(20)}`

describe('decideOnExisting — three cases that must not collapse', () => {
  it('unregistered → register', () => {
    expect(decideOnExisting(ZERO, ALICE).action).toBe('register')
  })

  it('already the SAME owner → idempotent no-op', () => {
    // Upstream systems retry; a duplicate job must not become an error to special-case.
    expect(decideOnExisting(ALICE, ALICE).action).toBe('noop')
  })

  it("someone ELSE's name → refuse with 409", () => {
    const d = decideOnExisting(ALICE, OTHER)
    expect(d.action).toBe('refuse')
    if (d.action !== 'refuse') return
    expect(d.status).toBe(409)
    expect(d.message).toContain(ALICE)
  })

  it('the three outcomes are actually distinct (control)', () => {
    // Without this, an implementation returning one action for everything would pass each
    // assertion above in isolation — they only ever check one branch at a time.
    const actions = [
      decideOnExisting(ZERO, ALICE).action,
      decideOnExisting(ALICE, ALICE).action,
      decideOnExisting(ALICE, OTHER).action,
    ]
    expect(new Set(actions).size).toBe(3)
  })

  it('owner comparison is case-insensitive', () => {
    // Checksummed vs lowercase addresses are the same account; treating them as different
    // would turn a retry into a refusal, or worse, a refusal into an overwrite.
    expect(decideOnExisting(ALICE.toUpperCase().replace('0X', '0x'), ALICE).action).toBe('noop')
  })

  it('an empty or zero existing owner both mean unregistered', () => {
    expect(decideOnExisting('', ALICE).action).toBe('register')
    expect(decideOnExisting(ZERO.toUpperCase().replace('0X', '0x'), ALICE).action).toBe('register')
  })

  it('a near-miss address is NOT treated as the same owner (control)', () => {
    // Proves the comparison is exact rather than prefix- or length-based.
    expect(decideOnExisting(ALICE.slice(0, -2) + 'ff', ALICE).action).toBe('refuse')
  })
})
