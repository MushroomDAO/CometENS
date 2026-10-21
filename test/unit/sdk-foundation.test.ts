import { describe, expect, it } from 'vitest'
import { namehash } from 'viem'
import { buildDomain, RegisterTypes as ServerRegisterTypes, AddRegistrarTypes as ServerAddRegistrarTypes } from '../../server/gateway/manage/schemas'
import { SDKError, createSelfHostedProfile, validateNetworkProfile } from '../../sdk/profiles'
import { RegisterTypes, AddRegistrarTypes, typedDataForRegister, typedDataForAddRegistrar, typedDataForSetText } from '../../sdk/protocol'

const parent = 'community.eth'
const signer = '0x1111111111111111111111111111111111111111' as const
const profile = createSelfHostedProfile({
  id: 'community-testnet', protocol: 'v3-readonly', rootName: parent,
  l1: { chainId: 11155111, rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com', resolverAddress: signer },
  l2: { chainId: 11155420, rpcUrl: 'https://sepolia.optimism.io', recordsAddress: signer },
  apiBaseUrl: 'https://example.com', gatewayUrls: ['https://ccip.example.com'],
})
const meta = () => ({ nonce: 9n, deadline: BigInt(Math.floor(Date.now() / 1000) + 600) })

describe('G1 SDK protocol foundation (independent of Worker/SDK client)', () => {
  it('preserves exact EIP-712 domain and Worker field order', () => {
    expect(RegisterTypes).toEqual(ServerRegisterTypes)
    expect(AddRegistrarTypes).toEqual(ServerAddRegistrarTypes)
    const msg = { parent, label: 'alice', owner: signer, ...meta() }
    const typed = typedDataForRegister(profile, msg)
    expect(typed.domain).toEqual(buildDomain(11155420, signer))
    expect(typed.message).toBe(msg)
    const registrar = { parentNode: namehash(parent), registrar: signer, quota: 2n, expiry: 0n, ...meta() }
    expect(typedDataForAddRegistrar(profile, registrar).message).toBe(registrar)
  })
  it('rejects wrong root, stale deadline, and cross-parent registrar signatures', () => {
    expect(() => typedDataForRegister(profile, { parent: 'other.eth', label: 'alice', owner: signer, ...meta() })).toThrow(SDKError)
    expect(() => typedDataForRegister(profile, { parent, label: 'alice', owner: signer, nonce: 1n, deadline: 1n })).toThrow(SDKError)
    expect(() => typedDataForAddRegistrar(profile, { parentNode: namehash('other.eth'), registrar: signer, quota: 1n, expiry: 0n, ...meta() })).toThrow(SDKError)
  })
  it('rejects mismatched networks and secret-bearing public profile URLs', () => {
    expect(() => validateNetworkProfile({ ...profile, l2: { ...profile.l2, chainId: 10 } })).toThrow(SDKError)
    expect(() => validateNetworkProfile({ ...profile, apiBaseUrl: 'https://example.com?token=secret' })).toThrow(SDKError)
    expect(() => validateNetworkProfile({ ...profile, l1: { ...profile.l1, rpcUrl: 'https://provider.example/v2/MY_SECRET_KEY_ABC_1234' } })).toThrow(SDKError)
  })
  it('checks byte-sized limits before attempting to sign record updates', () => {
    expect(() => typedDataForSetText(profile, { node: namehash('alice.community.eth'), key: 'k'.repeat(257), value: 'v', ...meta() })).toThrow(SDKError)
  })
})
