import { describe, expect, it } from 'vitest'
import { keccak256, toHex } from 'viem'
import {
  MAINNET_ROOT, MAINNET_ETH, V2_ROLE, verifyCurrentEnsv2Eac,
} from '../../scripts/verify-g2-ensv2-eac-l1.mjs'

const CHILD = '0x1234567890123456789012345678901234567890'
const HOLDER = '0x2222222222222222222222222222222222222222'
const OTHER = '0x3333333333333333333333333333333333333333'
const ZERO = '0x0000000000000000000000000000000000000000'
const EMPTY = `0x${'00'.repeat(32)}`
const HASH = `0x${'ab'.repeat(32)}`
const CODE = '0x6001600055'
const CODEHASH = keccak256(CODE)
const LABEL_ID = BigInt(keccak256(toHex('community')))
const blockTimestamp = () => BigInt(Math.floor(Date.now() / 1000))
const key = (address) => address.toLowerCase()
const baseManifest = () => ({
  parentName: 'community.eth', holder: HOLDER, actor: HOLDER,
  pins: [MAINNET_ROOT, MAINNET_ETH, CHILD].map(address => ({ address, codeHash: CODEHASH })),
})
const countBit = (n) => 1n << BigInt(n)

function mock(config = {}) {
  const calls = []
  const head = { number: 888n, hash: HASH, timestamp: blockTimestamp() }
  const state = () => ({
    status: config.status ?? 2, expiry: config.expiry ?? blockTimestamp() + 200000n,
    latestOwner: config.newHolder ? OTHER : HOLDER, tokenId: config.badToken ? 0n : 777n,
    resource: config.badResource ? 123n : 456n,
  })
  const client = {
    async getChainId() { calls.push(['chain']); return config.wrongChain ? 11155111 : 1 },
    async getBlock(input) {
      calls.push(['block', input])
      if (config.badHead) return { ...head, hash: null }
      if (config.reorg && input.blockNumber !== undefined) return { ...head, hash: EMPTY }
      return { ...head, timestamp: config.stale ? head.timestamp - 1000n : head.timestamp }
    },
    async getBytecode({ address, blockNumber }) {
      calls.push(['code', key(address), blockNumber])
      if (config.badImplementation && key(address) === key(OTHER)) return '0x6002'
      return config.wrongHash === key(address) ? '0x6002' : CODE
    },
    async getStorageAt({ address, slot, blockNumber }) {
      calls.push(['storage', key(address), blockNumber, slot])
      if (config.proxy && key(address) === key(CHILD) &&
          slot === '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc') {
        return `0x${'00'.repeat(12)}${OTHER.slice(2)}`
      }
      if (config.admin && key(address) === MAINNET_ETH && slot !==
          '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc') {
        return `0x${'00'.repeat(12)}${OTHER.slice(2)}`
      }
      return EMPTY
    },
    async readContract({ address, functionName, args, blockNumber }) {
      calls.push(['read', key(address), blockNumber, functionName, args])
      if (config.throwError) throw new Error('private-token-example in RPC URL')
      switch (functionName) {
        case 'getSubregistry':
          if (key(address) === MAINNET_ROOT) return config.badEthLink ? CHILD : MAINNET_ETH
          return config.badChild ? ZERO : CHILD
        case 'getParent':
          if (key(address) === MAINNET_ETH) return [MAINNET_ROOT, 'eth']
          return config.badChildParent ? [MAINNET_ROOT, 'community'] : [MAINNET_ETH, 'community']
        case 'getState':
          expect(args).toEqual([LABEL_ID]); return state()
        case 'getResource': return config.badResource ? 456n : state().resource
        case 'roleCount':
          if (key(address) === MAINNET_ETH && args[0] !== 0n) return config.parentScopedRisk ??
            (countBit(20) | countBit(20 + 128))
          return key(address) === MAINNET_ROOT ? (config.rootRisk ?? 0n)
            : key(address) === MAINNET_ETH ? (config.ethRisk ?? 0n)
              : (config.childRisk ?? 1n)
        case 'ownerOf': return config.newHolder ? OTHER : HOLDER
        case 'roles': return key(address) === CHILD ? (config.regularIssuer ?? V2_ROLE.REGISTRAR) :
          (config.parentRoles ?? (V2_ROLE.SET_SUBREGISTRY | (V2_ROLE.SET_SUBREGISTRY << 128n)))
        case 'hasRootRoles': return config.rootRegistrar ?? true
        case 'hasRoles': return config.canSwap ?? true
        case 'isApprovedForAll': return config.approved ?? false
        default: throw new Error(`unexpected ${functionName}`)
      }
    },
  }
  return { client, calls }
}

const check = (config, manifest = baseManifest()) =>
  verifyCurrentEnsv2Eac({ client: mock(config).client, manifest })

