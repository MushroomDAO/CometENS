import { describe, expect, it } from 'vitest'
import { decodeFunctionData, keccak256, namehash, type Address, type PublicClient } from 'viem'
import { SDKError } from '../../sdk/profiles'
import { V4_CAP_INITIAL_ADDR, V4_CAP_ISSUE, V4ControllerAdapter, v4CommunityAbi, type V4ControllerProfile } from '../../sdk/v4'

const owner = '0x1111111111111111111111111111111111111111' as const
const operator = '0x2222222222222222222222222222222222222222' as const
const other = '0x3333333333333333333333333333333333333333' as const
const code = '0x6001600055' as const
const profile: V4ControllerProfile = {
  parentName: 'community.eth', chainId: 11155420,
  contract: '0x4444444444444444444444444444444444444444', expectedCodeHash: keccak256(code),
}
const future = () => BigInt(Math.floor(Date.now() / 1000) + 3600)

function reader(options: { chainId?: number; bytecode?: `0x${string}`; parent?: `0x${string}`; controller?: Address; verified?: boolean; error?: boolean } = {}) {
  const calls: string[] = []
  const fake = {
    async getChainId() { calls.push('getChainId'); if (options.error) throw new Error('sensitive-provider-url'); return options.chainId ?? 11155420 },
    async getBytecode() { calls.push('getBytecode'); return options.bytecode ?? code },
    async readContract({ functionName }: { functionName: string }) {
      calls.push(functionName)
      switch (functionName) {
        case 'parentNode': return options.parent ?? namehash(profile.parentName)
        case 'rootController': return options.controller ?? owner
        case 'l1OwnershipVerified': return options.verified ?? false
        case 'operators': return [3n, 2n, future(), 1n]
        case 'operatorActive': return true
        default: throw new Error('unexpected read')
      }
    },
  }
  return { client: fake as unknown as PublicClient, calls }
}

