import { describe, expect, it } from 'vitest'
import { keccak256 } from 'viem'
import { inspectEnsv2, ROOT, ETH } from '../../scripts/inspect-ensv2-risk.mjs'

const CODE = '0x6001600055'
const HASH = keccak256(CODE)
const ZERO = '0x' + '0'.repeat(64)
const OWNER = '0x1111111111111111111111111111111111111111'
const OP = '0x2222222222222222222222222222222222222222'
const CHILD = '0x3333333333333333333333333333333333333333'
const IMPL = '0x4444444444444444444444444444444444444444'
const future = () => BigInt(Math.floor(Date.now() / 1000) + 5000)
const manifest = () => ({ chainId: 11155111, name: 'alice.eth', rootRegistry: ROOT, ethRegistry: ETH,
  pins: [{ address: ROOT, codeHash: HASH }, { address: ETH, codeHash: HASH }], operators: [OP] })

function mock(config = {}) {
  const calls = []
  const io = {
    async getChainId() { calls.push(['chain']); return config.chainId ?? 11155111 },
    async getBlock({ blockTag }) {
      calls.push(['block', blockTag])
      return { number: 123n, timestamp: config.stale ? 1n : BigInt(Math.floor(Date.now() / 1000) - 30),
        hash: '0x' + 'ab'.repeat(32) }
    },
    async getBytecode({ address, blockNumber }) {
      calls.push(['code', address, blockNumber])
      return config.badCode && address.toLowerCase() === ETH ? '0x6000' : CODE
    },
    async getStorageAt({ address, slot, blockNumber }) {
      calls.push(['storage', address, blockNumber, slot])
      if (config.dynamic && address.toLowerCase() === CHILD && slot.startsWith('0x360894')) {
        return '0x' + '0'.repeat(24) + IMPL.slice(2)
      }
      if (config.proxy && address.toLowerCase() === ETH && slot.startsWith('0x360894')) {
        return '0x' + '0'.repeat(24) + OP.slice(2)
      }
      if (config.proxyAdmin && address.toLowerCase() === ETH && !slot.startsWith('0x360894')) {
        return '0x' + '0'.repeat(24) + OP.slice(2)
      }
      return ZERO
    },
    async readContract({ address, functionName, args, blockNumber }) {
      calls.push(['read', address, blockNumber, functionName, args])
      if (config.rpcError) throw new Error('https://rpc/v2/privateSecretToken')
      switch (functionName) {
        case 'getState': return { status: config.expired && address.toLowerCase() === ETH ? 0 : 2,
          expiry: config.expired ? 1n : future(), latestOwner: OWNER, tokenId: 55n,
          resource: config.wrongResource ? 77n : 66n }
        case 'getResource': return 66n
        case 'roleCount':
          return args[0] === 0n ? (address.toLowerCase() === ETH ? config.dangerousRoles ?? 0n : 0n)
            : config.scopedRoles ?? 0n
        case 'isEmancipated': return !config.dangerousRoles
        case 'getSubregistry': return config.wrongPointer ? OWNER :
          address.toLowerCase() === ROOT ? ETH : CHILD
        case 'getParent': return config.wrongParent ? [OWNER, 'eth'] :
          address.toLowerCase() === CHILD ? [ETH, 'alice'] : [ROOT, 'eth']
        case 'roles': return args[1] === OP ? config.delegatedRoles ?? 0n : 1n
        case 'isApprovedForAll': return config.approved ?? false
      }
      throw new Error('unknown function')
    },
  }
  return { io, calls }
}

const codes = (out) => out.findings.map(f => f.code)

