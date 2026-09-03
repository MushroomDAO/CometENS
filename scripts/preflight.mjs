// Deployment preflight — catch config mistakes BEFORE they become runtime failures.
//
// Usage: node scripts/preflight.mjs [--env testnet|production] [--json]
// Exit:  0 = all checks passed (warnings allowed), 1 = at least one FAIL, 2 = usage error.
//
// Implemented as .mjs, not .ts as spec.md §1 originally said: the repo's existing .ts
// scripts declare `#!/usr/bin/env tsx` but tsx is not a dependency here, so they only run
// if the operator happens to have it installed globally. A preflight whose whole purpose is
// "make self-hosting reliable" must not itself depend on an undeclared global tool, so it
// follows the pattern of the scripts package.json actually wires up (sync-abi.mjs et al).
//
// HARD RULE: this script must never print a raw private key. Only existence, format
// validity, the derived ADDRESS, or a mask. Everything below is written to that rule, and
// test/unit/preflight.test.ts asserts no 64-hex string ever reaches the output.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { privateKeyToAccount } from 'viem/accounts'
import { createPublicClient, http } from 'viem'

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

export const NETWORKS = {
  testnet: { label: 'OP Sepolia', chainId: 11155420, defaultRpc: 'https://sepolia.optimism.io' },
  production: { label: 'OP Mainnet', chainId: 10, defaultRpc: 'https://mainnet.optimism.io' },
}

const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/
/** Matches a bare 64-hex key anywhere in a string — used to detect leakage, not to validate. */
export const LOOKS_LIKE_KEY = /0x[0-9a-fA-F]{64}/

/** The three key roles. Reusing one key across them means one leak compromises everything. */
export const KEY_ROLES = [
  { env: 'WORKER_EOA_PRIVATE_KEY', role: 'writer (L2 transactions)' },
  { env: 'PRIVATE_KEY_SUPPLIER', role: 'gateway signer (CCIP-Read responses)' },
  { env: 'PRIVATE_KEY_JASON', role: 'deployer / owner' },
]

const ENS_NAME_RE = /^([a-z0-9-]+\.)+eth$/
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
/** wrangler.toml carries a zero-address placeholder for undeployed envs — not a real value. */
const nonZero = (v) => (v && v.toLowerCase() !== ZERO_ADDRESS ? v : undefined)

/** Load .env.local into a plain object without touching process.env — keeps checks pure. */
export function readEnvFile(root = REPO_ROOT) {
  try {
    const raw = readFileSync(join(root, '.env.local'), 'utf8')
    const out = {}
    for (const line of raw.split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=["']?(.*?)["']?\s*$/)
      if (m && m[2] !== '') out[m[1]] = m[2]
    }
    return out
  } catch {
    return {}
  }
}

/**
 * Read the [env.<name>.vars] block of a wrangler.toml.
 *
 * Deployment config (contract address, root domain) genuinely lives here — it is what the
 * deployed Workers read, and T1.0.1 established it as the source of truth after .env.local
 * drifted away from it. Including it means preflight works on a fresh clone with no
 * .env.local, and that a self-hoster who edited only wrangler.toml is checked against what
 * they actually configured.
 */
export function readWranglerVars(file, section) {
  let toml
  try {
    toml = readFileSync(file, 'utf8')
  } catch {
    return {}
  }
  const start = toml.indexOf(`[env.${section}.vars]`)
  if (start === -1) return {}
  // The next-section search must tolerate INDENTED headers. TOML allows them, and an
  // `indexOf('\n[')` scan silently runs past one — the block then absorbs the FOLLOWING
  // env's values. Found in the sibling check-chain.mjs during review of PR #22, where a
  // testnet block with an indented [env.production.vars] after it returned the production
  // contract address; two spaces separated a correct answer from a wrong chain.
  const rest = toml.slice(start)
  const nextRel = rest.slice(1).search(/\n[ \t]*\[/)
  const block = nextRel === -1 ? rest : rest.slice(0, nextRel + 1)
  const out = {}
  for (const line of block.split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*"([^"]*)"/)
    if (m && m[2] !== '') out[m[1]] = m[2]
  }
  return out
}

/** Deployment config from both worker configs; the api worker wins where they overlap. */
export function deploymentVars(envName, root = REPO_ROOT) {
  return {
    ...readWranglerVars(join(root, 'workers/gateway/wrangler.toml'), envName),
    ...readWranglerVars(join(root, 'workers/api/wrangler.toml'), envName),
  }
}

/** Derive an address from a private key, or null if the key is absent/malformed. */
export function addressOf(key) {
  if (!key || !PRIVATE_KEY_RE.test(key)) return null
  try {
    return privateKeyToAccount(key).address
  } catch {
    return null
  }
}

/**
 * All checks that need no network. Pure: takes an env object, returns findings.
 * Network checks live in probeChain() so tests can run the bulk of the logic offline.
 */
