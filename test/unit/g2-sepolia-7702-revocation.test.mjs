import { describe, expect, it } from 'vitest'
import { keccak256, zeroAddress } from 'viem'
import { checkSnapshot, WALLET, DELEGATE, CHAIN } from '../../scripts/check-g2-sepolia-7702-revocation.mjs'
const delegateCode = '0x60006000'
const expectedDelegateCodeHash = keccak256(delegateCode)
const valid = { chainId: CHAIN, wallet: WALLET, code: `0xef0100${DELEGATE.slice(2)}`,
  delegateCode, expectedDelegateCodeHash, latestNonce: 10, pendingNonce: 10 }
describe('read-only EIP-7702 revocation preflight', () => {
  it('only emits an unsigned self executor draft with nonce+1', () => {
    const result = checkSnapshot(valid)
    expect(result).toMatchObject({ status: 'READY_FOR_HUMAN_REVIEW', safeToSign: false,
      broadcast: false, observedTransactionNonce: 10, expectedSelfAuthorizationNonce: 11,
      targetContractAddress: zeroAddress, executor: 'self' })
    expect(JSON.stringify(result)).not.toMatch(/privateKey|salt|signature|authorizationList/)
  })
  it.each([
    [{ chainId: 1 }, 'WRONG_CHAIN_OR_WALLET'],
    [{ wallet: DELEGATE }, 'WRONG_CHAIN_OR_WALLET'],
    [{ code: '0x' }, 'DELEGATION_CHANGED'],
    [{ code: `0xef0100${WALLET.slice(2)}` }, 'DELEGATION_CHANGED'],
    [{ delegateCode: '0x1234' }, 'DELEGATE_CODEHASH_MISMATCH'],
    [{ latestNonce: 11, pendingNonce: 12 }, 'NONCE_PENDING_OR_INVALID'],
  ])('fails closed when a pinned invariant changes', (patch, reason) => {
    expect(checkSnapshot({ ...valid, ...patch })).toMatchObject({ status: 'BLOCKED', reason, safeToSign: false })
  })
})
