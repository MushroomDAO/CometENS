import { describe, expect, it, vi } from 'vitest'
import { keccak256 } from 'viem'
import { ETH, ROOT } from '../../scripts/inspect-ensv2-risk.mjs'
import { monitorEnsv2L1 } from '../../scripts/monitor-g2-ensv2-l1.mjs'

const code = '0x6001600055'
const codeHash = keccak256(code)
const zero = `0x${'00'.repeat(32)}`
const hashA = `0x${'12'.repeat(32)}`
const hashB = `0x${'34'.repeat(32)}`
const ownerA = '0x1111111111111111111111111111111111111111'
const ownerB = '0x2222222222222222222222222222222222222222'
const operator = '0x3333333333333333333333333333333333333333'
const now = BigInt(Math.floor(Date.now() / 1000))
const manifest = () => ({
  chainId: 11155111, name: 'alice.eth', rootRegistry: ROOT, ethRegistry: ETH,
  pins: [{ address: ROOT, codeHash }, { address: ETH, codeHash }],
  operators: [operator],
})

function mock(config = {}) {
  const calls = []
  const height = config.height ?? 100n
  const hash = config.hash ?? hashA
  const timestamp = config.timestamp ?? now - 30n
  let finalizedReads = 0
  const client = {
    calls,
    async getChainId() { calls.push(['chain']); return config.chainId ?? 11155111 },
    async getBlock(arg) {
      calls.push(['block', arg])
      if (arg.blockTag === 'finalized') {
        finalizedReads++
        const second = finalizedReads > 1
        return { number: second ? (config.secondFinalizedHeight ?? height) : height,
          hash: second ? (config.secondFinalizedHash ?? hash) : hash, timestamp }
      }
      expect(arg).toEqual({ blockNumber: height })
      return { number: config.returnedHeight ?? height, hash: config.returnedHash ?? hash,
        timestamp: config.returnedTime ?? timestamp }
    },
    async getBytecode({ address, blockNumber }) {
      calls.push(['code', address, blockNumber])
      if (config.rpcError) throw new Error('SECRET_RPC_CREDENTIAL_SHOULD_NOT_LEAK')
      return config.badCode && address.toLowerCase() === ETH ? '0x6000' : code
    },
    async getStorageAt({ address, blockNumber, slot }) {
      calls.push(['storage', address, blockNumber])
      if (config.proxyAdmin && address.toLowerCase() === ETH && !slot.startsWith('0x360894')) {
        return `0x${'00'.repeat(12)}${ownerB.slice(2)}`
      }
      return zero
    },
    async readContract({ address, functionName, args, blockNumber }) {
      calls.push(['read', address, blockNumber, functionName])
      if (config.rpcError) throw new Error('SECRET_RPC_CREDENTIAL_SHOULD_NOT_LEAK')
      const isEth = address.toLowerCase() === ETH
      switch (functionName) {
        case 'getState': return {
          status: 2, expiry: config.expiry ?? now + 5000n,
          latestOwner: isEth ? (config.owner ?? ownerA) : ownerA,
          tokenId: 55n, resource: 66n,
        }
        case 'getResource': return 66n
        case 'roleCount': return args[0] === 0n && isEth ? (config.rootRole ?? 0n) : 0n
        case 'roles': return args[1] === operator ? (config.delegatedRole ?? 0n) : 1n
        case 'isApprovedForAll': return config.approved ?? false
        case 'isEmancipated': return true
        case 'getSubregistry': return isEth ? ownerB : ETH
        case 'getParent': return [ROOT, 'eth']
      }
      throw new Error('unknown function')
    },
  }
  return client
}

