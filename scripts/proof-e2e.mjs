// Proof-mode CCIP-Read end-to-end check (Sepolia).
// viem auto-follows OffchainLookup -> gateway (Bedrock proof) -> resolveWithProof.
//
// Usage: node scripts/proof-e2e.mjs [name] [expectedAddr]
//   expectedAddr — if given, the script exits 1 unless the resolved addr matches.
// Note: gateway ALLOWED_SENDERS (allowlist) enforcement is covered by test/unit/gateway
// tests; this script exercises the live finalized-proof resolution path end-to-end.
import { createPublicClient, http, encodeFunctionData, decodeFunctionResult, toHex } from 'viem'
import { sepolia } from 'viem/chains'

const RPC = process.env.SEPOLIA_RPC_URL
const RESOLVER = process.env.L1_OP_RESOLVER_ADDRESS
const NAME = process.argv[2] || 'aastar.eth'
// Optional: assert the resolved address equals this (exit 1 on mismatch) — makes
// the script a real pass/fail check rather than a "did not throw" smoke test.
const EXPECT = (process.argv[3] || '').toLowerCase()

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
  if (EXPECT && addr.toLowerCase() !== EXPECT) {
    console.log(`\n❌ PROOF-MODE RESOLVE MISMATCH`)
    console.log(`   ${NAME} addr = ${addr}`)
    console.log(`   expected   = ${EXPECT}`)
    process.exitCode = 1
  } else {
    console.log(`\n✅ PROOF-MODE RESOLVE PASS`)
    console.log(`   ${NAME} addr = ${addr}${EXPECT ? ' (matches expected)' : ''}`)
  }
} catch (e) {
  console.log(`\n❌ resolve failed:`)
  console.log('   ' + (e.shortMessage || e.message || String(e)).slice(0, 500))
  if (e.cause?.message) console.log('   cause: ' + String(e.cause.message).slice(0, 300))
  process.exitCode = 1
}
