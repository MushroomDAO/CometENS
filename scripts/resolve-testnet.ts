/**
 * CometENS — Testnet subdomain resolution script
 *
 * Full CCIP-Read pipeline (EIP-3668):
 *   1. eth_call → OffchainResolver.resolve()          → OffchainLookup revert
 *   2. POST calldata to gateway                        → signed response
 *   3. eth_call → OffchainResolver.resolveWithProof() → decoded record
 *
 * Usage:
 *   npx tsx scripts/resolve-testnet.ts alice
 *   npx tsx scripts/resolve-testnet.ts alice.aastar.eth
 *
 * Requires .env.local: VITE_L1_SEPOLIA_RPC_URL, VITE_L1_OFFCHAIN_RESOLVER_ADDRESS
 */

import { ProxyAgent, fetch as undiciFetch } from 'undici'
import {
  namehash, encodeFunctionData, decodeAbiParameters, decodeErrorResult, toHex, type Hex,
} from 'viem'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// ─── Proxy-aware fetch ────────────────────────────────────────────────────────

const proxyUrl = process.env.https_proxy || process.env.http_proxy || process.env.HTTPS_PROXY || process.env.HTTP_PROXY
const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined

async function pfetch(url: string, init: RequestInit): Promise<Response> {
  return undiciFetch(url, { ...init, dispatcher } as any) as unknown as Response
}

// ─── Load .env.local ──────────────────────────────────────────────────────────

