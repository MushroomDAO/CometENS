// Chain connectivity + contract sanity check.
//
// Usage: node scripts/check-chain.mjs [--env testnet|production] [--json]
//
// Why this exists: two pieces of config drift silently break every on-chain task.
//   1. OP_SEPOLIA_RPC_URL in .env.local pointed at an Alchemy app that does not have
//      OPT_SEPOLIA enabled, so every call returned HTTP 403. The failure surfaced deep
//      inside unrelated scripts, so it looked like those scripts were broken.
//   2. VITE_L2_RECORDS_ADDRESS in .env.local drifted away from the address the deployed
//      Workers actually use. Reading the address from .env.local meant talking to a
//      *different contract* than production.
//
// So this script defaults to a public RPC that needs no account, and reads the contract
// address from wrangler.toml — the deployed Workers' own config, which is the source of
// truth for what is live. Both are overridable by env for self-hosters.
import { createPublicClient, http } from 'viem'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// Resolve wrangler.toml relative to the REPO, not the caller's cwd. `pnpm check:chain`
// happens to run from the package root, but `node scripts/check-chain.mjs` from anywhere
// else would otherwise silently find no config and report a confusing "address not found".
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const NETWORKS = {
  testnet: {
    label: 'OP Sepolia',
    chainId: 11155420,
    // Public endpoint: no API key, no per-app network enablement. Used only when the
    // configured variable below is unset/blank.
    defaultRpc: 'https://sepolia.optimism.io',
    rpcEnvVar: 'OP_SEPOLIA_RPC_URL',
  },
  production: {
    label: 'OP Mainnet',
    chainId: 10,
    defaultRpc: 'https://mainnet.optimism.io',
    rpcEnvVar: 'OP_MAINNET_RPC_URL',
  },
}

