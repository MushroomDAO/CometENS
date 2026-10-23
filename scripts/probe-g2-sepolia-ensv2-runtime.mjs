#!/usr/bin/env node
// Read-only deployment identity observation. Not ENS ownership or deployment approval.
import { pathToFileURL } from 'node:url'
import { createPublicClient, http, keccak256 } from 'viem'
import { sepolia } from 'viem/chains'
import { ROOT, ETH } from './inspect-ensv2-risk.mjs'

const HEX32 = /^0x[0-9a-fA-F]{64}$/
const EIP1967_IMPLEMENTATION = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const FAIL = (reason) => ({ status: 'BLOCKED', reason, chainId: 11155111,
  deploymentIdentityVerified: false, nativeAuthorityVerified: false, sovereignReceipt: false })

export async function probeSepoliaEnsv2Runtime(client) {
  try {
    if (await client.getChainId() !== 11155111) return FAIL('WRONG_CHAIN')
    const finalized = await client.getBlock({ blockTag: 'finalized' })
    if (typeof finalized.number !== 'bigint' || !HEX32.test(finalized.hash ?? '') ||
      typeof finalized.timestamp !== 'bigint' || finalized.timestamp < 0n) return FAIL('BAD_FINALIZED_HEADER')
    const now = BigInt(Math.floor(Date.now() / 1000))
    if (finalized.timestamp > now + 120n || now - finalized.timestamp > 7200n) return FAIL('STALE_FINALITY')
    const at = finalized.number
    const addresses = [ROOT, ETH]
    const contracts = []
    for (const address of addresses) {
      const code = await client.getBytecode({ address, blockNumber: at })
      if (!code || !/^0x(?:[0-9a-fA-F]{2})+$/.test(code)) return FAIL('MISSING_CODE')
      const impl = await client.getStorageAt({ address, slot: EIP1967_IMPLEMENTATION, blockNumber: at })
      if (!HEX32.test(impl ?? '')) return FAIL('UNKNOWN_IMPLEMENTATION_SLOT')
      contracts.push({ address, runtimeHash: keccak256(code), implementationSlot: impl })
    }
    if (await client.getChainId() !== 11155111) return FAIL('CHAIN_CHANGED')
    const again = await client.getBlock({ blockNumber: at })
    const finalAgain = await client.getBlock({ blockTag: 'finalized' })
    if (again.hash?.toLowerCase() !== finalized.hash.toLowerCase() ||
      finalAgain.number < at || !HEX32.test(finalAgain.hash ?? '')) return FAIL('FINALITY_CHANGED')
    return { status: 'OBSERVED_ONLY', chainId: 11155111,
      finalized: { number: at.toString(), hash: finalized.hash, timestamp: finalized.timestamp.toString() },
      contracts, deploymentIdentityVerified: false, nativeAuthorityVerified: false,
      sovereignReceipt: false, note: 'Runtime hashes are observations, NOT independently pinned identity or ENS ownership' }
  } catch { return FAIL('RPC_UNVERIFIABLE') }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rpc = process.env.COMETENS_SEPOLIA_RPC_URL
  let valid = false
  try { const u = new URL(rpc); valid = u.protocol === 'https:' && !u.username && !u.password } catch { /* no secret logging */ }
  if (!valid || process.argv.length !== 2) {
    process.stderr.write('Sepolia ENSv2 runtime probe BLOCKED: provide HTTPS COMETENS_SEPOLIA_RPC_URL, no wallet needed.\n')
    process.exitCode = 2
  } else {
    const result = await probeSepoliaEnsv2Runtime(createPublicClient({ chain: sepolia, transport: http(rpc, { retryCount: 0 }) }))
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    if (result.status !== 'OBSERVED_ONLY') process.exitCode = 2
  }
}
