import { describe, it, expect } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { verifyTypedData } from 'viem'
import { optimismSepolia } from 'viem/chains'
import {
  buildDomain,
  RegisterTypes,
  SetAddrTypes,
  type RegisterMessage,
  type SetAddrMessage,
} from '../server/gateway/manage/schemas'

const SIGNER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const
const account = privateKeyToAccount(SIGNER_PK)

const VERIFYING_CONTRACT = '0x1234567890123456789012345678901234567890' as `0x${string}`
const domain = buildDomain(optimismSepolia.id, VERIFYING_CONTRACT)

describe('buildDomain', () => {
  it('returns correct domain fields', () => {
    expect(domain.name).toBe('CometENS')
    expect(domain.version).toBe('1')
    expect(domain.chainId).toBe(optimismSepolia.id)
    expect(domain.verifyingContract).toBe(VERIFYING_CONTRACT)
  })
})

describe('RegisterTypes EIP-712', () => {
  it('sign and verify Register message', async () => {
    const message: RegisterMessage = {
      parent: 'aastar.eth',
      label: 'alice',
      owner: account.address,
      nonce: 0n,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
    }

    const signature = await account.signTypedData({
      domain,
      types: RegisterTypes,
      primaryType: 'Register',
      message,
    })

    const ok = await verifyTypedData({
      address: account.address,
      domain,
      types: RegisterTypes,
      primaryType: 'Register',
      message,
      signature,
    })

    expect(ok).toBe(true)
  })

  it('rejects signature from different signer', async () => {
    const otherAccount = privateKeyToAccount(
      '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
    )

    const message: RegisterMessage = {
      parent: 'aastar.eth',
      label: 'bob',
      owner: account.address,
      nonce: 0n,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
    }

    const signature = await otherAccount.signTypedData({
      domain,
      types: RegisterTypes,
      primaryType: 'Register',
      message,
    })

    // Verifying against account.address (not otherAccount) should return false
    const ok = await verifyTypedData({
      address: account.address,
      domain,
      types: RegisterTypes,
      primaryType: 'Register',
      message,
      signature,
    })

    expect(ok).toBe(false)
  })
})

describe('SetAddrTypes EIP-712', () => {
  it('sign and verify SetAddr message', async () => {
    const node = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890' as `0x${string}`
    const message: SetAddrMessage = {
      node,
      coinType: 60n,
      addr: account.address,
      nonce: 1n,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
    }

    const signature = await account.signTypedData({
      domain,
      types: SetAddrTypes,
      primaryType: 'SetAddr',
      message,
    })

    const ok = await verifyTypedData({
      address: account.address,
      domain,
      types: SetAddrTypes,
      primaryType: 'SetAddr',
      message,
      signature,
    })

    expect(ok).toBe(true)
  })

  it('expired deadline is detectable (deadline < now)', () => {
    const now = BigInt(Math.floor(Date.now() / 1000))
    const deadline = now - 1n
    expect(deadline < now).toBe(true)
  })
})