function loadEnv(): Record<string, string> {
  try {
    return Object.fromEntries(
      readFileSync(resolve(process.cwd(), '.env.local'), 'utf8')
        .split('\n')
        .filter((l) => l.trim() && !l.trim().startsWith('#') && l.includes('='))
        .map((l) => { const eq = l.indexOf('='); return [l.slice(0, eq).trim(), l.slice(eq + 1).trim().replace(/^["']|["']$/g, '')] }),
    )
  } catch { return {} }
}

const env = loadEnv()
const L1_RPC_URL = env['VITE_L1_SEPOLIA_RPC_URL'] ?? ''
const RESOLVER_ADDR = (env['VITE_L1_OFFCHAIN_RESOLVER_ADDRESS'] ?? '') as Hex
const ROOT_DOMAIN = env['VITE_ROOT_DOMAIN'] ?? 'aastar.eth'

if (!L1_RPC_URL) { console.error('Missing VITE_L1_SEPOLIA_RPC_URL in .env.local'); process.exit(1) }
if (!RESOLVER_ADDR) { console.error('Missing VITE_L1_OFFCHAIN_RESOLVER_ADDRESS in .env.local'); process.exit(1) }

// ─── ABIs ─────────────────────────────────────────────────────────────────────

const RESOLVER_ABI = [
  { type: 'function', name: 'gatewayUrl', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'resolve', stateMutability: 'view', inputs: [{ name: 'name', type: 'bytes' }, { name: 'data', type: 'bytes' }], outputs: [{ type: 'bytes' }] },
  { type: 'function', name: 'resolveWithProof', stateMutability: 'view', inputs: [{ name: 'response', type: 'bytes' }, { name: 'extraData', type: 'bytes' }], outputs: [{ type: 'bytes' }] },
] as const

const RECORD_ABI = [
  { type: 'function', name: 'addr', stateMutability: 'view', inputs: [{ name: 'node', type: 'bytes32' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'text', stateMutability: 'view', inputs: [{ name: 'node', type: 'bytes32' }, { name: 'key', type: 'string' }], outputs: [{ type: 'string' }] },
] as const

const OFFCHAIN_LOOKUP_ABI = [{ type: 'error', name: 'OffchainLookup', inputs: [{ name: 'sender', type: 'address' }, { name: 'urls', type: 'string[]' }, { name: 'callData', type: 'bytes' }, { name: 'callbackFunction', type: 'bytes4' }, { name: 'extraData', type: 'bytes' }] }] as const

// ─── Helpers ──────────────────────────────────────────────────────────────────

function dnsEncode(name: string): Hex {
  const b: number[] = []
  for (const p of name.split('.')) { const e = new TextEncoder().encode(p); b.push(e.length, ...e) }
  b.push(0)
  return toHex(new Uint8Array(b))
}

async function ethCallRaw(to: Hex, data: Hex): Promise<Hex | { revertData: Hex }> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] })
  const resp = await pfetch(L1_RPC_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
  const j = await (resp as any).json() as any
  if (j.result !== undefined) return j.result as Hex
  if (j.error?.data) return { revertData: j.error.data as Hex }
  throw new Error(`RPC error: ${JSON.stringify(j.error)}`)
}

// ─── CCIP-Read query ──────────────────────────────────────────────────────────

const OFFCHAIN_LOOKUP_SELECTOR = '0x556f1830'

async function queryRecord(dnsName: Hex, recordCalldata: Hex, label: string): Promise<void> {
  // 1. call resolve() → expect OffchainLookup revert
  const resolveData = encodeFunctionData({ abi: RESOLVER_ABI, functionName: 'resolve', args: [dnsName, recordCalldata] })
  const step1 = await ethCallRaw(RESOLVER_ADDR, resolveData)
  if (typeof step1 === 'string') { console.log(`${label}: ERROR — resolve() succeeded unexpectedly`); return }
  if (!step1.revertData.startsWith(OFFCHAIN_LOOKUP_SELECTOR)) { console.log(`${label}: ERROR — unexpected revert: ${step1.revertData.slice(0, 10)}`); return }

  // 2. decode OffchainLookup
  let sender: Hex, urls: string[], callData: Hex, extraData: Hex
  try {
    const decoded = decodeErrorResult({ abi: OFFCHAIN_LOOKUP_ABI, data: step1.revertData })
    const args = (decoded as any).args as [Hex, string[], Hex, Hex, Hex]
    ;[sender, urls, callData, , extraData] = args
  } catch (e: any) { console.log(`${label}: ERROR — decode: ${e.message}`); return }

  // 3. call gateway
  let gwData: Hex
  try {
    const resp = await pfetch(urls[0], {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: callData, sender }),
    })
    if (!(resp as any).ok) throw new Error(`HTTP ${(resp as any).status}`)
    gwData = ((await (resp as any).json()) as { data: Hex }).data
  } catch (e: any) { console.log(`${label}: ERROR — gateway: ${e.message}`); return }

  // 4. resolveWithProof
  const proofCalldata = encodeFunctionData({ abi: RESOLVER_ABI, functionName: 'resolveWithProof', args: [gwData, extraData] })
  const step4 = await ethCallRaw(RESOLVER_ADDR, proofCalldata)
  if (typeof step4 !== 'string') { console.log(`${label}: ERROR — resolveWithProof reverted`); return }

  // 5. decode result
  try {
    const [inner] = decodeAbiParameters([{ type: 'bytes' }], step4)
    if (label.startsWith('addr')) {
      const [addr] = decodeAbiParameters([{ type: 'address' }], inner as Hex)
      console.log(`${label}: ${addr === '0x0000000000000000000000000000000000000000' ? '(not set)' : addr}`)
    } else {
      const [text] = decodeAbiParameters([{ type: 'string' }], inner as Hex)
      if (text) console.log(`${label}: ${text}`)
    }
  } catch { console.log(`${label}: (not set)`) }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const arg = process.argv[2] ?? 'alice'
const name = arg.includes('.') ? arg : `${arg}.${ROOT_DOMAIN}`
const node = namehash(name)
const dnsName = dnsEncode(name)

async function main() {
  if (proxyUrl) console.log(`  Proxy:    ${proxyUrl}`)

  const gwUrlResult = await ethCallRaw(RESOLVER_ADDR, encodeFunctionData({ abi: RESOLVER_ABI, functionName: 'gatewayUrl' }))
  let gatewayUrl = '(unknown)'
  if (typeof gwUrlResult === 'string') {
    try { [gatewayUrl] = decodeAbiParameters([{ type: 'string' }], gwUrlResult) } catch { /* ignore */ }
  }

  console.log(`\nResolving: ${name}`)
  console.log(`  L1 RPC:   ${L1_RPC_URL.replace(/\/v2\/.+/, '/v2/***')}`)
  console.log(`  Resolver: ${RESOLVER_ADDR}`)
  console.log(`  Gateway:  ${gatewayUrl}`)
  console.log()

  await queryRecord(dnsName, encodeFunctionData({ abi: RECORD_ABI, functionName: 'addr', args: [node] }), 'addr(ETH)')
  for (const key of ['com.twitter', 'com.github', 'email', 'url', 'avatar']) {
    await queryRecord(dnsName, encodeFunctionData({ abi: RECORD_ABI, functionName: 'text', args: [node, key] }), `text(${key})`)
  }

  console.log('\n✓ Done')
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1) })
