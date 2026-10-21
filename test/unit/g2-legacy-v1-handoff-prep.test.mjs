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
const blockHash = `0x${'ab'.repeat(32)}`
const CANNOT_CREATE_SUBDOMAIN = 1 << 5
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
      return { number: 999n, hash: overrides.blockHash ?? blockHash, timestamp: overrides.timestamp ?? now - 60n }
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
        if (args[0] === BigInt(parentNode)) {
          return [overrides.parentOwner ?? parentOwner, overrides.parentFuses ?? CANNOT_UNWRAP, overrides.wrapperExpiry ?? now + 100n * 86400n]
        }
        expect(args).toEqual([BigInt(childNode)])
        return [overrides.childOwner ?? ZERO, overrides.childFuses ?? 0, overrides.childExpiry ?? 0n]
      }
      if (functionName === 'upgradeContract') {
        expect(address).toBe(ENSV1_SEPOLIA_WRAPPER)
        expect(args).toBeUndefined()
        return overrides.upgradeContract ?? ZERO
      }
      expect(address).toBe(ENSV1_SEPOLIA_REGISTRAR)
      expect(args).toEqual([BigInt(keccak256(stringToHex('community')))])
      if (functionName === 'nameExpires') return overrides.registrarExpiry ?? now + 30n * 86400n
      if (functionName === 'ownerOf') return overrides.registrarOwner ?? ENSV1_SEPOLIA_WRAPPER
      expect(functionName).toBe('getApproved')
      return overrides.registrarApproval ?? ZERO
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
      blockNumber: '999', blockHash, fuses: CANNOT_UNWRAP | PARENT_CANNOT_CONTROL,
      registrarExpiry: (now + 30n * 86400n).toString(),
      registrarNftHolder: ENSV1_SEPOLIA_WRAPPER, previousChildExpiry: '0',
      value: '0',
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
    expect(calls.filter((call) => call.startsWith('getData:'))).toHaveLength(2)
    expect(calls).toContain(`ownerOf:${ENSV1_SEPOLIA_REGISTRAR}`)
    expect(calls).toContain(`getApproved:${ENSV1_SEPOLIA_REGISTRAR}`)
    // Fake client only has read methods, preventing accidental sends.
  })

  it('refuses wrong network, stale finalized block or codehash mismatch', async () => {
    for (const [changes, code] of [
      [{ chainId: 1 }, 'wrong-chain'],
      [{ timestamp: now - 8000n }, 'stale-finality'],
      [{ timestamp: now + 121n }, 'stale-finality'],
      [{ blockHash: ZERO }, 'stale-finality'],
      [{ blockHash: `0x${'0'.repeat(64)}` }, 'stale-finality'],
      [{ blockHash: '0xdeadbeef' }, 'stale-finality'],
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
      { parentFuses: CANNOT_UNWRAP | CANNOT_CREATE_SUBDOMAIN },
      { parentRegistryOwner: parentOwner },
      { childRegistryOwner: member },
      { childExpiry: baseArgs.expiry + 1n },
      { childExpiry: now + 40n * 86400n },
      { childOwner: member }, { childFuses: PARENT_CANNOT_CONTROL },
      { registrarOwner: member }, { registrarApproval: member },
      { upgradeContract: member },
    ]) await expect(prepareLegacyEnsV1Handoff({ ...baseArgs,
      ...(overrides.requestedExpiry ? { expiry: overrides.requestedExpiry } : {}),
      client: mock(overrides).client }))
      .rejects.toMatchObject({ code: 'unsafe-parent-or-expiry' })
  })

  it('rejects burned child with residual long expiry even when Registry.owner(child) is zero (review Medium)', async () => {
    // NameWrapper retains old expiry after unwrapping/burning, and
    // _normaliseExpiry applies max(requestedExpiry, oldExpiry) on re-mint.
    const leftover = now + 45n * 86400n
    const { client } = mock({ childRegistryOwner: ZERO, childOwner: ZERO, childFuses: 0, childExpiry: leftover })
    await expect(prepareLegacyEnsV1Handoff({ ...baseArgs, client }))
      .rejects.toMatchObject({ code: 'unsafe-parent-or-expiry' })
    // The old expiry can pass the 24h margin only when it is <= requested.
    const safe = await prepareLegacyEnsV1Handoff({ ...baseArgs, client: mock({ childExpiry: baseArgs.expiry }).client })
    expect(safe.previousChildExpiry).toBe(baseArgs.expiry.toString())
  })

  it('rejects parent CREATE fuse and unsafe registrar reclaim custody/approval independently', async () => {
    for (const [overrides, guard] of [
      [{ parentFuses: CANNOT_UNWRAP | CANNOT_CREATE_SUBDOMAIN }, 'parent CANNOT_CREATE_SUBDOMAIN'],
      [{ registrarOwner: member }, 'Registrar NFT owner'],
      [{ registrarApproval: member }, 'Registrar token approval'],
      [{ upgradeContract: member }, 'Wrapper upgrade'],
      [{ childOwner: member }, 'stale child owner'],
      [{ childFuses: PARENT_CANNOT_CONTROL }, 'stale child fuse'],
    ]) {
      await expect(prepareLegacyEnsV1Handoff({ ...baseArgs, client: mock(overrides).client }), guard)
        .rejects.toMatchObject({ code: 'unsafe-parent-or-expiry' })
    }
  })

  it('rejects unsafe / non-normalized labels and missing pins before RPC calls', async () => {
    const { client, calls } = mock()
    for (const changes of [
      { parentName: 'community.team.eth' }, { parentName: 'Community.eth' },
      { parentName: 'xn--name.eth' }, { label: 'xn--bad' }, { label: 'a..b' },
      { label: 'ALICE' }, { label: '-foo' }, { label: 'foo-' },
      { label: 'a'.repeat(64) },
      { member: ZERO }, { resolver: ZERO }, { expectedParentOwner: ZERO },
      { expiry: 1n << 70n },
      { expectedRegistrarCodeHash: '0x' },
    ]) await expect(prepareLegacyEnsV1Handoff({ ...baseArgs, ...changes, client }))
      .rejects.toBeInstanceOf(HandoffPreparationError)
    expect(calls).toHaveLength(0)
  })

  it('accepts 63-character valid label and historical child expiry at requested expiry', async () => {
    const longest = 'a'.repeat(63)
    const { client } = mock({ childExpiry: baseArgs.expiry })
    // Same direct parent, but mock registry reads need to recognize the new node.
    const originalRead = client.readContract
    client.readContract = (arg) => {
      if (arg.functionName === 'owner' && arg.args[0] === namehash(`${longest}.${parent}`)) return ZERO
      if (arg.functionName === 'getData' && arg.args[0] === BigInt(namehash(`${longest}.${parent}`))) {
        return [ZERO, 0, baseArgs.expiry]
      }
      return originalRead(arg)
    }
    const result = await prepareLegacyEnsV1Handoff({ ...baseArgs, client, label: longest })
    expect(result.childName).toBe(`${longest}.${parent}`)
    expect(result.previousChildExpiry).toBe(baseArgs.expiry.toString())
  })

  it('rejects exact empty bytecode even when the caller supplies its empty hash', async () => {
    await expect(prepareLegacyEnsV1Handoff({ ...baseArgs,
      expectedWrapperCodeHash: keccak256('0x'), client: mock({ wrapperCode: '0x' }).client,
    })).rejects.toMatchObject({ code: 'untrusted-bytecode' })
  })

  it('never exposes provider credential URLs or error responses', async () => {
    let failed
    try { await prepareLegacyEnsV1Handoff({ ...baseArgs, client: mock({ rpcError: true }).client }) } catch (error) { failed = error }
    expect(failed).toMatchObject({ code: 'rpc-or-contract-error' })
    expect(failed.message).not.toContain('secret-provider')
    expect(failed.message).not.toContain('DO-NOT-ECHO')
  })
})