export function staticChecks(env, envName = 'testnet') {
  const net = NETWORKS[envName]
  const out = []
  const add = (id, level, title, detail, hint) => out.push({ id, level, title, detail, hint })

  // 1 — required variables
  const required = [
    ['L2_RECORDS_ADDRESS', nonZero(env.L2_RECORDS_ADDRESS || env.OP_L2_RECORDS_ADDRESS || env.VITE_L2_RECORDS_ADDRESS)],
    ['ROOT_DOMAIN', env.ROOT_DOMAIN || env.VITE_ROOT_DOMAIN],
    ['RPC URL', env.OP_SEPOLIA_RPC_URL || env.VITE_L2_RPC_URL || net?.defaultRpc],
  ]
  const missing = required.filter(([, v]) => !v).map(([k]) => k)
  if (missing.length) {
    add(1, 'FAIL', 'required configuration', `missing: ${missing.join(', ')}`,
      'copy .env.op-sepolia to .env.local and fill these in')
  } else {
    add(1, 'PASS', 'required configuration', 'all present')
  }

  // 2 — private key format. Report the KEY NAME and validity, never the value.
  const badFormat = []
  const present = []
  for (const { env: name } of KEY_ROLES) {
    const v = env[name]
    if (!v) continue
    present.push(name)
    if (!PRIVATE_KEY_RE.test(v)) badFormat.push(name)
  }
  if (badFormat.length) {
    add(2, 'FAIL', 'private key format', `not 0x + 64 hex: ${badFormat.join(', ')}`,
      'a private key is exactly 66 characters: 0x followed by 64 hex digits')
  } else if (present.length) {
    add(2, 'PASS', 'private key format', `${present.length} key(s) well-formed`)
  } else {
    add(2, 'WARN', 'private key format', 'no signing keys configured',
      'read-only checks will still run; writes will not work')
  }

  // 3 — a key behind a VITE_ prefix gets bundled into the browser. This is the single most
  // damaging config mistake available here, so it is a hard FAIL.
  const exposed = Object.keys(env).filter((k) => k.startsWith('VITE_') && LOOKS_LIKE_KEY.test(env[k] ?? ''))
  if (exposed.length) {
    add(3, 'FAIL', 'key exposed to browser bundle', `VITE_-prefixed and looks like a private key: ${exposed.join(', ')}`,
      'VITE_ variables are compiled into the client bundle and served publicly. Rename without the VITE_ prefix, then rotate that key — treat it as already leaked.')
  } else {
    add(3, 'PASS', 'key exposed to browser bundle', 'no VITE_ variable holds a private key')
  }

  // 3b — role separation. One key for all three roles means a single leak lets an attacker
  // both forge resolution responses and seize subdomains.
  const byAddress = new Map()
  for (const { env: name, role } of KEY_ROLES) {
    const addr = addressOf(env[name])
    if (!addr) continue
    if (!byAddress.has(addr)) byAddress.set(addr, [])
    byAddress.get(addr).push(role)
  }
  const shared = [...byAddress.entries()].filter(([, roles]) => roles.length > 1)
  if (shared.length) {
    const [addr, roles] = shared[0]
    add('3b', 'WARN', 'key role separation', `${addr} serves ${roles.length} roles: ${roles.join(', ')}`,
      'one leak of this key compromises every role at once. Use a separate key per role; keep the owner key cold and out of the routine write path.')
  } else if (byAddress.size > 0) {
    add('3b', 'PASS', 'key role separation', `${byAddress.size} distinct key(s)`)
  }

  // 8 — root domain shape
  const root = env.ROOT_DOMAIN || env.VITE_ROOT_DOMAIN
  if (root && !ENS_NAME_RE.test(root)) {
    add(8, 'FAIL', 'root domain', `"${root}" is not a valid .eth ENS name`,
      'expected something like community.eth (lowercase, ends in .eth)')
  } else if (root) {
    add(8, 'PASS', 'root domain', root)
  }

  return out
}

/**
 * Strip credential-shaped material out of a third-party error string.
 *
 * viem error objects carry the full RPC URL in `message`/`metaMessages`, and provider keys
 * live in that URL's path (Alchemy `/v2/<key>`, Infura `/v3/<key>`). Today `shortMessage` is
 * always present so the `||` chain never reaches `message` — but that is a property of viem,
 * not a guarantee this script owns. Same defect was found in check-chain.mjs during review
 * of PR #22; fixing it in one place and not the other is how it comes back.
 */
export function scrubError(e) {
  return String(e?.shortMessage || e?.message || e)
    .replace(/https?:\/\/[^\s"']+/g, (u) => {
      try {
        const p = new URL(u)
        const hasPathOrQuery = p.pathname.replace(/^\/+|\/+$/g, '').length > 0 || p.search.length > 0
        return hasPathOrQuery ? `${p.protocol}//${p.host}/…(redacted)` : `${p.protocol}//${p.host}`
      } catch {
        return '(redacted URL)'
      }
    })
    .replace(/0x[0-9a-fA-F]{64}/g, '0x…(redacted)')
}

