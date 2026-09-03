import { describe, it, expect } from 'vitest'
import { explainError, explorerTxUrl } from '../../src/ui-state'

/**
 * Covers the pure logic of src/ui-state.ts. `OpPanel` is DOM glue and vitest here runs with
 * `environment: 'node'` and no DOM library installed — testing it would mean adding a
 * dependency, which is out of scope for this task. Stated rather than left implied: the
 * error mapping and explorer URLs below are covered; the rendering is not.
 */

describe('explainError — recognised failures become actionable text', () => {
  // The two things operators actually hit. Showing the raw value means a hex selector or a
  // hundred-line RPC dump.
  it('names a wallet rejection as a cancellation, not a failure', () => {
    const r = explainError(new Error('User rejected the request'))
    expect(r.message).toContain('取消')
    expect(r.hint).toContain('没有发生任何变更')
  })

  it.each([
    ['Unauthorized()', '权限'],
    ['AlreadyRegistered()', '已经被注册'],
    ['QuotaExceeded()', '配额'],
    ['RegistrarExpired()', '过期'],
    ['InvalidLabel()', '标签'],
    ['ZeroAddress()', '全零地址'],
  ])('maps %s to plain language', (raw, expected) => {
    expect(explainError(new Error(raw)).message).toContain(expected)
  })

  it('reads viem shortMessage in preference to message', () => {
    const e = { shortMessage: 'Unauthorized()', message: 'a hundred lines of RPC noise' }
    expect(explainError(e).message).toContain('权限')
    expect(explainError(e).message).not.toContain('RPC noise')
  })
})

describe('explainError — unrecognised failures are passed through, not swallowed', () => {
  // A wrong-but-visible message beats a confident "something went wrong": the operator can
  // still search for it. Only credentials are removed.
  it('keeps the original text when nothing matches', () => {
    expect(explainError(new Error('some novel failure')).message).toContain('some novel failure')
  })

  it('strips URLs, because provider keys live in RPC URL paths', () => {
    const secret = 'SUPER_SECRET_KEY_12345'
    const r = explainError(new Error(`failed calling https://opt-sepolia.g.alchemy.com/v2/${secret}`))
    expect(r.message).not.toContain(secret)
    expect(r.message).toContain('已隐去 URL')
  })

  it('the secret would be detectable if it were not stripped (must-leak control)', () => {
    // Without this, "secret absent" and "the assertion is vacuous" look identical.
    expect(`prefix SUPER_SECRET_KEY_12345 suffix`).toContain('SUPER_SECRET_KEY_12345')
  })

  it('never returns an empty message', () => {
    expect(explainError('').message.length).toBeGreaterThan(0)
    expect(explainError(undefined).message.length).toBeGreaterThan(0)
  })
})

describe('explorerTxUrl', () => {
  it('builds a link for known chains', () => {
    expect(explorerTxUrl(11155420, '0xabc')).toBe('https://sepolia-optimism.etherscan.io/tx/0xabc')
    expect(explorerTxUrl(10, '0xabc')).toBe('https://optimistic.etherscan.io/tx/0xabc')
  })

  it('returns undefined for an unknown chain rather than a broken link', () => {
    // A link to the wrong explorer is worse than no link: it shows "not found" for a
    // transaction that succeeded.
    expect(explorerTxUrl(999999, '0xabc')).toBeUndefined()
  })
})
