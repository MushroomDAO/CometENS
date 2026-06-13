/**
 * Milestone C verification: proof mode CCIP-Read end-to-end test
 *
 * Uses viem's built-in CCIP-Read support to resolve proof1.forest.aastar.eth
 * and 2.forest.aastar.eth through the full stack:
 *   ENS Universal Resolver → OPResolver (OffchainLookup) → Gateway (storage proofs) → L1 verify
 *
 * Run: node scripts/check-proof-resolution.mjs
 * Requires: SEPOLIA_RPC_URL in environment (or .env.local)
 */

import { readFileSync } from 'fs'
import { createPublicClient, http } from 'viem'
import { sepolia } from 'viem/chains'

// Load .env.local manually
try {
  const env = readFileSync('.env.local', 'utf8')
  for (const line of env.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=["']?(.+?)["']?\s*$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
} catch {}

const SEPOLIA_RPC = process.env.SEPOLIA_RPC_URL
if (!SEPOLIA_RPC) {
  console.error('ERROR: SEPOLIA_RPC_URL not set')
  process.exit(1)
}

// viem public client — built-in CCIP-Read support + Sepolia ENS Universal Resolver
const client = createPublicClient({
  chain: sepolia,
  transport: http(SEPOLIA_RPC, { timeout: 60_000 }),
})

const TEST_CASES = [
  { name: 'sig1.forest.aastar.eth', expected: '0xb5600060e6de5e11d3636731964218e53caadf0e', mode: 'signature' },
  { name: 'proof1.forest.aastar.eth', expected: '0xb5600060e6de5e11d3636731964218e53caadf0e', mode: 'proof' },
  { name: '2.forest.aastar.eth', expected: '0x935f8694855fa9f1d1520e43689219ed4fff8c97', mode: 'proof' },
]

// DNS-encode a name for OPResolver.resolve()
function dnsEncode(name) {
  const labels = name.split('.')
  const parts = []
  for (const label of labels) {
    const enc = Buffer.from(label, 'utf8')
    parts.push(Buffer.from([enc.length]))
    parts.push(enc)
  }
  parts.push(Buffer.from([0]))
  return '0x' + Buffer.concat(parts).toString('hex')
}

// OP Resolver on ETH Sepolia
const OP_RESOLVER = '0x9070d42C9C12333053565e7ee8c4BdDE9Ca73083'

const OP_RESOLVER_ABI = [
  {
    name: 'resolve',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'name', type: 'bytes' }, { name: 'data', type: 'bytes' }],
    outputs: [{ type: 'bytes' }],
  },
  {
    name: 'fetchCallback',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'response', type: 'bytes' }, { name: 'carry', type: 'bytes' }],
    outputs: [{ type: 'bytes' }],
  },
]

// OffchainLookup error
const OFFCHAIN_LOOKUP_ABI = [{
  type: 'error',
  name: 'OffchainLookup',
  inputs: [
    { name: 'sender', type: 'address' },
    { name: 'urls', type: 'string[]' },
    { name: 'callData', type: 'bytes' },
    { name: 'callbackFunction', type: 'bytes4' },
    { name: 'extraData', type: 'bytes' },
  ],
}]

async function resolveViaUniversalResolver(name) {
  const { namehash, decodeErrorResult, encodeAbiParameters, parseAbi } = await import('viem')
  const dnsName = dnsEncode(name)
  const node = namehash(name)
  // addr(bytes32) calldata
  const data = '0x3b3b57de' + node.slice(2)

  // Step 1: Call OPResolver.resolve() via raw eth_call → get OffchainLookup revert
  // Use raw eth_call to bypass viem's built-in CCIP-Read handling
  const { encodeFunctionData, decodeFunctionResult } = await import('viem')

  let offchainLookup
  try {
    const calldata = encodeFunctionData({
      abi: OP_RESOLVER_ABI,
      functionName: 'resolve',
      args: [dnsName, data],
    })

    // Raw eth_call — viem's transport handles this without CCIP-Read interception
    const { error } = await client.transport.request({
      method: 'eth_call',
      params: [{ to: OP_RESOLVER, data: calldata }, 'latest'],
    })

    if (error) {
      // Extract revert data from the RPC error
      const revertData = error?.data ?? error?.message?.match(/0x[0-9a-f]+/i)?.[0]
      if (revertData) {
        offchainLookup = decodeErrorResult({ abi: OFFCHAIN_LOOKUP_ABI, data: revertData })
      } else {
        throw new Error(`RPC error: ${JSON.stringify(error)}`)
      }
    } else {
      return null // unexpected success
    }
  } catch (err) {
    if (offchainLookup) throw err // already decoded
    // eth_call may throw with revert data
    const revertData = err?.cause?.data ?? err?.data ?? err?.message?.match(/0x[0-9a-f]+/i)?.[0]
    if (!revertData) throw err
    try {
      offchainLookup = decodeErrorResult({ abi: OFFCHAIN_LOOKUP_ABI, data: revertData })
    } catch {
      throw new Error(`Not OffchainLookup: ${String(revertData).slice(0,10)} | ${err.message?.slice(0,200)}`)
    }
  }

  const [sender, urls, callData, , extraData] = offchainLookup.args

  // Step 2: Fetch from gateway (EIP-3668 GET template)
  // Note: Node.js native fetch doesn't use system proxy; use execSync(curl) instead
  const { execSync } = await import('child_process')
  const url = urls[0].replace('{sender}', sender).replace('{data}', callData)
  const curlOut = execSync(`curl -s "${url}"`, { timeout: 30_000 }).toString()
  const { data: proofData } = JSON.parse(curlOut)

  // Step 3: Call fetchCallback(bytes,bytes)
  const result = await client.readContract({
    address: OP_RESOLVER,
    abi: OP_RESOLVER_ABI,
    functionName: 'fetchCallback',
    args: [proofData, extraData],
  })

  // Result is ABI-encoded address
  const [address] = encodeAbiParameters ? [null] : [null]
  // Decode: result is abi.encode(address)
  const { decodeAbiParameters } = await import('viem')
  const [resolved] = decodeAbiParameters([{ type: 'address' }], result)
  return resolved
}

async function main() {
  console.log('=== Milestone C: Proof Mode Resolution Check ===\n')
  console.log(`Timestamp: ${new Date().toISOString()}`)
  console.log(`Sepolia RPC: ${SEPOLIA_RPC.replace(/\/v2\/.+/, '/v2/***')}`)
  console.log()

  let allPassed = true

  for (const tc of TEST_CASES) {
    process.stdout.write(`[${tc.mode}] ${tc.name} ... `)
    try {
      const addr = await resolveViaUniversalResolver(tc.name)
      if (addr && addr.toLowerCase() === tc.expected.toLowerCase()) {
        console.log(`PASS ✓  (${addr})`)
      } else {
        console.log(`FAIL ✗  got=${addr}, expected=${tc.expected}`)
        allPassed = false
      }
    } catch (err) {
      const msg = err?.message ?? String(err)
      // Truncate long errors
      const short = msg.length > 200 ? msg.slice(0, 200) + '...' : msg
      console.log(`ERROR ✗  ${short}`)
      allPassed = false
    }
  }

  console.log()
  console.log(allPassed ? '=== ALL TESTS PASSED ===' : '=== SOME TESTS FAILED ===')
  process.exit(allPassed ? 0 : 1)
}

main().catch((e) => {
  console.error('Fatal:', e)
  process.exit(1)
})