/** Network-dependent checks. Separated so staticChecks() stays offline and unit-testable. */
export async function probeChain(env, envName = 'testnet', clientFactory) {
  const net = NETWORKS[envName]
  const out = []
  const add = (id, level, title, detail, hint) => out.push({ id, level, title, detail, hint })

  const rpcUrl = env.OP_SEPOLIA_RPC_URL || net.defaultRpc
  const address = env.L2_RECORDS_ADDRESS || env.OP_L2_RECORDS_ADDRESS || env.VITE_L2_RECORDS_ADDRESS
  const client = clientFactory ? clientFactory(rpcUrl) : createPublicClient({ transport: http(rpcUrl) })

  let chainId
  try {
    chainId = await client.getChainId()
  } catch (e) {
    add(4, 'FAIL', 'L2 RPC reachable', `cannot reach RPC: ${scrubError(e)}`,
      'check the endpoint. A provider app with the network not enabled returns HTTP 403 on every call.')
    return out
  }
  if (chainId !== net.chainId) {
    add(4, 'FAIL', 'L2 RPC reachable', `RPC is chain ${chainId}, expected ${net.chainId} (${net.label})`,
      'this RPC points at a different network — writes would hit the wrong chain')
    return out
  }
  add(4, 'PASS', 'L2 RPC reachable', `chain ${chainId} (${net.label})`)

  if (!address) return out

  const code = await client.getCode({ address }).catch(() => null)
  if (!code || code === '0x') {
    add(5, 'FAIL', 'L2Records deployed', `no contract code at ${address}`,
      'the configured address holds no contract on this chain — likely config drift')
    return out
  }
  add(5, 'PASS', 'L2Records deployed', address)

  try {
    const owner = await client.readContract({
      address,
      abi: [{ name: 'owner', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }],
      functionName: 'owner',
    })
    add(6, 'PASS', 'contract owner readable', owner)
  } catch (e) {
    add(6, 'FAIL', 'contract owner readable', `owner() reverted: ${scrubError(e)}`,
      'the contract at this address may not be an L2Records instance')
  }

  // 7 — balance is a WARN: an empty operator wallet blocks writes but breaks nothing yet.
  const writer = addressOf(env.WORKER_EOA_PRIVATE_KEY)
  if (writer) {
    const bal = await client.getBalance({ address: writer }).catch(() => null)
    if (bal === 0n) {
      add(7, 'WARN', 'operator balance', `${writer} has 0 ETH`, 'fund it before attempting any write')
    } else if (bal != null) {
      add(7, 'PASS', 'operator balance', `${writer} funded`)
    }
  }

  return out
}

export function summarize(findings) {
  return {
    fail: findings.filter((f) => f.level === 'FAIL').length,
    warn: findings.filter((f) => f.level === 'WARN').length,
    pass: findings.filter((f) => f.level === 'PASS').length,
  }
}

export function render(findings, asJson) {
  const s = summarize(findings)
  if (asJson) return JSON.stringify({ ok: s.fail === 0, ...s, findings }, null, 2)
  const lines = findings.map((f) => {
    const head = `${f.level.padEnd(4)} [${f.id}] ${f.title} — ${f.detail}`
    return f.hint && f.level !== 'PASS' ? `${head}\n     → ${f.hint}` : head
  })
  lines.push('', `${s.pass} passed, ${s.warn} warning(s), ${s.fail} failure(s)`)
  return lines.join('\n')
}

// ── CLI ───────────────────────────────────────────────────────────────────────
// Guarded so importing this module from tests does not execute the CLI or hit the network.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2)
  const asJson = argv.includes('--json')
  const i = argv.indexOf('--env')
  const envName = i !== -1 ? argv[i + 1] : 'testnet'

  if (!NETWORKS[envName]) {
    console.error(`unknown --env "${envName}" (expected: ${Object.keys(NETWORKS).join(' | ')})`)
    process.exit(2)
  }

  // Precedence, lowest to highest: wrangler.toml (what is deployed) < .env.local (local
  // overrides) < exported shell variables (explicit, one-off). Matching the rest of the repo.
  const env = {
    ...deploymentVars(envName),
    ...readEnvFile(),
    ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v)),
  }

  const findings = staticChecks(env, envName)
  findings.push(...(await probeChain(env, envName)))

  const output = render(findings, asJson)
  // Belt and braces: even though every check above reports names/addresses rather than key
  // material, refuse to emit anything containing a 64-hex string. If this ever trips it is a
  // bug in a check, and printing nothing is far better than printing a key.
  if (LOOKS_LIKE_KEY.test(output)) {
    console.error('preflight: internal error — output contained key-shaped material and was withheld')
    process.exit(1)
  }
  console.log(output)
  process.exit(summarize(findings).fail === 0 ? 0 : 1)
}
