import { describe, it, expect } from 'vitest'
import { keccak256 } from 'viem'
import { verifySepoliaRuntime } from '../../scripts/g2-ensv2-sepolia-fork-evidence.mjs'
import { ROOT, ETH } from '../../scripts/inspect-ensv2-risk.mjs'

const bytecode = '0x60006000'
const pin = { codeHash: keccak256(bytecode) }
const pins = { root: pin, eth: pin }
const zeroSlot = '0x' + '0'.repeat(64)
function fixture(override = {}) {
  return {
    getChainId: async () => override.chain ?? 11155111,
    getBlock: async () => ({ number: 100n, hash: '0x' + 'a'.repeat(64) }),
    getBytecode: async ({ address }) => override.badAddress === address ? '0x6001' : bytecode,
    getStorageAt: async () => override.slot ?? zeroSlot,
    readContract: async ({ address, functionName, blockNumber }) => {
      if (blockNumber !== 100n) throw Error('inconsistent block')
      if (override.badHierarchy) return address === ROOT ? ROOT : [ETH, 'eth']
      return functionName === 'getSubregistry' ? ETH : [ROOT, 'eth']
    },
  }
}
describe('ENSv2 Sepolia real-runtime provenance gate (no RPC fixture means no proof)', () => {
  it('refuses absent independently verified artifact pins', async () => {
    expect((await verifySepoliaRuntime({ client: fixture(), pins: undefined })).reason).toBe('MISSING_VERIFIED_PIN')
  })
  it('rejects wrong network, runtime mutation and registry migration', async () => {
    expect((await verifySepoliaRuntime({ client: fixture({ chain: 1 }), pins })).reason).toBe('WRONG_CHAIN')
    expect((await verifySepoliaRuntime({ client: fixture({ badAddress: ETH }), pins })).reason).toBe('RUNTIME_HASH_MISMATCH_eth')
    expect((await verifySepoliaRuntime({ client: fixture({ badHierarchy: true }), pins })).reason).toBe('HIERARCHY_CHANGED')
  })
  it('rejects proxy implementation without an independently pinned hash', async () => {
    const slot = '0x' + '0'.repeat(24) + '1234567890123456789012345678901234567890'
    expect((await verifySepoliaRuntime({ client: fixture({ slot }), pins })).reason).toBe('IMPLEMENTATION_MISMATCH_root')
  })
  it('even matching synthetic runtime cannot imply member sovereignty', async () => {
    const result = await verifySepoliaRuntime({ client: fixture(), pins })
    expect(result.verdict).toBe('RUNTIME_PIN_MATCH')
    expect(result.ensv2Proven).toBe(false)
    expect(result.blockNumber).toBe('100')
  })
})