describe('G2.4/7/8 ENSv2 pinned read-only risk observation', () => {
  it('visits current official root->ETH dynamically, compares parent and samples EAC/approvals at one finalized block', async () => {
    const { io, calls } = mock()
    const out = await inspectEnsv2({ client: io, manifest: manifest() })
    expect(out).toMatchObject({ verdict: 'NEEDS_REVIEW', sovereignReceipt: false,
      name: 'alice.eth', chainId: 11155111, checkedAllAncestry: true,
      checkedAllApprovals: false, checkedAllRoleAssignees: false })
    expect(out.visited.map(v => [v.registry.toLowerCase(), v.label])).toEqual([[ROOT, 'eth'], [ETH, 'alice']])
    expect(codes(out)).toContain('APPROVAL_ENUMERATION_INCOMPLETE')
    expect(calls.filter(c => c[0] === 'block')).toEqual([['block', 'finalized']])
    expect(calls.filter(c => c[0] === 'read' || c[0] === 'code' || c[0] === 'storage')
      .every(c => c[2] === 123n)).toBe(true)
    expect(calls.some(c => c[0] === 'read' && c[3] === 'getParent')).toBe(true)
    expect(calls.some(c => c[0] === 'read' && c[3] === 'roleCount' && c[4][0] === 0n)).toBe(true)
    expect(calls.some(c => c[0] === 'read' && c[3] === 'isApprovedForAll')).toBe(true)
    expect(calls.some(c => /write|send|sign|broadcast/i.test(c[0]))).toBe(false)
  })

  it('fails closed for stale finalized block, wrong chain, unsafe manifest, missing pins, and runtime mismatch', async () => {
    expect(codes(await inspectEnsv2({ client: mock({ chainId: 1 }).io, manifest: manifest() })))
      .toContain('WRONG_CHAIN')
    expect(codes(await inspectEnsv2({ client: mock({ stale: true }).io, manifest: manifest() })))
      .toContain('STALE_FINALITY')
    expect(codes(await inspectEnsv2({ client: mock().io, manifest: { ...manifest(), ethRegistry: OWNER } })))
      .toContain('INVALID_MANIFEST')
    expect(codes(await inspectEnsv2({ client: mock().io, manifest: { ...manifest(), pins: [manifest().pins[0]] } })))
      .toContain('MISSING_REGISTRY_PIN')
    expect(codes(await inspectEnsv2({ client: mock({ badCode: true }).io, manifest: manifest() })))
      .toContain('RUNTIME_CODEHASH_MISMATCH')
  })

  it('never trusts a noncanonical forward/backward registry link', async () => {
    const forward = await inspectEnsv2({ client: mock({ wrongPointer: true }).io, manifest: manifest() })
    expect(codes(forward)).toContain('OFFICIAL_ETH_REGISTRY_MISMATCH')
    expect(forward.checkedAllAncestry).toBe(false)
    const backward = await inspectEnsv2({ client: mock({ wrongParent: true }).io, manifest: manifest() })
    expect(codes(backward)).toContain('NONCANONICAL_PARENT_LINK')
    expect(backward.checkedAllAncestry).toBe(false)
  })

  it('refuses inconsistent dynamic EAC resource vs registry getState result', async () => {
    const out = await inspectEnsv2({ client: mock({ wrongResource: true }).io, manifest: manifest() })
    expect(codes(out)).toContain('INVALID_REGISTRY_ABI')
    expect(out.checkedAllAncestry).toBe(false)
  })

  it('detects ROOT_RESOURCE admin/root upgrades, SET_PARENT and scoped EAC risks', async () => {
    const elevated = (1n << (124n + 128n)) | (1n << 8n) | (1n << (24n + 128n))
    const out = await inspectEnsv2({ client: mock({
      dangerousRoles: elevated, scopedRoles: (1n << 20n),
    }).io, manifest: manifest() })
    expect(codes(out)).toContain('DANGEROUS_ROOT_ROLE')
    expect(codes(out)).toContain('REGISTRY_NOT_EMANCIPATED')
    expect(codes(out)).toContain('SCOPED_ROLE_ASSIGNEES_PRESENT')
    expect(out.visited[1].rootRoles.UPGRADE.admin).toBe(1)
    expect(out.visited[1].rootRoles.SET_PARENT.regular).toBe(1)
    expect(out.verdict).toBe('NEEDS_REVIEW')
  })

  it('detects globally inherited ERC1155 approval, delegated roles, and expiry', async () => {
    const out = await inspectEnsv2({ client: mock({
      approved: true, delegatedRoles: 1n << 24n, expired: true,
    }).io, manifest: manifest() })
    expect(codes(out)).toEqual(expect.arrayContaining([
      'INHERITED_ERC1155_APPROVAL', 'THIRD_PARTY_EAC_ROLES', 'NAME_NOT_ACTIVE',
    ]))
    expect(out.verdict).toBe('NEEDS_REVIEW')
  })

  it('discovers a third-level registry dynamically and requires a separate pinned UUPS implementation', async () => {
    const supplied = { ...manifest(), name: 'sub.alice.eth' }
    const unpinned = await inspectEnsv2({ client: mock({ dynamic: true }).io, manifest: supplied })
    expect(codes(unpinned)).toContain('MISSING_REGISTRY_PIN')
    expect(unpinned.checkedAllAncestry).toBe(false)

    supplied.pins.push({ address: CHILD, codeHash: HASH })
    const missingImpl = await inspectEnsv2({ client: mock({ dynamic: true }).io, manifest: supplied })
    expect(codes(missingImpl)).toContain('UNPINNED_PROXY_IMPLEMENTATION')
    expect(missingImpl.checkedAllAncestry).toBe(false)

    supplied.pins[2].implementation = { address: IMPL, codeHash: HASH }
    const verified = await inspectEnsv2({ client: mock({ dynamic: true }).io, manifest: supplied })
    expect(verified.visited.map(r => r.registry.toLowerCase())).toEqual([ROOT, ETH, CHILD])
    expect(verified.checkedAllAncestry).toBe(true)
    expect(verified.verdict).toBe('NEEDS_REVIEW')
  })

  it('rejects credentials and unexpected manifest fields without leaking them', async () => {
    const invalid = { ...manifest(), apiKey: 'secret-provider-token' }
    const out = await inspectEnsv2({ client: mock().io, manifest: invalid })
    expect(codes(out)).toContain('INVALID_MANIFEST')
    expect(JSON.stringify(out)).not.toContain('secret-provider-token')
  })

  it('requires explicit proxy implementation address/hash and warns of proxy admin', async () => {
    const unpinned = await inspectEnsv2({ client: mock({ proxy: true }).io, manifest: manifest() })
    expect(codes(unpinned)).toContain('UNPINNED_PROXY_IMPLEMENTATION')
    const pinned = manifest()
    pinned.pins[1].implementation = { address: OP, codeHash: HASH }
    const out = await inspectEnsv2({ client: mock({ proxy: true, proxyAdmin: true }).io, manifest: pinned })
    expect(codes(out)).toContain('PROXY_ADMIN_PRESENT')
    expect(out.checkedAllAncestry).toBe(true)
  })

  it('returns a redacted NEEDS_REVIEW result on arbitrary ABI/provider errors', async () => {
    const result = await inspectEnsv2({ client: mock({ rpcError: true }).io, manifest: manifest() })
    expect(result).toMatchObject({ verdict: 'NEEDS_REVIEW', sovereignReceipt: false })
    expect(JSON.stringify(result)).not.toContain('privateSecretToken')
  })
})
