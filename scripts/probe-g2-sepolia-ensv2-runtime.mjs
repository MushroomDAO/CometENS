#!/usr/bin/env node
// Read-only deployment identity observation. Not ENS ownership or deployment approval.
import { pathToFileURL } from 'node:url'
import { readFile } from 'node:fs/promises'
import { createPublicClient, http, keccak256 } from 'viem'
import { sepolia } from 'viem/chains'
import { ROOT, ETH } from './inspect-ensv2-risk.mjs'

const HEX32 = /^0x[0-9a-fA-F]{64}$/
const EIP1967_IMPLEMENTATION = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const FAIL = (reason) => ({ status: 'BLOCKED', reason, chainId: 11155111,
  deploymentIdentityVerified: false, nativeAuthorityVerified: false, sovereignReceipt: false })

export async function probeSepoliaEnsv2Runtime(client, expectedPins = null) {
  try {
    if (expectedPins !== null && (!expectedPins || typeof expectedPins !== 'object' ||
      Array.isArray(expectedPins) || Object.keys(expectedPins).sort().join(',') !== 'ethRuntimeHash,rootRuntimeHash' ||
      !HEX32.test(expectedPins.rootRuntimeHash) || !HEX32.test(expectedPins.ethRuntimeHash) ||
      /^0x0+$/.test(expectedPins.rootRuntimeHash) || /^0x0+$/.test(expectedPins.ethRuntimeHash))) return FAIL('INVALID_PINS')
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
      const runtimeHash = keccak256(code)
      if (expectedPins && runtimeHash.toLowerCase() !==
        (address === ROOT ? expectedPins.rootRuntimeHash : expectedPins.ethRuntimeHash).toLowerCase()) return FAIL('RUNTIME_HASH_MISMATCH')
      const impl = await client.getStorageAt({ address, slot: EIP1967_IMPLEMENTATION, blockNumber: at })
      if (!HEX32.test(impl ?? '')) return FAIL('UNKNOWN_IMPLEMENTATION_SLOT')
      contracts.push({ address, runtimeHash, implementationSlot: impl })
    }
    if (await client.getChainId() !== 11155111) return FAIL('CHAIN_CHANGED')
    const again = await client.getBlock({ blockNumber: at })
    const finalAgain = await client.getBlock({ blockTag: 'finalized' })
    if (again.hash?.toLowerCase() !== finalized.hash.toLowerCase() ||
      finalAgain.number < at || !HEX32.test(finalAgain.hash ?? '')) return FAIL('FINALITY_CHANGED')
    return { status: expectedPins ? 'RPC_PINS_MATCHED_ONLY' : 'OBSERVED_ONLY', chainId: 11155111,
      finalized: { number: at.toString(), hash: finalized.hash, timestamp: finalized.timestamp.toString() },
      contracts, runtimePinsMatched: Boolean(expectedPins), deploymentIdentityVerified: false, nativeAuthorityVerified: false,
      sovereignReceipt: false, note: 'Runtime hashes are observations, NOT independently pinned identity or ENS ownership' }
  } catch { return FAIL('RPC_UNVERIFIABLE') }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rpc = process.env.COMETENS_SEPOLIA_RPC_URL
  let valid = false
  try { const u = new URL(rpc); valid = u.protocol === 'https:' && !u.username && !u.password } catch { /* no secret logging */ }
  const pinFile = process.argv[2] === '--pins' && process.argv.length === 4 ? process.argv[3] : null
  if (!valid || (process.argv.length !== 2 && !pinFile)) {
    process.stderr.write('Sepolia ENSv2 runtime probe BLOCKED: provide HTTPS COMETENS_SEPOLIA_RPC_URL, no wallet needed.\n')
    process.exitCode = 2
  } else {
    let pins = null
    if (pinFile) {
      try {
        const bytes = await readFile(pinFile)
        if (bytes.length > 4096) throw Error('oversized pins')
        pins = JSON.parse(bytes.toString())
      } catch { process.stderr.write('Sepolia ENSv2 runtime probe BLOCKED: invalid public pins file.\n'); process.exit(2) }
    }
    const result = await probeSepoliaEnsv2Runtime(createPublicClient({ chain: sepolia, transport: http(rpc, { retryCount: 0 }) }), pins)
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    if (result.status !== 'OBSERVED_ONLY' && result.status !== 'RPC_PINS_MATCHED_ONLY') process.exitCode = 2
  }
}
