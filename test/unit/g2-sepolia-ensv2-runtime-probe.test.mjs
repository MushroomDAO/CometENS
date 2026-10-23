import { describe, it, expect } from 'vitest'
import { probeSepoliaEnsv2Runtime } from '../../scripts/probe-g2-sepolia-ensv2-runtime.mjs'
import { keccak256 } from 'viem'

const h = n => `0x${n.toString(16).padStart(64, '0')}`
function fixture() {
  const flags = { chain: false, code: false, slot: false, drift: false, stale: false, throwError: false }
  const now = BigInt(Math.floor(Date.now() / 1000))
  const client = {
    async getChainId() { return flags.chain ? 1 : 11155111 },
    async getBlock({ blockTag }) { return { number: 25n, hash: flags.drift && !blockTag ? h(9) : h(25),
      timestamp: flags.stale ? now - 8000n : now } },
    async getBytecode({ blockNumber }) { expect(blockNumber).toBe(25n); if (flags.throwError) throw Error('sensitive rpc url'); return flags.code ? '0x' : '0x60016000' },
    async getStorageAt({ blockNumber }) { expect(blockNumber).toBe(25n); return flags.slot ? undefined : h(0) },
  }
  return { client, flags }
}

describe('G2 Sepolia current ENSv2 deployment probe is observational only', () => {
  const pins = { rootRuntimeHash: keccak256('0x60016000'), ethRuntimeHash: keccak256('0x60016000') }
  it('matches independently supplied runtime pins but never certifies authority', async () => {
    const { client } = fixture()
    expect(await probeSepoliaEnsv2Runtime(client, pins)).toMatchObject({
      status: 'RPC_PINS_MATCHED_ONLY', runtimePinsMatched: true,
      deploymentIdentityVerified: false, nativeAuthorityVerified: false, sovereignReceipt: false,
    })
  })
  it('rejects mismatched root, ETH and invalid pins independently', async () => {
    const { client } = fixture()
    for (const field of ['rootRuntimeHash', 'ethRuntimeHash']) {
      expect(await probeSepoliaEnsv2Runtime(client, { ...pins, [field]: h(3) })).toMatchObject({ status: 'BLOCKED', reason: 'RUNTIME_HASH_MISMATCH' })
    }
    for (const invalid of [{ ...pins, rootRuntimeHash: h(0) }, { ...pins, extra: true }, {}]) {
      expect(await probeSepoliaEnsv2Runtime(client, invalid)).toMatchObject({ status: 'BLOCKED', reason: 'INVALID_PINS' })
    }
  })
  it('observes both official-address runtime hashes without claiming authority', async () => {
    const { client } = fixture()
    const r = await probeSepoliaEnsv2Runtime(client)
    expect(r.status).toBe('OBSERVED_ONLY')
    expect(r.contracts).toHaveLength(2)
    expect(r.contracts.every(x => x.runtimeHash.startsWith('0x'))).toBe(true)
    expect(r.deploymentIdentityVerified).toBe(false)
    expect(r.nativeAuthorityVerified).toBe(false)
    expect(r.sovereignReceipt).toBe(false)
  })
  it.each([
    ['wrong chain', 'chain', 'WRONG_CHAIN'],
    ['absent runtime', 'code', 'MISSING_CODE'],
    ['unknown implementation', 'slot', 'UNKNOWN_IMPLEMENTATION_SLOT'],
    ['historical hash drift', 'drift', 'FINALITY_CHANGED'],
    ['stale finalized block', 'stale', 'STALE_FINALITY'],
    ['RPC error redaction', 'throwError', 'RPC_UNVERIFIABLE'],
  ])('fails closed on %s', async (_, flag, expected) => {
    const { client, flags } = fixture()
    flags[flag] = true
    const r = await probeSepoliaEnsv2Runtime(client)
    expect(r).toMatchObject({ status: 'BLOCKED', reason: expected, sovereignReceipt: false })
    expect(JSON.stringify(r)).not.toContain('sensitive rpc url')
  })
})