describe('G2 ENSv2 Sepolia finalized observer, always NEEDS_REVIEW', () => {
  it('returns only a finalized-RPC baseline, with no L1 or OP privilege', async () => {
    const client = mock()
    const result = await monitorEnsv2L1({ client, manifest: manifest() })
    expect(result).toMatchObject({
      status: 'BASELINE', changes: [], verdict: 'NEEDS_REVIEW',
      sovereignReceipt: false, opControllerAuthorityVerified: false,
      monitorCompleteness: 'POLLING_ONLY', evidenceLevel: 'FINALIZED_RPC_OBSERVATION_ONLY',
      cursor: { chainId: 11155111, name: 'alice.eth', block: { number: '100', hash: hashA } },
    })
    expect(result.cursor.visited).toHaveLength(2)
    expect(result.cursor.findings.some(f => f.code === 'APPROVAL_ENUMERATION_INCOMPLETE')).toBe(true)
    expect(client.calls.filter(x => x[0] === 'block')).toHaveLength(3)
    expect(client.calls.filter(x => ['code', 'storage', 'read'].includes(x[0])).every(x => x[2] === 100n)).toBe(true)
  })

  it('reports new finalized ENSv2 owner/EAC roles, admin risk and sampled delegated approvals', async () => {
    const old = (await monitorEnsv2L1({ client: mock(), manifest: manifest() })).cursor
    const unchanged = await monitorEnsv2L1({ client: mock({ height: 101n, hash: hashB }),
      manifest: manifest(), previous: old })
    expect(unchanged.status).toBe('UNCHANGED')
    const newRoles = await monitorEnsv2L1({ client: mock({
      height: 101n, hash: hashB, owner: ownerB, rootRole: 1n << (124n + 128n),
      delegatedRole: 1n << 24n, approved: true,
    }), manifest: manifest(), previous: old })
    expect(newRoles.status).toBe('AT_RISK')
    expect(newRoles.changes).toEqual(expect.arrayContaining([
      'visited[1].owner', 'visited[1].rootRoles', 'visited[1].approvals', 'findings',
    ]))
    expect(newRoles.cursor.findings.map(f => f.code)).toContain('DANGEROUS_ROOT_ROLE')
    expect(newRoles.cursor.findings.map(f => f.code)).toContain('INHERITED_ERC1155_APPROVAL')
    expect(newRoles.sovereignReceipt).toBe(false)
  })

  it('detects expired ENSv2 names without any event or newer finalized block', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Number(now * 1000n))
    try {
      const old = (await monitorEnsv2L1({
        client: mock({ expiry: now + 100n }), manifest: manifest(),
      })).cursor
      clock.mockReturnValue(Number((now + 200n) * 1000n))
      const expiry = await monitorEnsv2L1({
        client: mock({ expiry: now + 100n }), manifest: manifest(), previous: old,
      })
      expect(expiry.status).toBe('AT_RISK')
      expect(expiry.changes).toEqual(['findings'])
      expect(expiry.cursor.findings.map(f => f.code)).toContain('NAME_NOT_ACTIVE')
    } finally { clock.mockRestore() }
  })

  it('refuses conflicting previous finalized hash, rollback or same-block owner mutation', async () => {
    const old = (await monitorEnsv2L1({ client: mock(), manifest: manifest() })).cursor
    for (const cfg of [
      { height: 99n, hash: hashB },
      { height: 100n, hash: hashB },
      { height: 100n, owner: ownerB },
      { height: 100n, proxyAdmin: true },
    ]) {
      await expect(monitorEnsv2L1({ client: mock(cfg), manifest: manifest(), previous: old }))
        .rejects.toMatchObject({ code: 'finalized-conflict' })
    }
  })

  it('rejects inconsistent finalized-source/block identity', async () => {
    for (const cfg of [
      { returnedHeight: 105n },
      { returnedHash: hashB },
      { returnedTime: now },
      { secondFinalizedHeight: 99n },
      { secondFinalizedHash: hashB },
    ]) {
      await expect(monitorEnsv2L1({ client: mock(cfg), manifest: manifest() }))
        .rejects.toMatchObject({ code: 'unstable-finalized-block' })
    }
  })

  it('rejects wrong ENSv2 deployment, source RPC or missing pinned implementation', async () => {
    for (const [client, profile] of [
      [mock({ chainId: 1 }), manifest()],
      [mock({ badCode: true }), manifest()],
      [mock(), { ...manifest(), rootRegistry: ownerB }],
      [mock(), { ...manifest(), pins: [manifest().pins[0]] }],
    ]) {
      await expect(monitorEnsv2L1({ client, manifest: profile }))
        .rejects.toMatchObject({ code: 'incomplete-finalized-source' })
    }
  })

  it('fails closed if an earlier cursor is reused for a different name/manifest or has malformed fields', async () => {
    const prior = (await monitorEnsv2L1({ client: mock(), manifest: manifest() })).cursor
    for (const changed of [
      { ...prior, name: 'bob.eth' },
      { ...prior, manifestHash: hashB },
      { ...prior, block: { ...prior.block, hash: 'bad' } },
      { ...prior, visited: [{ ...prior.visited[0], expiry: 'Infinity' }] },
    ]) {
      await expect(monitorEnsv2L1({ client: mock(), manifest: manifest(), previous: changed }))
        .rejects.toMatchObject({ code: 'invalid-previous' })
    }
    await expect(monitorEnsv2L1({ client: mock(), manifest: { ...manifest(), operators: [] },
      previous: prior })).rejects.toMatchObject({ code: 'invalid-previous' })
  })

  it('never propagates upstream provider errors or exposes URL credentials', async () => {
    try {
      await monitorEnsv2L1({ client: mock({ rpcError: true }), manifest: manifest() })
      throw new Error('expected a rejection')
    } catch (error) {
      expect(error).toMatchObject({ code: 'incomplete-finalized-source' })
      expect(error.message).not.toContain('SECRET')
    }
  })
})
