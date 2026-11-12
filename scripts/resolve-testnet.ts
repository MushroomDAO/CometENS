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

import { ProxyAgent, fetch as undiciFetch, type RequestInit as UndiciRequestInit, type Response as UndiciResponse } from 'undici'
import {
  namehash, encodeFunctionData, decodeAbiParameters, decodeErrorResult, isAddress, isHex, toHex,
  type Address, type Hex,
} from 'viem'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// ─── Proxy-aware fetch ────────────────────────────────────────────────────────

const proxyUrl = process.env.https_proxy || process.env.http_proxy || process.env.HTTPS_PROXY || process.env.HTTP_PROXY
const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined

async function pfetch(url: string, init: UndiciRequestInit): Promise<UndiciResponse> {
  return undiciFetch(url, { ...init, dispatcher })
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

export const OFFCHAIN_LOOKUP_ABI = [{ type: 'error', name: 'OffchainLookup', inputs: [{ name: 'sender', type: 'address' }, { name: 'urls', type: 'string[]' }, { name: 'callData', type: 'bytes' }, { name: 'callbackFunction', type: 'bytes4' }, { name: 'extraData', type: 'bytes' }] }] as const

const OFFCHAIN_LOOKUP_SELECTOR = '0x556f1830'
const OFFCHAIN_LOOKUP_ARITY = 5

// ─── Pure CCIP decode / validate (no network) ─────────────────────────────────

export interface OffchainLookupArgs {
  sender: Address
  urls: readonly [string, ...string[]]
  callData: Hex
  callbackFunction: Hex
  extraData: Hex
}

/** Gateway CCIP-Read JSON body. `data` is the signed response passed to resolveWithProof. */
export interface GatewayJson {
  data: Hex
}

export interface HttpShapedResult {
  ok: boolean
  status: number
  body: unknown
}

interface RpcErrorBody {
  data?: unknown
}

interface RpcJsonBody {
  result?: unknown
  error?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyStringList(value: unknown): value is [string, ...string[]] {
  if (!Array.isArray(value) || value.length === 0) return false
  return value.every((item: unknown) => typeof item === 'string')
}

function isBytes4(value: unknown): value is Hex {
  return isHex(value) && value.length === 10
}

function isSender(value: unknown): value is Address {
  return typeof value === 'string' && isAddress(value, { strict: false })
}

/** `e.message` when the throw was an object; otherwise the same text `${nonError.message}` produced. */
function errorText(e: unknown): string {
  if (typeof e === 'object' && e !== null && 'message' in e) {
    const message = e.message
    return typeof message === 'string' ? message : String(message)
  }
  return 'undefined'
}

/**
 * Accept a 5-field OffchainLookup argument list.
 * Shorter lists and non-arrays are truncated; present-but-wrong fields are rejected.
 */
export function parseOffchainLookupArgs(args: unknown): OffchainLookupArgs {
  if (!Array.isArray(args) || args.length < OFFCHAIN_LOOKUP_ARITY) {
    throw new Error('truncated OffchainLookup args')
  }
  const sender: unknown = args[0]
  const urls: unknown = args[1]
  const callData: unknown = args[2]
  const callbackFunction: unknown = args[3]
  const extraData: unknown = args[4]
  if (!isSender(sender) || !isNonEmptyStringList(urls) || !isHex(callData) || !isBytes4(callbackFunction) || !isHex(extraData)) {
    throw new Error('invalid OffchainLookup args')
  }
  return { sender, urls, callData, callbackFunction, extraData }
}

function lookupFromAbi(
  sender: Address,
  urls: readonly string[],
  callData: Hex,
  callbackFunction: Hex,
  extraData: Hex,
): OffchainLookupArgs {
  return parseOffchainLookupArgs([sender, urls, callData, callbackFunction, extraData])
}

/** decodeErrorResult → validated OffchainLookup args. Bad calldata throws (fail closed). */
export function decodeOffchainLookup(revertData: Hex): OffchainLookupArgs {
  const decoded = decodeErrorResult({ abi: OFFCHAIN_LOOKUP_ABI, data: revertData })
  if (decoded.errorName !== 'OffchainLookup' || decoded.args === undefined) {
    throw new Error('truncated OffchainLookup args')
  }
  const [sender, urls, callData, callbackFunction, extraData] = decoded.args
  return lookupFromAbi(sender, urls, callData, callbackFunction, extraData)
}

function parseGatewayJson(body: unknown): GatewayJson {
  if (!isRecord(body) || !isHex(body.data)) throw new Error('gateway JSON missing hex data')
  return { data: body.data }
}

/**
 * HTTP-shaped gateway result. Non-OK responses throw `HTTP ${status}` and ignore `body`.
 * An OK response whose JSON is not `{ data: Hex }` throws.
 */
export function gatewayHexFromHttp(http: HttpShapedResult): Hex {
  if (!http.ok) throw new Error(`HTTP ${http.status}`)
  return parseGatewayJson(http.body).data
}

/** JSON-RPC eth_call body. A non-hex `result` / revert `data` fails closed. */
export function rpcResultFromJson(body: unknown): Hex | { revertData: Hex } {
  if (!isRecord(body)) throw new Error(`RPC error: ${JSON.stringify(body)}`)
  const payload: RpcJsonBody = body
  if (payload.result !== undefined) {
    if (!isHex(payload.result)) throw new Error(`RPC error: ${JSON.stringify(payload.error)}`)
    return payload.result
  }
  const error: RpcErrorBody | undefined = isRecord(payload.error) ? payload.error : undefined
  if (error && isHex(error.data)) return { revertData: error.data }
  throw new Error(`RPC error: ${JSON.stringify(payload.error)}`)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function dnsEncode(name: string): Hex {
  const b: number[] = []
  for (const p of name.split('.')) { const e = new TextEncoder().encode(p); b.push(e.length, ...e) }
  b.push(0)
  return toHex(new Uint8Array(b))
}

// Unit tests import the decoders above. Only a direct CLI invocation reads env and dials RPC.
function runningAsCli(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  return resolve(entry) === resolve(fileURLToPath(import.meta.url))
}

function startCli(): void {
  const env = loadEnv()
  const L1_RPC_URL = env['VITE_L1_SEPOLIA_RPC_URL'] ?? ''
  const RESOLVER_ADDR = env['VITE_L1_OFFCHAIN_RESOLVER_ADDRESS'] ?? ''
  const ROOT_DOMAIN = env['VITE_ROOT_DOMAIN'] ?? 'aastar.eth'

  if (!L1_RPC_URL) { console.error('Missing VITE_L1_SEPOLIA_RPC_URL in .env.local'); process.exit(1) }
  if (!RESOLVER_ADDR) { console.error('Missing VITE_L1_OFFCHAIN_RESOLVER_ADDRESS in .env.local'); process.exit(1) }
  if (!isHex(RESOLVER_ADDR)) { console.error('Missing VITE_L1_OFFCHAIN_RESOLVER_ADDRESS in .env.local'); process.exit(1) }
  const resolverAddr: Hex = RESOLVER_ADDR

  async function ethCallRaw(to: Hex, data: Hex): Promise<Hex | { revertData: Hex }> {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] })
    const resp = await pfetch(L1_RPC_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
    return rpcResultFromJson(await resp.json())
  }

  // ─── CCIP-Read query ────────────────────────────────────────────────────────

  async function queryRecord(dnsName: Hex, recordCalldata: Hex, label: string): Promise<void> {
    // 1. call resolve() → expect OffchainLookup revert
    const resolveData = encodeFunctionData({ abi: RESOLVER_ABI, functionName: 'resolve', args: [dnsName, recordCalldata] })
    const step1 = await ethCallRaw(resolverAddr, resolveData)
    if (typeof step1 === 'string') { console.log(`${label}: ERROR — resolve() succeeded unexpectedly`); return }
    if (!step1.revertData.startsWith(OFFCHAIN_LOOKUP_SELECTOR)) { console.log(`${label}: ERROR — unexpected revert: ${step1.revertData.slice(0, 10)}`); return }

    // 2. decode OffchainLookup
    let sender: Address, urls: OffchainLookupArgs['urls'], callData: Hex, extraData: Hex
    try {
      const decoded = decodeOffchainLookup(step1.revertData)
      sender = decoded.sender
      urls = decoded.urls
      callData = decoded.callData
      extraData = decoded.extraData
    } catch (e: unknown) { console.log(`${label}: ERROR — decode: ${errorText(e)}`); return }

    // 3. call gateway
    let gwData: Hex
    try {
      const resp = await pfetch(urls[0], {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: callData, sender }),
      })
      const body = resp.ok ? await resp.json() : undefined
      gwData = gatewayHexFromHttp({ ok: resp.ok, status: resp.status, body })
    } catch (e: unknown) { console.log(`${label}: ERROR — gateway: ${errorText(e)}`); return }

    // 4. resolveWithProof
    const proofCalldata = encodeFunctionData({ abi: RESOLVER_ABI, functionName: 'resolveWithProof', args: [gwData, extraData] })
    const step4 = await ethCallRaw(resolverAddr, proofCalldata)
    if (typeof step4 !== 'string') { console.log(`${label}: ERROR — resolveWithProof reverted`); return }

    // 5. decode result
    try {
      const [inner] = decodeAbiParameters([{ type: 'bytes' }], step4)
      if (!isHex(inner)) throw new Error('inner result is not hex')
      if (label.startsWith('addr')) {
        const [addr] = decodeAbiParameters([{ type: 'address' }], inner)
        console.log(`${label}: ${addr === '0x0000000000000000000000000000000000000000' ? '(not set)' : addr}`)
      } else {
        const [text] = decodeAbiParameters([{ type: 'string' }], inner)
        if (text) console.log(`${label}: ${text}`)
      }
    } catch { console.log(`${label}: (not set)`) }
  }

  // ─── Main ───────────────────────────────────────────────────────────────────

  const arg = process.argv[2] ?? 'alice'
  const name = arg.includes('.') ? arg : `${arg}.${ROOT_DOMAIN}`
  const node = namehash(name)
  const dnsName = dnsEncode(name)

  async function main() {
    if (proxyUrl) console.log(`  Proxy:    ${proxyUrl}`)

    const gwUrlResult = await ethCallRaw(resolverAddr, encodeFunctionData({ abi: RESOLVER_ABI, functionName: 'gatewayUrl' }))
    let gatewayUrl = '(unknown)'
    if (typeof gwUrlResult === 'string') {
      try { [gatewayUrl] = decodeAbiParameters([{ type: 'string' }], gwUrlResult) } catch { /* ignore */ }
    }

    console.log(`\nResolving: ${name}`)
    console.log(`  L1 RPC:   ${L1_RPC_URL.replace(/\/v2\/.+/, '/v2/***')}`)
    console.log(`  Resolver: ${resolverAddr}`)
    console.log(`  Gateway:  ${gatewayUrl}`)
    console.log()

    await queryRecord(dnsName, encodeFunctionData({ abi: RECORD_ABI, functionName: 'addr', args: [node] }), 'addr(ETH)')
    for (const key of ['com.twitter', 'com.github', 'email', 'url', 'avatar']) {
      await queryRecord(dnsName, encodeFunctionData({ abi: RECORD_ABI, functionName: 'text', args: [node, key] }), `text(${key})`)
    }

    console.log('\n✓ Done')
  }

  main().catch((e: unknown) => { console.error('Fatal:', e); process.exit(1) })
}

if (runningAsCli()) startCli()