describe('G2 OP application-only V4 adapter', () => {
  it('requires explicit OP testnet deployment hash and rejects credentials/unknown profiles', () => {
    const { client } = reader()
    expect(() => new V4ControllerAdapter({ ...profile, chainId: 10 as 11155420 }, client)).toThrow(SDKError)
    expect(() => new V4ControllerAdapter({ ...profile, expectedCodeHash: '0x00' }, client)).toThrow(SDKError)
    expect(() => new V4ControllerAdapter({ ...profile, privateKey: 'bad' } as V4ControllerProfile, client)).toThrow(SDKError)
    expect(() => new V4ControllerAdapter({ ...profile, parentName: 'OTHER.ETH' }, client)).toThrow(SDKError)
  })

  it('checks both chain and deployed code hash on each preparation without trusting an RPC hostname', async () => {
    const wrongChain = new V4ControllerAdapter(profile, reader({ chainId: 10 }).client)
    await expect(wrongChain.verify()).rejects.toMatchObject({ kind: 'chain-mismatch' })
    const wrongCode = new V4ControllerAdapter(profile, reader({ bytecode: '0x6000' }).client)
    await expect(wrongCode.prepareRevoke(owner, operator)).rejects.toMatchObject({ kind: 'contract-missing' })
    await expect(new V4ControllerAdapter(profile, reader({ bytecode: '0x' }).client).verify()).rejects.toMatchObject({ kind: 'contract-missing' })
    const { client, calls } = reader()
    const adapter = new V4ControllerAdapter(profile, client)
    await adapter.verify()
    await adapter.prepareRevoke(owner, operator)
    expect(calls.filter((name) => name === 'getChainId')).toHaveLength(2)
    expect(calls.filter((name) => name === 'getBytecode')).toHaveLength(2)
  })

  it('cannot mistake an arbitrary contract with matching bytecode but wrong parent/controller for the selected root', async () => {
    await expect(new V4ControllerAdapter(profile, reader({ parent: namehash('other.eth') }).client).verify())
      .rejects.toMatchObject({ kind: 'unsupported-protocol' })
    await expect(new V4ControllerAdapter(profile, reader({ verified: true }).client).verify())
      .rejects.toMatchObject({ kind: 'unsupported-protocol' })
    await expect(new V4ControllerAdapter(profile, reader({ controller: '0x0000000000000000000000000000000000000000' }).client).verify())
      .rejects.toMatchObject({ kind: 'unsupported-protocol' })
  })

  it('returns owner-scoped grant calldata, never a broadcast or wallet signature', async () => {
    const adapter = new V4ControllerAdapter(profile, reader().client)
    const tx = await adapter.prepareGrant(owner, operator, V4_CAP_ISSUE | V4_CAP_INITIAL_ADDR, 5n, future())
    expect(tx).toMatchObject({ from: owner, to: profile.contract, chainId: 11155420, value: 0n, ownershipScope: 'op-application-only' })
    const call = decodeFunctionData({ abi: v4CommunityAbi, data: tx.data })
    expect(call.functionName).toBe('grantOperator')
    expect(call.args?.[0]).toBe(operator)
    expect(call.args?.[1]).toBe(3n)
    expect(call.args?.[2]).toBe(5n)
    expect('privateKey' in tx).toBe(false)
  })

  it('fails closed on wrong owner and invalid scope/quota/expiry', async () => {
    const adapter = new V4ControllerAdapter(profile, reader().client)
    await expect(adapter.prepareGrant(other, operator, 1n, 5n, future())).rejects.toMatchObject({ kind: 'unauthorized' })
    await expect(adapter.prepareGrant(owner, operator, 2n, 5n, future())).rejects.toMatchObject({ kind: 'invalid-input' })
    await expect(adapter.prepareGrant(owner, operator, 4n, 5n, future())).rejects.toMatchObject({ kind: 'invalid-input' })
    await expect(adapter.prepareGrant(owner, operator, 1n, 0n, future())).rejects.toMatchObject({ kind: 'invalid-input' })
    await expect(adapter.prepareGrant(owner, operator, 1n, 1n, 1n)).rejects.toMatchObject({ kind: 'invalid-input' })
    await expect(adapter.prepareGrant(owner, operator, 1n, (1n << 64n), future())).rejects.toMatchObject({ kind: 'invalid-input' })
  })

  it('prepares typed revoke, rotate and two-step owner handoff without sending a transaction', async () => {
    const adapter = new V4ControllerAdapter(profile, reader().client)
    const revoke = await adapter.prepareRevoke(owner, operator)
    expect(decodeFunctionData({ abi: v4CommunityAbi, data: revoke.data }).functionName).toBe('revokeOperator')
    const rotate = await adapter.prepareRotate(owner, operator, other, V4_CAP_ISSUE, 2n, future())
    expect(decodeFunctionData({ abi: v4CommunityAbi, data: rotate.data }).functionName).toBe('rotateOperator')
    const change = await adapter.prepareControllerHandoff(owner, other)
    expect(decodeFunctionData({ abi: v4CommunityAbi, data: change.data }).functionName).toBe('proposeController')
  })

  it('reads operator state with explicit non-sovereign provenance', async () => {
    const adapter = new V4ControllerAdapter(profile, reader().client)
    const status = await adapter.getOperator(operator)
    expect(status).toMatchObject({ operator, controller: owner, permissions: 3n, remainingQuota: 2n, epoch: 1n, canIssue: true, l1OwnershipVerified: false, scope: 'op-application-only' })
  })

  it('redacts arbitrary provider exceptions', async () => {
    const adapter = new V4ControllerAdapter(profile, reader({ error: true }).client)
    try { await adapter.verify(); throw new Error('Expected network failure') }
    catch (error) {
      expect(error).toBeInstanceOf(SDKError)
      expect((error as Error).message).not.toContain('sensitive-provider-url')
    }
  })
})
