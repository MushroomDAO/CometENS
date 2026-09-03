// Registrar delegation — grant / status / revoke.
//
// Usage:
//   node scripts/delegate.mjs status --parent <name.eth> [--of 0x…]
//   node scripts/delegate.mjs grant  --parent <name.eth> --to 0x… [--quota N] [--expiry <ISO8601>]
//   node scripts/delegate.mjs revoke --parent <name.eth> --from 0x…
//
// WHAT THIS IS FOR — and what it is NOT for
//
// addRegistrar/removeRegistrar are `onlyOwner`, so these commands only work when the caller
// IS the contract owner. That makes this the tooling for **Mode A (self-hosted)**: a community
// running its own deployment delegates day-to-day issuance under one of its parent nodes to a
// hot wallet or to a sub-group, with a quota and an expiry, revocably.
//
// It is NOT the revocation mechanism for Mode B (delegated hosting). There the operator holds
// the owner key, the community is not the owner, and `onlyOwnerOrRegistrar` short-circuits on
// `msg.sender != owner` — so the owner ignores the allowlist, the quota and the expiry
// entirely. A community's real lever in Mode B is changing the L1 resolver. Nothing printed by
// this script should be read as "the operator can no longer issue".
// See contracts/test/L2RecordsV3.t.sol::test_ownerCanStillRegisterAfterRevoke.
import { createPublicClient, createWalletClient, http, namehash } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

try {
  const raw = readFileSync(join(REPO_ROOT, '.env.local'), 'utf8')
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=["']?(.+?)["']?\s*$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
} catch {
  /* absent .env.local is normal */
}

const argv = process.argv.slice(2)
const command = argv[0]
const BOOL_FLAGS = ['--json', '--i-know-this-is-live']
const VALUE_FLAGS = ['--parent', '--to', '--from', '--of', '--quota', '--expiry', '--env', '--contract']
const COMMANDS = ['status', 'grant', 'revoke']

const flag = (n) => {
  const i = argv.indexOf(`--${n}`)
  return i === -1 ? undefined : argv[i + 1]
}
const asJson = argv.includes('--json')

function bail(msg, hint, code = 2) {
  if (asJson) console.log(JSON.stringify({ ok: false, error: msg, hint: hint ?? null }, null, 2))
  else {
    console.error(`ERROR  ${msg}`)
    if (hint) console.error(`       → ${hint}`)
  }
  process.exit(code)
}

// Reject unknown flags rather than ignoring them: a silently-dropped `--quota` would grant an
// unbounded allowance while the operator believed they had capped it.
for (let i = 1; i < argv.length; i++) {
  const a = argv[i]
  if (!a.startsWith('--')) continue
  if (BOOL_FLAGS.includes(a)) continue
  if (VALUE_FLAGS.includes(a)) { i++; continue }
  bail(`unknown flag "${a}"`, `supported: ${[...COMMANDS].join(' | ')} with ${[...BOOL_FLAGS, ...VALUE_FLAGS].join(' ')}`)
}

if (!COMMANDS.includes(command)) {
  bail(`unknown command "${command ?? '(none)'}"`, `expected one of: ${COMMANDS.join(' | ')}`)
}

const NETWORKS = {
  testnet: { chainId: 11155420, label: 'OP Sepolia', defaultRpc: 'https://sepolia.optimism.io' },
  production: { chainId: 10, label: 'OP Mainnet', defaultRpc: 'https://mainnet.optimism.io' },
}
const envName = flag('env') ?? 'testnet'
const net = NETWORKS[envName]
if (!net) bail(`unknown --env "${envName}"`, `expected: ${Object.keys(NETWORKS).join(' | ')}`)

function contractFromWrangler(section) {
  try {
    const toml = readFileSync(join(REPO_ROOT, 'workers/api/wrangler.toml'), 'utf8')
    const start = toml.indexOf(`[env.${section}.vars]`)
    if (start === -1) return undefined
    const rest = toml.slice(start)
    // Tolerate indented section headers — an indexOf('\n[') scan runs past them and would
    // read the NEXT env's address. Found in check-chain.mjs during review of PR #22.
    const nextRel = rest.slice(1).search(/\n[ \t]*\[/)
    const block = nextRel === -1 ? rest : rest.slice(0, nextRel + 1)
    const m = block.match(/^\s*L2_RECORDS_ADDRESS\s*=\s*"(0x[0-9a-fA-F]{40})"/m)
    return m?.[1]
  } catch {
    return undefined
  }
}

const ZERO = '0x0000000000000000000000000000000000000000'
const liveAddress = contractFromWrangler(envName)
const contract = flag('contract') ?? liveAddress
if (!contract || contract.toLowerCase() === ZERO) {
  bail('no L2Records address', 'pass --contract 0x… or set it in workers/api/wrangler.toml')
}
// Compare the ADDRESS, not how it arrived.
//
// The first version keyed off provenance (`!flag('contract')`), which answers "did the user
// type it?" — a different question from "is this the contract serving users?". Passing the
// live address verbatim to --contract therefore switched the guard off completely, and the
// live address is printed by `check:chain` and published in the README, CHANGELOG and launch
// post. The guard's own hint used to suggest --contract as the way forward, i.e. it taught
// the bypass.
const targetingLiveDeployment = !!liveAddress && contract.toLowerCase() === liveAddress.toLowerCase()

const parent = flag('parent')
if (!parent) bail('--parent is required', 'e.g. --parent community.eth')
if (!/^([a-z0-9-]+\.)+eth$/.test(parent)) bail(`"${parent}" is not a valid .eth name`, 'expected lowercase, ending in .eth')
const parentNode = namehash(parent)

const ABI = [
  { name: 'isRegistrar', type: 'function', stateMutability: 'view', inputs: [{ type: 'bytes32' }, { type: 'address' }], outputs: [{ type: 'bool' }] },
  { name: 'getRegistrarInfo', type: 'function', stateMutability: 'view', inputs: [{ type: 'bytes32' }, { type: 'address' }], outputs: [{ type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }] },
  { name: 'addRegistrar', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'bytes32' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }], outputs: [] },
  { name: 'removeRegistrar', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'bytes32' }, { type: 'address' }], outputs: [] },
  { name: 'owner', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  // The custom errors must be in the ABI or viem cannot name them, and explainRevert's
  // branches below never match. Without these the four tailored hints are dead code.
  { type: 'error', name: 'Unauthorized', inputs: [] },
  { type: 'error', name: 'QuotaExceeded', inputs: [] },
  { type: 'error', name: 'RegistrarExpired', inputs: [] },
  { type: 'error', name: 'ZeroAddress', inputs: [] },
]

