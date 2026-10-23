import { describe, it, expect } from 'vitest'
import { checkSepoliaRegistration } from '../../scripts/check-g2-sepolia-ensv2-registration.mjs'

const wallet = '0xF7Bf79AcB7F3702b9DbD397d8140ac9DE6Ce642C'
const hash = `0x${'ab'.repeat(32)}`
function fixture() {
  const flags = { wrongChain: false, missingCode: false, drift: false, registered: false, badState: false, error: false }
  const client = {
    async getChainId() { return flags.wrongChain ? 1 : 11155111 },
    async getBlock({ blockNumber }) { return { number: 1234n, hash: flags.drift && blockNumber ? `0x${'cd'.repeat(32)}` : hash, timestamp: BigInt(Math.floor(Date.now()/1000)) } },
    async getBytecode({ blockNumber }) { expect(blockNumber).toBe(1234n); return flags.missingCode ? '0x' : '0x6001' },
    async getBalance({ blockNumber }) { expect(blockNumber).toBe(1234n); return 2000000000000000000n },
    async readContract({ functionName, blockNumber }) {
      expect(blockNumber).toBe(1234n)
      if (flags.error) throw Error('private-rpc-token')
      if (functionName === 'balanceOf') return 0n
      return flags.badState ? { status: 'bad', expiry: 0n, latestOwner: wallet } :
        { status: flags.registered ? 2 : 0, expiry: flags.registered ? 9999999999n : 0n,
          latestOwner: flags.registered ? wallet : '0x0000000000000000000000000000000000000000' }
    },
  }
  return { client, flags }
}

describe('Sepolia ENSv2 first-parent read-only registration preflight', () => {
  it('reports unregistered state only, not registrar availability or rights', async () => {
    const { client } = fixture()
    const r = await checkSepoliaRegistration({ client, wallet, labels: ['cometens-g2-20261023'] })
    expect(r).toMatchObject({ verdict: 'READ_ONLY_SNAPSHOT', registrationAvailableVerified: false,
      nativeAuthorityVerified: false, sovereignReceipt: false, mockUsdcBaseUnits: '0' })
    expect(r.names[0].unregisteredSnapshot).toBe(true)
  })
  it('does not misreport an existing name as available', async () => {
    const { client, flags } = fixture(); flags.registered = true
    const r = await checkSepoliaRegistration({ client, wallet, labels: ['cometens-g2-20261023'] })
    expect(r.names[0].unregisteredSnapshot).toBe(false)
    expect(r.registrationAvailableVerified).toBe(false)
  })
  it.each([
    ['wrong network', 'wrongChain', 'WRONG_CHAIN'],
    ['missing official contract', 'missingCode', 'OFFICIAL_CONTRACT_CODE_MISSING'],
    ['finalized reorg', 'drift', 'FINALIZED_BLOCK_CHANGED'],
    ['invalid ABI result', 'badState', 'INVALID_ENSV2_STATE'],
    ['RPC failure', 'error', 'RPC_OR_ABI_UNVERIFIABLE'],
  ])('fails closed: %s', async (_name, key, reason) => {
    const { client, flags } = fixture(); flags[key] = true
    const r = await checkSepoliaRegistration({ client, wallet, labels: ['cometens-g2-20261023'] })
    expect(r).toMatchObject({ verdict: 'BLOCKED', reason, sovereignReceipt: false })
    expect(JSON.stringify(r)).not.toContain('private-rpc-token')
  })
  it('rejects unsound input and invalid labels', async () => {
    const { client } = fixture()
    for (const labels of [[], ['--bad'], ['UPPER'], ['valid', 'bad--label'], new Array(6).fill('valid')]) {
      const r = await checkSepoliaRegistration({ client, wallet, labels })
      expect(r).toMatchObject({ verdict: 'BLOCKED', reason: 'INVALID_INPUT' })
    }
  })
})
