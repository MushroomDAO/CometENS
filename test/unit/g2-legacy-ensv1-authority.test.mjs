import { describe, expect, it } from 'vitest'
import { keccak256, namehash } from 'viem'
import {
  auditLegacyEnsV1, EvidenceFailure, ENSV1_SEPOLIA_REGISTRY, ENSV1_SEPOLIA_WRAPPER,
  CANNOT_UNWRAP, PARENT_CANNOT_CONTROL,
} from '../../scripts/audit-legacy-ensv1-authority.mjs'

const registryCode = '0x6001600055'
const wrapperCode = '0x6002600055'
const now = BigInt(Math.floor(Date.now() / 1000))
const parent = 'community.eth'
const child = 'alice.community.eth'
const parentHolder = '0x1111111111111111111111111111111111111111'
const childHolder = '0x2222222222222222222222222222222222222222'
const ZERO = '0x0000000000000000000000000000000000000000'
const expected = {
  parentName: parent, childName: child,
  expectedRegistryCodeHash: keccak256(registryCode),
  expectedWrapperCodeHash: keccak256(wrapperCode),
}

function fake(options = {}) {
  const calls = []
  const parentNode = namehash(parent)
  const childNode = namehash(child)
  const client = {
    async getChainId() { calls.push('chain'); return options.chainId ?? 11155111 },
    async getBlock(arg) {
      expect(arg).toEqual({ blockTag: 'finalized' })
      calls.push('finalized')
      return { number: 54321n, timestamp: options.timestamp ?? now - 60n }
    },
    async getBytecode({ address, blockNumber }) {
      expect(blockNumber).toBe(54321n)
      calls.push(`code:${address}`)
      return address === ENSV1_SEPOLIA_REGISTRY ? (options.registryCode ?? registryCode) :
        (options.wrapperCode ?? wrapperCode)
    },
    async readContract({ address, functionName, args, blockNumber }) {
      expect(blockNumber).toBe(54321n)
      calls.push(`${functionName}:${args[0]}`)
      if (options.rpcError) throw new Error('https://rpc.example/v2/credential-do-not-echo')
      const isParent = args[0] === parentNode || args[0] === BigInt(parentNode)
      const isChild = args[0] === childNode || args[0] === BigInt(childNode)
      expect(isParent || isChild).toBe(true)
      if (functionName === 'owner') {
        expect(address).toBe(ENSV1_SEPOLIA_REGISTRY)
        return isParent ? (options.parentRegistryOwner ?? ENSV1_SEPOLIA_WRAPPER) :
          (options.childRegistryOwner ?? ENSV1_SEPOLIA_WRAPPER)
      }
      expect(address).toBe(ENSV1_SEPOLIA_WRAPPER)
      if (functionName === 'getData') return isParent ? [
        options.parentHolder ?? parentHolder,
        options.parentFuses ?? CANNOT_UNWRAP,
        options.parentExpiry ?? now + 3600n,
      ] : [
        options.childHolder ?? childHolder,
        options.childFuses ?? (PARENT_CANNOT_CONTROL | CANNOT_UNWRAP),
        options.childExpiry ?? now + 1200n,
      ]
      throw new Error('unknown contract function')
    },
  }
  return { client, calls }
}