const rpcUrl = process.env.OP_SEPOLIA_RPC_URL || net.defaultRpc
const pub = createPublicClient({ transport: http(rpcUrl) })

/** Map a contract revert onto the operator-facing cause. Generic reverts are unhelpful here. */
function explainRevert(e) {
  // viem puts the decoded custom-error name on cause.data.errorName. Reading shortMessage
  // first would never find it: shortMessage says "execution reverted" and the `||` chain then
  // short-circuits before reaching anything that carries the name. Same `||`-short-circuit
  // trap as the one fixed in check-chain.mjs during PR #22.
  const errorName = e?.cause?.data?.errorName ?? e?.data?.errorName
  const text = errorName ?? String(e?.shortMessage || e?.message || e)
  if (/Unauthorized/.test(text)) {
    return ['not the contract owner', 'addRegistrar/removeRegistrar are onlyOwner. Use the key that owns this deployment.']
  }
  if (/QuotaExceeded/.test(text)) {
    return ['the registrar has used its whole quota', 'raise it with updateRegistrarQuota, or grant again with a larger --quota']
  }
  if (/RegistrarExpired/.test(text)) {
    return ['the delegation has expired', 'grant again with a later --expiry (or omit --expiry for no expiry)']
  }
  if (/ZeroAddress/.test(text)) {
    return ['a zero address was supplied', 'check --to / --from']
  }
  // Never echo a raw URL — provider keys live in RPC URL paths.
  return [text.replace(/https?:\/\/[^\s"']+/g, '(redacted URL)'), undefined]
}

async function readStatus(who) {
  const [active, quota, expiry] = await pub.readContract({
    address: contract, abi: ABI, functionName: 'getRegistrarInfo', args: [parentNode, who],
  })
  const MAX = (1n << 256n) - 1n
  return {
    address: who,
    active,
    quota: quota === MAX ? 'unlimited' : quota.toString(),
    expiry: expiry === 0n ? 'never' : new Date(Number(expiry) * 1000).toISOString(),
    expired: expiry !== 0n && BigInt(Math.floor(Date.now() / 1000)) > expiry,
  }
}

if (command === 'status') {
  const who = flag('of')
  if (!who) {
    const owner = await pub.readContract({ address: contract, abi: ABI, functionName: 'owner' })
    const out = { parent, parentNode, contract, network: net.label, owner }
    if (asJson) console.log(JSON.stringify({ ok: true, ...out }, null, 2))
    else {
      console.log(`parent     ${parent}`)
      console.log(`node       ${parentNode}`)
      console.log(`contract   ${contract}  (${net.label})`)
      console.log(`owner      ${owner}`)
      console.log('')
      console.log('Pass --of 0x… to check a specific registrar.')
      console.log('Note: the owner bypasses the registrar allowlist entirely — a registrar')
      console.log('being inactive does NOT mean nobody can issue under this parent.')
    }
    process.exit(0)
  }
  const s = await readStatus(who)
  if (asJson) console.log(JSON.stringify({ ok: true, parent, ...s }, null, 2))
  else {
    console.log(`registrar  ${s.address}`)
    console.log(`parent     ${parent}`)
    console.log(`active     ${s.active}${s.expired ? '  (but EXPIRED)' : ''}`)
    console.log(`quota      ${s.quota}`)
    console.log(`expiry     ${s.expiry}`)
  }
  process.exit(0)
}

// ── write commands ────────────────────────────────────────────────────────────
//
// Refuse to write to the deployed contract unless the operator says so explicitly. The default
// address is read from wrangler.toml, which by definition names the deployment that is serving
// users right now — so the convenient default and the dangerous target are the same address.
// Reads stay unguarded; only grant/revoke need the acknowledgement.
if (targetingLiveDeployment && !argv.includes('--i-know-this-is-live')) {
  bail(
    `refusing to write to ${contract} — that is the DEPLOYED contract from workers/api/wrangler.toml`,
    'use --contract 0x… with YOUR OWN deployment (a different address), or add --i-know-this-is-live if you really do mean this one',
  )
}

const ownerKey = process.env.RECORDS_OWNER_PRIVATE_KEY ?? process.env.PRIVATE_KEY_JASON
if (!ownerKey || !/^0x[0-9a-fA-F]{64}$/.test(ownerKey)) {
  bail('no usable owner key', 'set RECORDS_OWNER_PRIVATE_KEY — addRegistrar/removeRegistrar are onlyOwner')
}
const account = privateKeyToAccount(ownerKey)
const wallet = createWalletClient({ account, transport: http(rpcUrl) })

const chainId = await pub.getChainId()
if (chainId !== net.chainId) {
  bail(`RPC is chain ${chainId}, expected ${net.chainId} (${net.label})`, 'this RPC points at a different network')
}

const onChainOwner = await pub.readContract({ address: contract, abi: ABI, functionName: 'owner' })
if (onChainOwner.toLowerCase() !== account.address.toLowerCase()) {
  bail(
    `${account.address} is not the owner of ${contract} (owner is ${onChainOwner})`,
    'the transaction would revert with Unauthorized — stopping before spending gas',
  )
}

const target = command === 'grant' ? flag('to') : flag('from')
if (!target || !/^0x[0-9a-fA-F]{40}$/.test(target)) {
  bail(`${command} requires ${command === 'grant' ? '--to' : '--from'} 0x…`, 'pass the registrar address')
}
if (target.toLowerCase() === ZERO) bail('refusing to use the zero address', 'check --to / --from')

try {
  let hash
  if (command === 'grant') {
    const quotaArg = flag('quota')
    const quota = quotaArg === undefined ? (1n << 256n) - 1n : BigInt(quotaArg)
    if (quotaArg === undefined && !asJson) {
      // Omitting --quota grants an UNLIMITED allowance. Saying so out loud means forgetting
      // the flag cannot quietly become "issue as many subdomains as you like, forever".
      console.log('NOTE: --quota not given → granting an UNLIMITED issuance allowance.')
      console.log('      Pass --quota N to cap it.')
    }
    const expiryArg = flag('expiry')
    let expiry = 0n
    if (expiryArg !== undefined) {
      const ms = Date.parse(expiryArg)
      if (Number.isNaN(ms)) bail(`--expiry "${expiryArg}" is not a valid date`, 'use ISO 8601, e.g. 2027-01-01T00:00:00Z')
      expiry = BigInt(Math.floor(ms / 1000))
      if (expiry <= BigInt(Math.floor(Date.now() / 1000))) {
        bail('--expiry is in the past', 'the delegation would be expired the moment it is created')
      }
    }
    hash = await wallet.writeContract({ address: contract, abi: ABI, functionName: 'addRegistrar', args: [parentNode, target, quota, expiry], chain: null })
  } else {
    hash = await wallet.writeContract({ address: contract, abi: ABI, functionName: 'removeRegistrar', args: [parentNode, target], chain: null })
  }
  await pub.waitForTransactionReceipt({ hash })

  // Read the result back. A receipt only says the transaction was mined, not that the state
  // is what was intended.
  const after = await readStatus(target)
  const expectedActive = command === 'grant'
  if (after.active !== expectedActive) {
    bail(`${command} did not take effect — isRegistrar is still ${after.active}`, 'investigate before relying on this state', 1)
  }

  if (asJson) console.log(JSON.stringify({ ok: true, command, parent, txHash: hash, ...after }, null, 2))
  else {
    console.log(`${command} ok — ${target} on ${parent}`)
    console.log(`  active   ${after.active}`)
    if (command === 'grant') {
      console.log(`  quota    ${after.quota}`)
      console.log(`  expiry   ${after.expiry}`)
    } else {
      console.log('')
      console.log('  NOTE: this revokes the REGISTRAR only. The contract owner still issues')
      console.log('  under this parent, overwrites records and transfers subdomain NFTs —')
      console.log('  removeRegistrar does not constrain them. If you meant "nobody can issue",')
      console.log('  that is not what just happened.')
    }
    console.log(`  tx       ${hash}`)
  }
} catch (e) {
  const [msg, hint] = explainRevert(e)
  bail(msg, hint, 1)
}
