// Proof-mode CCIP-Read end-to-end check (Sepolia).
// viem auto-follows OffchainLookup -> gateway (Bedrock proof) -> resolveWithProof.
import { createPublicClient, http, encodeFunctionData, decodeFunctionResult, toHex } from 'viem'
import { sepolia } from 'viem/chains'

const RPC = process.env.SEPOLIA_RPC_URL
const RESOLVER = process.env.L1_OP_RESOLVER_ADDRESS
const NAME = process.argv[2] || 'aastar.eth'

function dnsEncode(name) {
  let out = '0x'
  for (const label of name.split('.')) {
    const b = Buffer.from(label)
    out += b.length.toString(16).padStart(2, '0') + b.toString('hex')
  }
  return out + '00'
}

const namehash = (await import('viem/ens')).namehash
const node = namehash(NAME)

const RESOLVE_ABI = [{
  type: 'function', name: 'resolve', stateMutability: 'view',
  inputs: [{ name: 'name', type: 'bytes' }, { name: 'data', type: 'bytes' }],
  outputs: [{ type: 'bytes' }],
}]
const ADDR_ABI = [{
  type: 'function', name: 'addr', stateMutability: 'view',
  inputs: [{ name: 'node', type: 'bytes32' }], outputs: [{ type: 'address' }],
}]

const client = createPublicClient({ chain: sepolia, transport: http(RPC, { timeout: 60_000 }) })

const addrCalldata = encodeFunctionData({ abi: ADDR_ABI, functionName: 'addr', args: [node] })

console.log(`[proof-e2e] resolving addr for ${NAME}`)
console.log(`  resolver: ${RESOLVER}`)
console.log(`  node:     ${node}`)

try {
  const result = await client.readContract({
    address: RESOLVER,
    abi: RESOLVE_ABI,
    functionName: 'resolve',
    args: [dnsEncode(NAME), addrCalldata],
    // ccipRead is enabled by default; viem follows OffchainLookup automatically
  })
  const addr = decodeFunctionResult({ abi: ADDR_ABI, functionName: 'addr', data: result })
  console.log(`\n✅ PROOF-MODE RESOLVE PASS`)
  console.log(`   ${NAME} addr = ${addr}`)
} catch (e) {
  console.log(`\n❌ resolve failed:`)
  console.log('   ' + (e.shortMessage || e.message || String(e)).slice(0, 500))
  if (e.cause?.message) console.log('   cause: ' + String(e.cause.message).slice(0, 300))
  process.exitCode = 1
}