// Hydrate process.env from .env.local before reading ANY config below.
//
// Without this the whole script is a no-op in the one case it exists for: operators put
// OP_SEPOLIA_RPC_URL in .env.local (that is where the broken Alchemy URL lived), a bare
// process.env read never sees it, and the check reports green against the public endpoint
// while their real config stays broken — the exact drift this script is meant to catch.
//
// Same manual parse as scripts/check-proof-resolution.mjs, which is the established pattern
// for standalone node scripts in this repo. An already-exported shell variable wins, so
// `OP_SEPOLIA_RPC_URL=... pnpm check:chain` still overrides the file.
try {
  const envFile = readFileSync(join(REPO_ROOT, '.env.local'), 'utf8')
  for (const line of envFile.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=["']?(.+?)["']?\s*$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
} catch {
  // No .env.local (fresh clone, CI, or a self-hoster using real env vars) — fall through
  // to process.env as-is. Absence is normal and must not be an error.
}

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const envIdx = args.indexOf('--env')
const envName = envIdx !== -1 ? args[envIdx + 1] : 'testnet'

const net = NETWORKS[envName]
if (!net) {
  // Honour --json even for usage errors: a caller piping into jq should never get plain
  // text back, or the pipeline dies on the one path it cannot anticipate.
  const msg = `unknown --env "${envName}" (expected: ${Object.keys(NETWORKS).join(' | ')})`
  if (asJson) console.log(JSON.stringify({ ok: false, error: msg, hint: null }, null, 2))
  else console.error(msg)
  process.exit(2)
}

/**
 * Read L2_RECORDS_ADDRESS out of a wrangler.toml [env.<name>.vars] block.
 * wrangler.toml is the source of truth for what the deployed Workers talk to —
 * .env.local is a local convenience file and has drifted from it before.
 */
function addressFromWrangler(file, section) {
  let toml
  try {
    toml = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  // Narrow to the requested env block so the testnet/production values can't be confused.
  //
  // The next-section search must tolerate INDENTED headers. TOML allows them, and an
  // indented header used to leave the block unterminated — the regex then scanned on into
  // the following env and returned ITS address. Verified: a testnet block with no address
  // followed by an indented [env.production.vars] returned the production address, while
  // the same input with the header at column 0 correctly returned null. Two spaces apart,
  // and the failure mode is a silently wrong chain rather than an error.
  const start = toml.indexOf(`[env.${section}.vars]`)
  if (start === -1) return null
  const rest = toml.slice(start)
  const nextRel = rest.slice(1).search(/\n[ \t]*\[/)
  const block = nextRel === -1 ? rest : rest.slice(0, nextRel + 1)
  const m = block.match(/^\s*L2_RECORDS_ADDRESS\s*=\s*"(0x[0-9a-fA-F]{40})"/m)
  return m ? m[1] : null
}

// Precedence matters here. CHECK_CHAIN_RPC_URL is an explicit override for testing this
// script itself. Otherwise we read the SAME variable the rest of the repo uses, so that a
// self-hoster who configured a paid RPC gets that endpoint checked — not a public one that
// happens to work. Checking an endpoint the deployment does not actually use would report
// green while their real config is broken, which is precisely the drift this script exists
// to catch. Only when the variable is unset/blank do we fall back to the public endpoint.
const configuredRpc = (net.rpcEnvVar ? process.env[net.rpcEnvVar] : '')?.trim()
const rpcUrl = process.env.CHECK_CHAIN_RPC_URL || configuredRpc || net.defaultRpc
// Read BOTH worker configs rather than falling back from one to the other. With a
// fallback, the api value simply wins and a disagreement between the two files — the exact
// class of drift this script exists to surface — stays invisible.
const apiAddress = addressFromWrangler(join(REPO_ROOT, 'workers/api/wrangler.toml'), envName)
const gatewayAddress = addressFromWrangler(join(REPO_ROOT, 'workers/gateway/wrangler.toml'), envName)

// Provenance is tracked, not assumed. The operator reads this line to confirm "the address
// really came from wrangler.toml"; printing that claim when the value actually came from an
// override hands them a receipt for something that did not happen.
let address, addressSource
if (process.env.CHECK_CHAIN_L2_ADDRESS) {
  address = process.env.CHECK_CHAIN_L2_ADDRESS
  addressSource = 'CHECK_CHAIN_L2_ADDRESS override'
} else if (apiAddress && gatewayAddress && apiAddress.toLowerCase() !== gatewayAddress.toLowerCase()) {
  address = null
  addressSource = 'conflicting'
} else if (apiAddress) {
  address = apiAddress
  addressSource = gatewayAddress
    ? `wrangler.toml [env.${envName}.vars] (api + gateway agree)`
    : `workers/api/wrangler.toml [env.${envName}.vars]`
} else if (gatewayAddress) {
  address = gatewayAddress
  addressSource = `workers/gateway/wrangler.toml [env.${envName}.vars]`
} else {
  address = null
  addressSource = 'not found'
}

/**
 * Redact an RPC URL for display. Provider keys are routinely embedded in the path
 * (Alchemy: /v2/<key>, Infura: /v3/<key>) or the query string, and this output lands in
 * terminals, CI logs and pasted bug reports. Keep scheme+host so the operator can still
 * tell WHICH provider was used; drop everything that could be the credential.
 */
function redactRpc(url) {
  try {
    const u = new URL(url)
    const hasSecretish = u.pathname.replace(/^\/+|\/+$/g, '').length > 0 || u.search.length > 0
    return hasSecretish ? `${u.protocol}//${u.host}/…(redacted)` : `${u.protocol}//${u.host}`
  } catch {
    // Not a parseable URL — never echo it back verbatim, it may still hold a credential.
    return '(unparseable RPC URL)'
  }
}

const OWNER_ABI = [
  { name: 'owner', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
]
const ZERO = '0x0000000000000000000000000000000000000000'

/**
 * Strip anything key-shaped from a third-party error string before it is displayed.
 *
 * The RPC URL is redacted at every site where we build a message, but viem error objects
 * carry the full URL in `message`/`metaMessages`. Today `shortMessage` is always present so
 * `??`-chains never reach `message` — that is a property of viem, not a guarantee we own.
 * This makes the safety independent of it.
 */
function scrubError(e) {
  const raw = String(e?.shortMessage || e?.message || e)
  return raw
    .replace(/https?:\/\/[^\s"']+/g, (u) => redactRpc(u))
    .replace(/0x[0-9a-fA-F]{64}/g, '0x…(redacted)')
}

function fail(msg, hint) {
  if (asJson) {
    console.log(JSON.stringify({ ok: false, error: msg, hint: hint ?? null }, null, 2))
  } else {
    console.error(`FAIL  ${msg}`)
    if (hint) console.error(`      → ${hint}`)
  }
  process.exit(1)
}

if (addressSource === 'conflicting') {
  fail(
    `workers/api and workers/gateway disagree on L2_RECORDS_ADDRESS for env "${envName}": ${apiAddress} vs ${gatewayAddress}`,
    'the two Workers would read different contracts. Reconcile both wrangler.toml files before deploying.',
  )
}
if (!address) {
  fail(
    `could not find L2_RECORDS_ADDRESS for env "${envName}" in workers/*/wrangler.toml`,
    'set CHECK_CHAIN_L2_ADDRESS=0x... to check a specific contract (e.g. your own deployment)',
  )
}
if (address.toLowerCase() === ZERO) {
  fail(
    `L2_RECORDS_ADDRESS for env "${envName}" is the zero address — nothing is deployed there yet`,
    envName === 'production'
      ? 'mainnet is not deployed yet; this is expected. Use --env testnet.'
      : 'deploy the contract first, then set the address in wrangler.toml',
  )
}

const client = createPublicClient({ transport: http(rpcUrl) })

let chainId
try {
  chainId = await client.getChainId()
} catch (e) {
  fail(
    `cannot reach RPC ${redactRpc(rpcUrl)}: ${scrubError(e)}`,
    'the endpoint is unreachable or rejected the request. Override with CHECK_CHAIN_RPC_URL=<url>.',
  )
}

if (chainId !== net.chainId) {
  fail(
    `RPC ${redactRpc(rpcUrl)} is chain ${chainId}, expected ${net.chainId} (${net.label})`,
    'this RPC points at a different network than --env selects — writes here would hit the wrong chain',
  )
}

let code
try {
  code = await client.getCode({ address })
} catch (e) {
  fail(`eth_getCode failed for ${address}: ${scrubError(e)}`)
}
if (!code || code === '0x') {
  fail(
    `no contract code at ${address} on ${net.label}`,
    'the address in wrangler.toml does not hold a contract on this chain — check for config drift',
  )
}

let owner
try {
  owner = await client.readContract({ address, abi: OWNER_ABI, functionName: 'owner' })
} catch (e) {
  fail(
    `owner() call reverted at ${address}: ${scrubError(e)}`,
    'the contract at this address may not be an L2Records instance',
  )
}
if (owner.toLowerCase() === ZERO) {
  fail(`owner() returned the zero address at ${address}`, 'an unowned contract cannot register subdomains')
}

if (asJson) {
  console.log(JSON.stringify({ ok: true, env: envName, network: net.label, chainId, rpc: redactRpc(rpcUrl), address, addressSource, owner }, null, 2))
} else {
  console.log(`PASS  ${net.label}`)
  console.log(`      chainId   ${chainId}`)
  console.log(`      rpc       ${redactRpc(rpcUrl)}`)
  console.log(`      contract  ${address}`)
  console.log(`      source    ${addressSource}`)
  console.log(`      owner()   ${owner}`)
}
