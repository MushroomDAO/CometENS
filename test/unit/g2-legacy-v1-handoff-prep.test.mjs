import { describe, expect, it } from 'vitest'
import { decodeFunctionData, keccak256, namehash, stringToHex } from 'viem'
import { prepareLegacyEnsV1Handoff, HandoffPreparationError, ENSV1_SEPOLIA_REGISTRAR } from '../../scripts/prepare-legacy-ensv1-handoff.mjs'
import { ENSV1_SEPOLIA_REGISTRY, ENSV1_SEPOLIA_WRAPPER, CANNOT_UNWRAP, PARENT_CANNOT_CONTROL } from '../../scripts/audit-legacy-ensv1-authority.mjs'

const now = BigInt(Math.floor(Date.now() / 1000))
const parent = 'community.eth'
const parentNode = namehash(parent)
const childNode = namehash(`alice.${parent}`)
const parentOwner = '0x1111111111111111111111111111111111111111'
const member = '0x2222222222222222222222222222222222222222'
const resolver = '0x3333333333333333333333333333333333333333'
const ZERO = '0x0000000000000000000000000000000000000000'
const registryCode = '0x600101'
const wrapperCode = '0x600202'
const registrarCode = '0x600303'
const baseArgs = {
  parentName: parent, label: 'alice', expectedParentOwner: parentOwner, member, resolver,
  expiry: now + 10n * 86400n,
  expectedRegistryCodeHash: keccak256(registryCode),
  expectedWrapperCodeHash: keccak256(wrapperCode),
  expectedRegistrarCodeHash: keccak256(registrarCode),
}

function mock(overrides = {}) {
  const calls = []
  const client = {
    async getChainId() { calls.push('chain'); return overrides.chainId ?? 11155111 },
    async getBlock(opts) {
      expect(opts).toEqual({ blockTag: 'finalized' })
      calls.push('finalized')
      return { number: 999n, timestamp: overrides.timestamp ?? now - 60n }
    },
    async getBytecode({ address, blockNumber }) {
      expect(blockNumber).toBe(999n)
      calls.push(`bytecode:${address}`)
      if (address === ENSV1_SEPOLIA_REGISTRY) return overrides.registryCode ?? registryCode
      if (address === ENSV1_SEPOLIA_WRAPPER) return overrides.wrapperCode ?? wrapperCode
      if (address === ENSV1_SEPOLIA_REGISTRAR) return overrides.registrarCode ?? registrarCode
      throw new Error('unexpected address')
    },
    async readContract({ address, functionName, args, blockNumber }) {
      expect(blockNumber).toBe(999n)
      calls.push(`${functionName}:${address}`)
      if (overrides.rpcError) throw new Error('https://secret-provider.example/v2/DO-NOT-ECHO')
      if (functionName === 'owner') {
        expect(address).toBe(ENSV1_SEPOLIA_REGISTRY)
        if (args[0] === parentNode) return overrides.parentRegistryOwner ?? ENSV1_SEPOLIA_WRAPPER
        expect(args[0]).toBe(childNode)
        return overrides.childRegistryOwner ?? ZERO
      }
      if (functionName === 'getData') {
        expect(address).toBe(ENSV1_SEPOLIA_WRAPPER)
        expect(args).toEqual([BigInt(parentNode)])
        return [overrides.parentOwner ?? parentOwner, overrides.parentFuses ?? CANNOT_UNWRAP, overrides.wrapperExpiry ?? now + 100n * 86400n]
      }
      expect(functionName).toBe('nameExpires')
      expect(address).toBe(ENSV1_SEPOLIA_REGISTRAR)
      expect(args).toEqual([BigInt(keccak256(stringToHex('community')))])
      return overrides.registrarExpiry ?? now + 30n * 86400n
    },
  }
  return { client, calls }
}