describe('G2 legacy ENSv1 Sepolia evidence (read only; never sovereignty)', () => {
  it('records finalized same-block owner/fuses/expiry without asserting OP or ENSv2 authority', async () => {
    const { client, calls } = fake()
    const observed = await auditLegacyEnsV1({ ...expected, client })
    expect(observed).toMatchObject({
      mode: 'LEGACY_ENSV1_SEPOLIA_OBSERVATION_ONLY', chainId: 11155111, blockNumber: '54321',
      opControllerAuthorityVerified: false, ensV2AuthorityVerified: false, sovereignReceipt: false,
      parentWrappedHolder: parentHolder, childWrappedHolder: childHolder,
      parentLocked: true, childLocked: true, childEmancipated: true, observedLegacyFuseConditions: true,
    })
    expect(calls.filter((c) => c === 'finalized')).toHaveLength(1)
    expect(calls.filter((c) => c.startsWith('code:'))).toHaveLength(2)
    expect(calls.filter((c) => c.startsWith('owner:'))).toHaveLength(2)
    expect(calls.filter((c) => c.startsWith('getData:'))).toHaveLength(2)
  })

  it('rejects another chain even when address and codehash match', async () => {
    await expect(auditLegacyEnsV1({ ...expected, client: fake({ chainId: 1 }).client }))
      .rejects.toMatchObject({ code: 'wrong-chain' })
  })

  it('refuses stale finalized head, missing bytecode, incorrect pins and absent parent', async () => {
    for (const options of [
      { timestamp: now - 10_000n },
      { timestamp: now + 121n },
    ]) {
      await expect(auditLegacyEnsV1({ ...expected, client: fake(options).client }))
        .rejects.toMatchObject({ code: 'stale-finality' })
    }
    await expect(auditLegacyEnsV1({ ...expected, client: fake({ wrapperCode: '0x' }).client }))
      .rejects.toMatchObject({ code: 'untrusted-bytecode' })
    await expect(auditLegacyEnsV1({ ...expected, client: fake({ registryCode: '0x6000' }).client }))
      .rejects.toMatchObject({ code: 'untrusted-bytecode' })
    await expect(auditLegacyEnsV1({ ...expected, client: fake({ parentRegistryOwner: ZERO }).client }))
      .rejects.toMatchObject({ code: 'missing-parent' })
  })

  it('never treats unwrapped/replaced parent or child registry owners as fuse-protected', async () => {
    for (const options of [
      { parentRegistryOwner: parentHolder },
      { childRegistryOwner: childHolder },
    ]) {
      const evidence = await auditLegacyEnsV1({ ...expected, client: fake(options).client })
      expect(evidence.observedLegacyFuseConditions).toBe(false)
      expect(evidence.sovereignReceipt).toBe(false)
    }
  })

  it('fails legacy PCC/CU checks for missing bits, expired names or child expiry beyond parent', async () => {
    for (const options of [
      { parentFuses: 0 },
      { childFuses: CANNOT_UNWRAP },
      { childFuses: PARENT_CANNOT_CONTROL },
      { parentExpiry: now - 1n },
      { childExpiry: now - 1n },
      { childExpiry: now + 7200n },
      { childHolder: ZERO },
    ]) {
      const evidence = await auditLegacyEnsV1({ ...expected, client: fake(options).client })
      expect(evidence.observedLegacyFuseConditions, JSON.stringify(options, (_, x) => typeof x === 'bigint' ? String(x) : x)).toBe(false)
      expect(evidence.opControllerAuthorityVerified).toBe(false)
    }
  })

  it('rejects untrusted names/parent scope or hash pins before contacting a chain', async () => {
    const { client, calls } = fake()
    for (const args of [
      { childName: 'eve.other.eth' }, { childName: 'alice.team.community.eth' },
      { childName: 'ALICE.community.eth' }, { childName: 'xn--evil.community.eth' },
      { parentName: 'COMMUNITY.eth' }, { parentName: 'bad--label.eth' },
      { expectedRegistryCodeHash: '0x1234' }, { expectedWrapperCodeHash: '' },
    ]) await expect(auditLegacyEnsV1({ ...expected, ...args, client })).rejects.toBeInstanceOf(EvidenceFailure)
    expect(calls).toHaveLength(0)
  })

  it('never discloses RPC URLs or provider error bodies', async () => {
    try {
      await auditLegacyEnsV1({ ...expected, client: fake({ rpcError: true }).client })
      throw new Error('test failed to trigger an RPC error')
    } catch (error) {
      expect(error).toMatchObject({ code: 'rpc-or-contract-error' })
      expect(error.message).not.toContain('credential-do-not-echo')
      expect(error.message).not.toContain('rpc.example')
    }
  })
})
