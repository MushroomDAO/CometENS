import { describe, expect, it } from 'vitest'
import { probeMemberAutonomy } from '../../scripts/probe-ensv2-member-autonomy.mjs'

const registry = '0x1111111111111111111111111111111111111111'
const member = '0x2222222222222222222222222222222222222222'
const resolver = '0x3333333333333333333333333333333333333333'
const input = { chainId: 11155111, registry, label: 'alice', member, resolver, blockNumber: 100n }

function fixture(changes = {}) {
  const state = { status: 2, expiry: 2000n, latestOwner: member, tokenId: 1n, resource: 2n,
    ...changes.state }
  const values = { getState: state, getResolver: resolver, isEmancipated: true, roleCount: 0n, ...changes.values }
  return { getChainId: async () => changes.chainId ?? 11155111,
    getBytecode: async () => changes.code ?? '0x6000',
    getBlock: async () => ({ timestamp: changes.timestamp ?? 1000n }),
    readContract: async ({ functionName, blockNumber }) => {
      if (blockNumber !== 100n) throw Error('mixed snapshot')
      if (changes.fail === functionName) throw Error('RPC reverted')
      return values[functionName]
    } }
}

async function result(changes) { return probeMemberAutonomy({ ...input, client: fixture(changes) }) }

describe('ENSv2 member resolver autonomy: negative-only snapshot evidence', () => {
  it('never promotes even clean snapshot into exclusive sovereign claim', async () => {
    const r = await result()
    expect(r.sovereignReceipt).toBe(false)
    expect(r.findings).toContain('RESOLVER_EAC_AND_RECORDS_UNVERIFIED')
  })
  it('detects transfer to a parent/admin controlled holder', async () => {
    expect((await result({ state: { latestOwner: registry } })).reason).toBe('TRANSFER_EXPIRY_OR_REREGISTRATION')
  })
  it('detects expiry exactly at the sampled block', async () => {
    expect((await result({ state: { expiry: 1000n } })).reason).toBe('EXPIRED')
  })
  it('detects re-registration or migration to a reserved state', async () => {
    expect((await result({ state: { status: 1 } })).reason).toBe('TRANSFER_EXPIRY_OR_REREGISTRATION')
  })
  it('detects changed resolver pointer', async () => {
    expect((await result({ values: { getResolver: registry } })).reason).toBe('RESOLVER_POINTER_CHANGED')
  })
  it('reports EAC root resolver, subregistry, unregister, upgrade administrators', async () => {
    for (const bit of [8n, 12n, 20n, 24n, 124n]) {
      const r = await result({ values: { roleCount: 1n << (bit + 128n) } })
      expect(r.findings).toContain('ROOT_EAC_OVERRIDE_AVAILABLE')
    }
  })
  it('reports dangerous regular role even if emancipation flag claims true', async () => {
    for (const bit of [8n, 24n]) {
      expect((await result({ values: { roleCount: 1n << bit } })).findings).toContain('ROOT_EAC_OVERRIDE_AVAILABLE')
    }
  })
  it('fails closed on unknown runtime or any RPC/ABI error', async () => {
    expect((await result({ code: '0x' })).reason).toBe('NO_REGISTRY_CODE')
    expect((await result({ fail: 'getState' })).reason).toBe('RPC_OR_ABI_FAILURE')
    expect((await result({ chainId: 1 })).reason).toBe('CHAIN_MISMATCH')
  })
})
