/**
 * CometENS — Testnet subdomain resolution script
 *
 * Tests that ENS subdomains registered via CometENS can be resolved
 * through the full CCIP-Read pipeline (L1 → gateway → L2).
 *
 * Usage:
 *   npx tsx scripts/resolve-testnet.ts [subdomain]
 *   npx tsx scripts/resolve-testnet.ts alice          # resolves alice.aastar.eth
 *   npx tsx scripts/resolve-testnet.ts alice.aastar.eth
 *
 * Requires:
 *   VITE_L1_SEPOLIA_RPC_URL  in .env.local  (Ethereum Sepolia RPC)
 *   VITE_GATEWAY_URL         in .env.local  (gateway — public or localhost)
 *
 * The gateway must be reachable from this machine. For the public CF Worker:
 *   VITE_GATEWAY_URL=https://cometens-gateway.jhfnetboy.workers.dev
 */

import { createPublicClient, http } from 'viem'
import { sepolia } from 'viem/chains'
import { getEnsAddress, getEnsText } from 'viem/ens'
import { readFileSync } from 'fs'
import { resolve } from 'path'

// ─── Load env ─────────────────────────────────────────────────────────────────

function loadEnv(): Record<string, string> {
  const envPath = resolve(process.cwd(), '.env.local')
  try {
    const lines = readFileSync(envPath, 'utf8').split('\n')
    const env: Record<string, string> = {}
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq === -1) continue
      const key = trimmed.slice(0, eq).trim()
      const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
      env[key] = val
    }
    return env
  } catch {
    return {}
  }
}

const env = loadEnv()
const L1_RPC_URL = env['VITE_L1_SEPOLIA_RPC_URL'] || process.env['VITE_L1_SEPOLIA_RPC_URL'] || ''
const GATEWAY_URL = env['VITE_GATEWAY_URL'] || process.env['VITE_GATEWAY_URL'] || ''
const ROOT_DOMAIN = env['VITE_ROOT_DOMAIN'] || process.env['VITE_ROOT_DOMAIN'] || 'aastar.eth'

if (!L1_RPC_URL) {
  console.error('Missing VITE_L1_SEPOLIA_RPC_URL in .env.local')
  process.exit(1)
}

// ─── Resolve ──────────────────────────────────────────────────────────────────

const client = createPublicClient({
  chain: sepolia,
  transport: http(L1_RPC_URL),
})

const arg = process.argv[2] ?? 'alice'
const name = arg.includes('.') ? arg : `${arg}.${ROOT_DOMAIN}`

console.log(`\nResolving: ${name}`)
console.log(`  L1 RPC:  ${L1_RPC_URL.replace(/\/v2\/.+/, '/v2/***')}`)
console.log(`  Gateway: ${GATEWAY_URL || '(using L1 resolver default)'}`)
console.log()

async function main() {
  // ── addr ────────────────────────────────────────────────────────────────────
  try {
    const addr = await client.getEnsAddress({ name })
    console.log(`addr(60/ETH):     ${addr ?? '(not set)'}`)
  } catch (e) {
    console.log(`addr(60/ETH):     ERROR — ${(e as Error).message}`)
  }

  // ── text records ────────────────────────────────────────────────────────────
  for (const key of ['com.twitter', 'com.github', 'email', 'url', 'avatar', 'description']) {
    try {
      const value = await client.getEnsText({ name, key })
      if (value) console.log(`text(${key.padEnd(14)}): ${value}`)
    } catch {
      // silently skip missing text records
    }
  }

  console.log()
  console.log('✓ Resolution complete')
}

main().catch((e) => {
  console.error('Fatal:', e)
  process.exit(1)
})