describe('G2.4 Ethereum L1 ENSv2 EAC read-only observations (never a permission to mint)', () => {
  it('observes a single fresh MAINNET head, pins all three registries, validates root-only registrar and current native owner', async () => {
    const { client, calls } = mock()
    const out = await verifyCurrentEnsv2Eac({ client, manifest: baseManifest() })
    expect(out).toMatchObject({ verdict: 'OBSERVED_EAC_ONLY', authorizedAtSnapshot: true,
      canExecuteNativeIssue: false, sovereignReceipt: false, parentName: 'community.eth',
      parentCanSetSubregistry: true, registrarRootRole: true, completeAdminEnumeration: false })
    expect(calls.filter(c => c[0] === 'block').map(c => c[1])).toEqual([
      { blockTag: 'latest' }, { blockNumber: 888n },
    ])
    expect(calls.filter(c => ['read', 'code', 'storage'].includes(c[0])).every(c => c[2] === 888n)).toBe(true)
    expect(calls.some(c => c[0] === 'read' && c[3] === 'hasRootRoles' && c[4][0] === 1n)).toBe(true)
    expect(calls.some(c => c[0] === 'read' && c[3] === 'getState' && c[4][0] === LABEL_ID)).toBe(true)
    expect(calls.some(c => /send|write|sign/i.test(c[0]))).toBe(false)
  })

  it('never mistakes parent SET_SUBREGISTRY, admin-only, or ERC1155 approval for root REGISTRAR', async () => {
    const results = await Promise.all([
      check({ rootRegistrar: false }), check({ regularIssuer: V2_ROLE.REGISTRAR << 128n }),
      check({ regularIssuer: 0n, canSwap: true, approved: true }),
    ])
    expect(results.map(r => r.reason)).toEqual(Array(3).fill('NO_CURRENT_ROOT_REGISTRAR'))
  })

  it('denies any ROOT migration/admin/upgrade or unenumerated additional registrars', async () => {
    for (const config of [
      { rootRisk: countBit(8) }, // ROLE_SET_PARENT on RootRegistry
      { ethRisk: countBit(124 + 128) }, // upgrade admin, even with no regular upgrade
      { ethRisk: countBit(4) }, // migration RESERVED-to-REGISTERED path
      { childRisk: countBit(0) | countBit(128) }, // registrar admin can grant rights
      { childRisk: 2n }, // multiple authorized registrars
      { childRisk: countBit(20 + 128) | 1n }, // root subregistry admin
      { childRisk: countBit(28 + 128) | 1n }, // root transfer admin
      { parentScopedRisk: countBit(20) * 2n }, // two setters of the parent's child registry
      { parentScopedRisk: countBit(12) }, // scoped unregister bypass
      { parentRoles: V2_ROLE.SET_SUBREGISTRY }, // outsider holds sole scoped parent admin
    ]) {
      expect((await check(config)).reason).toBe('ROOT_ADMIN_OR_MIGRATION_REGRANT_PATH')
    }
  })

  it('denies expired/reserved/rewritten parent and mismatched EAC versioned resource', async () => {
    for (const config of [
      { status: 1 }, { status: 0 }, { expiry: blockTimestamp() },
      { expiry: blockTimestamp() + 86400n }, { newHolder: true },
      { badResource: true },
    ]) {
      expect((await check(config)).reason).toBe('PARENT_INACTIVE_OR_MIGRATED')
    }
  })

  it('denies former owner even when the former owner still holds the old child ROOT registrar role', async () => {
    expect((await check({ newHolder: true, regularIssuer: V2_ROLE.REGISTRAR })).reason)
      .toBe('PARENT_INACTIVE_OR_MIGRATED')
    expect((await check({}, { ...baseManifest(), actor: OTHER })).reason).toBe('ACTOR_NOT_NATIVE_HOLDER')
  })

  it('rejects spoofed registry parent links, missing child, wrong chain or runtime, stale head/reorg', async () => {
    expect((await check({ wrongChain: true })).reason).toBe('WRONG_CHAIN')
    expect((await check({ badHead: true })).reason).toBe('UNVERIFIABLE_HEAD')
    expect((await check({ stale: true })).reason).toBe('STALE_HEAD')
    expect((await check({ badEthLink: true })).reason).toBe('ETH_HIERARCHY_MISMATCH')
    expect((await check({ badChildParent: true })).reason).toBe('PARENT_OWNER_OR_POINTER_CHANGED')
    expect((await check({ badChild: true })).reason).toBe('UNTRUSTED_SUBREGISTRY')
    expect((await check({ wrongHash: MAINNET_ETH })).reason).toBe('UNPINNED_ROOT_OR_ETH')
    expect((await check({ wrongHash: CHILD })).reason).toBe('UNTRUSTED_SUBREGISTRY')
    expect((await check({ reorg: true })).reason).toBe('HEAD_REORGED')
    expect((await check({ admin: true })).reason).toBe('UNPINNED_ROOT_OR_ETH')
  })

  it('pins EIP-1967 registry implementations and refuses missing or changed implementation code', async () => {
    expect((await check({ proxy: true })).reason).toBe('UNTRUSTED_SUBREGISTRY')
    const manifest = baseManifest()
    manifest.pins[2].implementation = { address: OTHER, codeHash: CODEHASH }
    expect((await check({ proxy: true }, manifest)).verdict).toBe('OBSERVED_EAC_ONLY')
    expect((await check({ proxy: true, badImplementation: true }, manifest)).reason).toBe('UNTRUSTED_SUBREGISTRY')
  })

  it('rejects Sepolia addresses, fake pins, malformed names and secrets; redacts RPC errors', async () => {
    for (const manifest of [
      { ...baseManifest(), parentName: 'bücher.eth' },
      { ...baseManifest(), parentName: 'ab--cd.eth' },
      { ...baseManifest(), parentName: 'alice.sub.eth' },
      { ...baseManifest(), pins: baseManifest().pins.slice(1) },
      { ...baseManifest(), pins: [baseManifest().pins[0], baseManifest().pins[0], baseManifest().pins[2]] },
      { ...baseManifest(), pins: baseManifest().pins.map(p => ({ ...p, apiKey: 'secret' })) },
    ]) {
      expect((await check({}, manifest)).authorizedAtSnapshot).toBe(false)
    }
    const out = await check({ throwError: true })
    expect(out).toMatchObject({ verdict: 'DENY', reason: 'RPC_OR_ABI_UNVERIFIABLE' })
    expect(JSON.stringify(out)).not.toContain('private-token-example')
  })
})
