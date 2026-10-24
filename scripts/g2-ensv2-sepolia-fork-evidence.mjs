#!/usr/bin/env node
/** Offline-safe live ENSv2 runtime identity gate; no signing or broadcasting. */
import { createPublicClient, http, keccak256, toHex } from 'viem'
import { sepolia } from 'viem/chains'
import { ROOT, ETH, ABI } from './inspect-ensv2-risk.mjs'

const HEX32 = /^0x[0-9a-fA-F]{64}$/
const ZERO = '0x0000000000000000000000000000000000000000'
const IMPL = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const BEACON = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50'
const deny = (reason) => ({ verdict: 'DENY', reason, ensv2Proven: false })

/** Only pinned, finalized, coherent runtime is eligible for subsequent fork work. */
export async function verifySepoliaRuntime({ client, pins }) {
  if (!pins || Object.keys(pins).sort().join(',') !== ['eth', 'root'].join(',') ||
      ![pins.root, pins.eth].every(p => p && HEX32.test(p.codeHash) &&
        (!p.implementation || (/^0x[0-9a-fA-F]{40}$/.test(p.implementation.address) &&
          HEX32.test(p.implementation.codeHash))))) return deny('MISSING_VERIFIED_PIN')
  try {
    if (await client.getChainId() !== 11155111) return deny('WRONG_CHAIN')
    const block = await client.getBlock({ blockTag: 'finalized' })
    if (!block?.hash || typeof block.number !== 'bigint') return deny('NO_FINALIZED_BLOCK')
    for (const [key, address] of [['root', ROOT], ['eth', ETH]]) {
      const code = await client.getBytecode({ address, blockNumber: block.number })
      if (!code || keccak256(code).toLowerCase() !== pins[key].codeHash.toLowerCase()) return deny('RUNTIME_HASH_MISMATCH_' + key)
      const impl = await client.getStorageAt({ address, slot: IMPL, blockNumber: block.number })
      if (!HEX32.test(impl ?? '')) return deny('MISSING_IMPLEMENTATION_SLOT')
      const beacon = await client.getStorageAt({ address, slot: BEACON, blockNumber: block.number })
      if (!HEX32.test(beacon ?? '') || '0x' + beacon.slice(-40).toLowerCase() !== ZERO)
        return deny('BEACON_PROXY_UNVERIFIED_' + key)
      const addr = '0x' + impl.slice(-40)
      if (addr.toLowerCase() !== ZERO) {
        const pin = pins[key].implementation
        if (!pin || pin.address.toLowerCase() !== addr.toLowerCase()) return deny('IMPLEMENTATION_MISMATCH_' + key)
        const implementation = await client.getBytecode({ address: addr, blockNumber: block.number })
        if (!implementation || keccak256(implementation).toLowerCase() !== pin.codeHash.toLowerCase())
          return deny('IMPLEMENTATION_HASH_MISMATCH_' + key)
      } else if (pins[key].implementation) return deny('UNEXPECTED_IMPLEMENTATION_' + key)
    }
    const forward = await client.readContract({ address: ROOT, abi: ABI, functionName: 'getSubregistry', args: ['eth'], blockNumber: block.number })
    const backward = await client.readContract({ address: ETH, abi: ABI, functionName: 'getParent', blockNumber: block.number })
    if (forward.toLowerCase() !== ETH || backward[0].toLowerCase() !== ROOT || backward[1] !== 'eth')
      return deny('HIERARCHY_CHANGED')
    return { verdict: 'RUNTIME_PIN_MATCH', ensv2Proven: false, blockNumber: block.number.toString(), blockHash: block.hash }
  } catch { return deny('RPC_OR_ABI_ERROR') }
}

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
  const rpc = process.env.COMETENS_SEPOLIA_RPC_URL
  const pinsPath = process.argv[2]
  let result = deny('RPC_OR_PIN_MISSING')
  if (rpc && pinsPath) {
    try {
      const { readFile } = await import('node:fs/promises')
      const pins = JSON.parse(await readFile(pinsPath, 'utf8'))
      result = await verifySepoliaRuntime({ client: createPublicClient({ chain: sepolia, transport: http(rpc) }), pins })
    } catch { result = deny('INVALID_PIN_FILE_OR_RPC') }
  }
  process.stdout.write(JSON.stringify(result) + '\n')
  if (result.verdict !== 'RUNTIME_PIN_MATCH') process.exitCode = 1
}