describe('G2.7 unsigned legacy ENSv1 handoff preparation — never a receipt', () => {
  it('reads all pinned code concurrently at the same finalized block, without lock or state change', async () => {
    const { client } = mock()
    const original = client.getBytecode
    let active = 0
    let peak = 0
    client.getBytecode = async (options) => {
      active++
      peak = Math.max(peak, active)
      await Promise.resolve()
      try { return await original(options) } finally { active-- }
    }
    await prepareLegacyEnsV1Handoff({ ...baseArgs, client })
    expect(peak).toBe(3) // Serializing reads would fail this test.
  })

  it('prepares native NameWrapper calldata without writing or asserting ownership', async () => {
    const { client, calls } = mock()
    const result = await prepareLegacyEnsV1Handoff({ ...baseArgs, client })
    expect(result).toMatchObject({
      mode: 'LEGACY_ENSV1_SEPOLIA_UNSIGNED_PREPARATION_ONLY', chainId: 11155111,
      from: parentOwner, to: ENSV1_SEPOLIA_WRAPPER,
      sovereignReceipt: false, nativeHandoffCompleted: false,
      ensV2AuthorityVerified: false, opControllerAuthorityVerified: false,
      blockNumber: '999', fuses: CANNOT_UNWRAP | PARENT_CANNOT_CONTROL,
      registrarExpiry: (now + 30n * 86400n).toString(),
    })
    // Independent ABI decode verifies target function and all seven arguments.
    const decoded = decodeFunctionData({ abi: [{ type: 'function', name: 'setSubnodeRecord', stateMutability: 'nonpayable',
      inputs: [{ type: 'bytes32' }, { type: 'string' }, { type: 'address' }, { type: 'address' },
        { type: 'uint64' }, { type: 'uint32' }, { type: 'uint64' }], outputs: [] }], data: result.data })
    expect(decoded.functionName).toBe('setSubnodeRecord')
    expect(decoded.args).toEqual([parentNode, 'alice', member, resolver, 0n,
      CANNOT_UNWRAP | PARENT_CANNOT_CONTROL, baseArgs.expiry])
    expect(calls).toContain('finalized')
    expect(calls.filter((call) => call.startsWith('bytecode:'))).toHaveLength(3)
    expect(calls.filter((call) => call.startsWith('owner:'))).toHaveLength(2)
    // Fake client only has read methods, preventing accidental sends.
  })

  it('refuses wrong network, stale finalized block or codehash mismatch', async () => {
    for (const [changes, code] of [
      [{ chainId: 1 }, 'wrong-chain'],
      [{ timestamp: now - 8000n }, 'stale-finality'],
      [{ timestamp: now + 121n }, 'stale-finality'],
      [{ registrarCode: '0x00' }, 'untrusted-bytecode'],
      [{ wrapperCode: '0x' }, 'untrusted-bytecode'],
      [{ registryCode: '0x6000' }, 'untrusted-bytecode'],
    ]) await expect(prepareLegacyEnsV1Handoff({ ...baseArgs, client: mock(changes).client }))
      .rejects.toMatchObject({ code })
  })

  it('never approves parent in .eth registrar grace despite future NameWrapper expiry', async () => {
    for (const overrides of [
      { registrarExpiry: now - 1n },
      { registrarExpiry: now + 3600n },
      { registrarExpiry: now + 24n * 3600n },
      { registrarExpiry: baseArgs.expiry - 1n },
      { registrarExpiry: baseArgs.expiry + 86400n - 1n },
      { requestedExpiry: now + 50n },
      { wrapperExpiry: now - 1n },
      { wrapperExpiry: baseArgs.expiry - 1n },
      { parentFuses: 0 }, { parentOwner: member },
      { parentRegistryOwner: parentOwner },
      { childRegistryOwner: member },
    ]) await expect(prepareLegacyEnsV1Handoff({ ...baseArgs,
      ...(overrides.requestedExpiry ? { expiry: overrides.requestedExpiry } : {}),
      client: mock(overrides).client }))
      .rejects.toMatchObject({ code: 'unsafe-parent-or-expiry' })
  })

  it('rejects unsafe / non-normalized labels and missing pins before RPC calls', async () => {
    const { client, calls } = mock()
    for (const changes of [
      { parentName: 'community.team.eth' }, { parentName: 'Community.eth' },
      { parentName: 'xn--name.eth' }, { label: 'xn--bad' }, { label: 'a..b' },
      { label: 'ALICE' }, { label: '-foo' }, { label: 'foo-' },
      { member: ZERO }, { resolver: ZERO }, { expectedParentOwner: ZERO },
      { expiry: 1n << 70n },
      { expectedRegistrarCodeHash: '0x' },
    ]) await expect(prepareLegacyEnsV1Handoff({ ...baseArgs, ...changes, client }))
      .rejects.toBeInstanceOf(HandoffPreparationError)
    expect(calls).toHaveLength(0)
  })

  it('never exposes provider credential URLs or error responses', async () => {
    let failed
    try { await prepareLegacyEnsV1Handoff({ ...baseArgs, client: mock({ rpcError: true }).client }) } catch (error) { failed = error }
    expect(failed).toMatchObject({ code: 'rpc-or-contract-error' })
    expect(failed.message).not.toContain('secret-provider')
    expect(failed.message).not.toContain('DO-NOT-ECHO')
  })
})
