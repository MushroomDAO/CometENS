import { describe, expect, it } from 'vitest'
import { hashTypedData, namehash } from 'viem'
import { optimismSepolia } from 'viem/chains'
import {
  AddRegistrarTypes,
  ApplyTypes,
  ApproveApplicationTypes,
  RegisterTypes,
  RemoveRegistrarTypes,
  SetAddrTypes,
  SetContenthashTypes,
  SetTextTypes,
  TransferSubnodeTypes,
  buildDomain,
} from '../../server/gateway/manage/schemas'

/**
 * EIP-712 digests for the payloads signed by src/admin.ts and src/register.ts.
 *
 * Captured from viem hashTypedData against these schemas before the `as any` casts were
 * removed. Field order, primary type, and values are part of the signed bytes — a type-only
 * cleanup that changes one of these hashes is a signature break.
 */
const CONTRACT = '0x1111111111111111111111111111111111111111' as const
const OWNER = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' as const
const DOMAIN = buildDomain(optimismSepolia.id, CONTRACT)
const NODE = namehash('alice.aastar.eth')
const PARENT_NODE = namehash('aastar.eth')
const NONCE = 1n
const DEADLINE = 1_700_000_000n

const PINNED = {
  Apply: '0xe28a675fe359dbb76d789894e3be9934f1e45fb8a1620f3d7d22c03ceb7383e6',
  Register: '0x5a26b137da9b04da9a6c18445786a1be1932abcb20fae364605a2bf3ca380d57',
  ApproveApplication: '0xd4282bb85e3e949bca257822bd93753ad1f67f6a57608c143c1d03c97cc0e0dc',
  SetAddr: '0x5a6b4d31791aff5d75089b0c0b157d2053615cd998cd751be4590523f3658cc4',
  SetText: '0x0c82e17970ae79ca225a24bd2d923a3f3cfa21ed732684e743688adcbf1d58dc',
  SetContenthash: '0xb07ddb48594ce07ea7febe13bf1f5d676962424012cbb1d7429f3a92305f98f1',
  AddRegistrar: '0xe84c907527da97a4c2dde07dbab7e8d3f5b70bb6442f7356bbeb5f27850d6e56',
  RemoveRegistrar: '0x1965d99d302706fe9b08347052dee1cc0bdac3f671c2ce75890415383e18d9cd',
  TransferSubnode: '0x31592a869440662203130fcb18f74841f4aef161e876dbd78a118d6282d6276d',
} as const

describe('EIP-712 signTypedData digests stay pinned', () => {
  it('Apply (register.ts)', () => {
    expect(hashTypedData({
      domain: DOMAIN,
      primaryType: 'Apply',
      types: ApplyTypes,
      message: {
        parent: 'aastar.eth',
        label: 'alice',
        owner: OWNER,
        nonce: NONCE,
        deadline: DEADLINE,
      },
    })).toBe(PINNED.Apply)
  })

  it('Register (admin.ts grant)', () => {
    expect(hashTypedData({
      domain: DOMAIN,
      primaryType: 'Register',
      types: RegisterTypes,
      message: {
        parent: 'aastar.eth',
        label: 'alice',
        owner: OWNER,
        nonce: NONCE,
        deadline: DEADLINE,
      },
    })).toBe(PINNED.Register)
  })

  it('ApproveApplication', () => {
    expect(hashTypedData({
      domain: DOMAIN,
      primaryType: 'ApproveApplication',
      types: ApproveApplicationTypes,
      message: {
        id: 'app-1',
        decision: 'approve',
        reason: '',
        nonce: NONCE,
        deadline: DEADLINE,
      },
    })).toBe(PINNED.ApproveApplication)
  })

  it('SetAddr', () => {
    expect(hashTypedData({
      domain: DOMAIN,
      primaryType: 'SetAddr',
      types: SetAddrTypes,
      message: {
        node: NODE,
        coinType: 60n,
        addr: OWNER,
        nonce: NONCE,
        deadline: DEADLINE,
      },
    })).toBe(PINNED.SetAddr)
  })

  it('SetText', () => {
    expect(hashTypedData({
      domain: DOMAIN,
      primaryType: 'SetText',
      types: SetTextTypes,
      message: {
        node: NODE,
        key: 'email',
        value: 'a@b.c',
        nonce: NONCE,
        deadline: DEADLINE,
      },
    })).toBe(PINNED.SetText)
  })

  it('SetContenthash (empty bytes, the clear-record value)', () => {
    expect(hashTypedData({
      domain: DOMAIN,
      primaryType: 'SetContenthash',
      types: SetContenthashTypes,
      message: {
        node: NODE,
        hash: '0x',
        nonce: NONCE,
        deadline: DEADLINE,
      },
    })).toBe(PINNED.SetContenthash)
  })

  it('AddRegistrar', () => {
    expect(hashTypedData({
      domain: DOMAIN,
      primaryType: 'AddRegistrar',
      types: AddRegistrarTypes,
      message: {
        parentNode: PARENT_NODE,
        registrar: OWNER,
        quota: 1000n,
        expiry: 0n,
        nonce: NONCE,
        deadline: DEADLINE,
      },
    })).toBe(PINNED.AddRegistrar)
  })

  it('RemoveRegistrar', () => {
    expect(hashTypedData({
      domain: DOMAIN,
      primaryType: 'RemoveRegistrar',
      types: RemoveRegistrarTypes,
      message: {
        parentNode: PARENT_NODE,
        registrar: OWNER,
        nonce: NONCE,
        deadline: DEADLINE,
      },
    })).toBe(PINNED.RemoveRegistrar)
  })

  it('TransferSubnode', () => {
    expect(hashTypedData({
      domain: DOMAIN,
      primaryType: 'TransferSubnode',
      types: TransferSubnodeTypes,
      message: {
        node: NODE,
        to: OWNER,
        nonce: NONCE,
        deadline: DEADLINE,
      },
    })).toBe(PINNED.TransferSubnode)
  })
})
