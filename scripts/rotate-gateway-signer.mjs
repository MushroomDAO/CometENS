// Gateway signer key rotation — plan, verify, execute.
//
// Usage:
//   node scripts/rotate-gateway-signer.mjs                    # dry run (default)
//   node scripts/rotate-gateway-signer.mjs --execute          # actually send transactions
//   node scripts/rotate-gateway-signer.mjs --new-signer 0x…   # address of the incoming key
//
// WHY THIS EXISTS
// The CCIP-Read gateway signs every resolution response with PRIVATE_KEY_SUPPLIER. That key
// is online 24/7 in a Worker, which makes it the most exposed key in the system — and on the
// current deployment it derives to the same address as the contract owner and the write EOA,
// so a single leak forges resolution AND seizes subdomains.
//
// Rotating it needs no redeploy, no multisig and no architecture decision: the resolvers keep
// an allowlist (`signers` mapping) with addSigner/removeSigner, so a new key can be authorised
// alongside the old one, cut over, and the old one revoked.
//
// WHY DRY RUN IS THE DEFAULT
// The steps are order-sensitive against LIVE infrastructure. Removing the old signer before
// the Worker actually serves with the new one takes global resolution down until someone
// notices. An accidental invocation must therefore do nothing, so execution requires an
// explicit --execute. Unattended automation is expected to run the dry run only.
import { createPublicClient, createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { sepolia, mainnet } from 'viem/chains'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

try {
  const envFile = readFileSync(join(REPO_ROOT, '.env.local'), 'utf8')
  for (const line of envFile.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=["']?(.+?)["']?\s*$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
} catch {
  /* absent .env.local is normal */
}

const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? undefined : argv[i + 1]
}
// Reject unknown flags rather than ignoring them. `--dry-run` was documented but never
// implemented: it "worked" only because unrecognised flags were silently dropped and dry run
// happens to be the default. A typo in a flag name on a script that can take global
// resolution down must not be silently treated as "do the default thing".
const BOOL_FLAGS = ['--execute', '--dry-run', '--revoke-old']
const VALUE_FLAGS = ['--new-signer', '--old-signer', '--resolver', '--env']
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (!a.startsWith('--')) continue
  if (BOOL_FLAGS.includes(a)) continue
  if (VALUE_FLAGS.includes(a)) { i++; continue }
  console.error(`unknown flag "${a}"`)
  console.error(`       → supported: ${[...BOOL_FLAGS, ...VALUE_FLAGS].join(' ')}`)
  process.exit(2)
}

// --dry-run WINS over --execute when both are present. If an operator's intent is ambiguous,
// the safe reading is the one that sends no transactions.
const dryRunRequested = argv.includes('--dry-run')
const execute = argv.includes('--execute') && !dryRunRequested
const revokeOld = argv.includes('--revoke-old')
const envName = flag('env') ?? 'testnet'

const NETWORKS = {
  testnet: { chain: sepolia, label: 'Ethereum Sepolia', rpcVar: 'SEPOLIA_RPC_URL' },
  production: { chain: mainnet, label: 'Ethereum Mainnet', rpcVar: 'ETH_RPC_URL' },
}
const net = NETWORKS[envName]
if (!net) {
  console.error(`unknown --env "${envName}" (expected: ${Object.keys(NETWORKS).join(' | ')})`)
  process.exit(2)
}

const RESOLVER_ABI = [
  { name: 'signers', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'bool' }] },
  { name: 'addSigner', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'address' }], outputs: [] },
  { name: 'removeSigner', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'address' }], outputs: [] },
  { name: 'owner', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
]

/**
 * The gateway worker's ALLOWED_SENDERS is the resolver whose signer allowlist we rotate —
 * wrangler.toml is what the deployed Worker actually reads, so it is the source of truth
 * here for the same reason check-chain.mjs reads it for the contract address.
 */
function resolverFromWrangler(section) {
  try {
    const toml = readFileSync(join(REPO_ROOT, 'workers/gateway/wrangler.toml'), 'utf8')
    const start = toml.indexOf(`[env.${section}.vars]`)
    if (start === -1) return undefined
    const rest = toml.slice(start)
    // Tolerate indented section headers — an indexOf('\n[') scan runs straight past them and
    // would read the NEXT env's value. Same defect found in check-chain.mjs during PR #22.
    const nextRel = rest.slice(1).search(/\n[ \t]*\[/)
    const block = nextRel === -1 ? rest : rest.slice(0, nextRel + 1)
    const m = block.match(/^\s*ALLOWED_SENDERS\s*=\s*"([^"]*)"/m)
    const first = m?.[1]?.split(',')[0]?.trim()
    return first && /^0x[0-9a-fA-F]{40}$/.test(first) ? first : undefined
  } catch {
    return undefined
  }
}

const resolver =
  flag('resolver') ??
  process.env.L1_OP_RESOLVER_ADDRESS ??
  process.env.L1_OFFCHAIN_RESOLVER_ADDRESS ??
  resolverFromWrangler(envName)
const newSigner = flag('new-signer')
const oldSigner = flag('old-signer') ?? derive(process.env.PRIVATE_KEY_SUPPLIER)
const rpcUrl = process.env[net.rpcVar]

function derive(key) {
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) return undefined
  try {
    return privateKeyToAccount(key).address
  } catch {
    return undefined
  }
}

/** Never echo a raw URL that may carry a provider key in its path. */
function redact(url) {
  if (!url) return '(not configured)'
  try {
    const u = new URL(url)
    const hasPath = u.pathname.replace(/^\/+|\/+$/g, '').length > 0 || u.search.length > 0
    return hasPath ? `${u.protocol}//${u.host}/…(redacted)` : `${u.protocol}//${u.host}`
  } catch {
    return '(unparseable URL)'
  }
}

function bail(msg, hint) {
  console.error(`ERROR  ${msg}`)
  if (hint) console.error(`       → ${hint}`)
  process.exit(2)
}

// A dry run must still print the plan when configuration is missing — the plan is the point,
// and an operator reading it for the first time has not configured anything yet. Only the
// execution path hard-fails on missing config.
if (!resolver && execute) {
  bail('no resolver address', 'pass --resolver 0x… or set L1_OP_RESOLVER_ADDRESS in .env.local')
}

// The four ordered steps. Each carries the check that must pass BEFORE the next one runs —
// that is the whole point: a rotation that skips verification is how the gateway goes dark.
const PLAN = [
  {
    n: 1,
    title: 'authorise the new signer',
    action: `addSigner(${newSigner ?? '<new signer address>'})`,
    verify: 'read signers(new) on-chain — must be true before continuing',
    reversible: 'yes — removeSigner(new) puts things back',
  },
  {
    n: 2,
    title: 'cut the Worker over to the new key',
    action: 'wrangler secret put PRIVATE_KEY_SUPPLIER --env <env>  (in workers/gateway)',
    verify: 'GET the gateway /health, then resolve a known name end-to-end and confirm the address still comes back',
    reversible: 'yes — put the old secret back; the old signer is still authorised at this point',
  },
  {
    n: 3,
    title: 'confirm live resolution is served by the new key',
    action: 'node scripts/proof-e2e.mjs <a known name> <expected address>',
    verify: 'must exit 0. Both signers are authorised here, so a failure means the Worker is broken, not the allowlist',
    reversible: 'yes — nothing has been revoked yet',
  },
  {
    n: 4,
    title: 'revoke the old signer',
    action: `removeSigner(${oldSigner ?? '<old signer address>'})`,
    verify: 'read signers(old) — must be false; then resolve once more to confirm nothing broke',
    reversible: 'yes but with a gap — addSigner(old) restores it; resolution is down in between if step 3 was skipped',
  },
]

console.log(`Gateway signer rotation — ${net.label}`)
console.log(`  resolver     ${resolver ?? '(not configured — pass --resolver 0x…)'}`)
console.log(`  rpc          ${redact(rpcUrl)}`)
console.log(`  old signer   ${oldSigner ?? '(unknown — set PRIVATE_KEY_SUPPLIER or pass --old-signer)'}`)
console.log(`  new signer   ${newSigner ?? '(not given — pass --new-signer 0x…)'}`)
console.log(`  mode         ${execute ? 'EXECUTE (will send transactions)' : 'DRY RUN (no transactions)'}`)
console.log('')

for (const s of PLAN) {
  console.log(`Step ${s.n}: ${s.title}`)
  console.log(`  action   ${s.action}`)
  console.log(`  verify   ${s.verify}`)
  console.log(`  rollback ${s.reversible}`)
  console.log('')
}

console.log('Order matters: steps 1-3 are all reversible and leave BOTH signers authorised.')
console.log('Only step 4 removes anything, and only after live resolution is confirmed working.')
console.log('Revoking before step 3 takes global resolution down until someone notices.')
console.log('')

if (!execute) {
  console.log('DRY RUN — nothing was sent. Re-run with --execute (and --new-signer) to perform it.')
  process.exit(0)
}

// ── Execution path ────────────────────────────────────────────────────────────
if (!revokeOld && (!newSigner || !/^0x[0-9a-fA-F]{40}$/.test(newSigner))) {
  bail('--execute requires a valid --new-signer 0x…', 'generate a fresh key, derive its address, pass the ADDRESS here')
}
if (revokeOld && (!oldSigner || !/^0x[0-9a-fA-F]{40}$/.test(oldSigner))) {
  bail('--revoke-old requires a valid --old-signer 0x…', 'pass the address of the key being retired')
}
// --new-signer is mandatory for the revoke too. Without it the "is a replacement actually
// authorised?" guard below has nothing to check and silently passes — and revoking the last
// remaining signer takes global resolution down. Requiring the address here means the guard
// always runs, rather than being conditional on the operator having remembered to pass it.
if (revokeOld && (!newSigner || !/^0x[0-9a-fA-F]{40}$/.test(newSigner))) {
  bail(
    '--revoke-old also requires --new-signer 0x…',
    'the replacement must be named so this script can verify it is authorised BEFORE revoking. Revoking the last signer takes resolution down.',
  )
}
// The "replacement is authorised" guard below is individually correct but does not imply
// "replacement is a DIFFERENT key from the one being revoked". Passing the same address twice
// satisfies it — signers(new) is true precisely because it IS the old signer — and the revoke
// then removes the only authorised signer, taking resolution down while every check reports
// success. The two addresses sit side by side on screen during a rotation; copying the wrong
// one is an ordinary slip, not an exotic input.
if (revokeOld && newSigner.toLowerCase() === oldSigner.toLowerCase()) {
  bail(
    '--new-signer and --old-signer are the same address',
    'revoking it would remove the only authorised signer and take global resolution down immediately',
  )
}
if (!rpcUrl) bail(`${net.rpcVar} is not set`, 'an L1 RPC is required to send these transactions')

const ownerKey = process.env.RESOLVER_OWNER_PRIVATE_KEY ?? process.env.PRIVATE_KEY_JASON
if (!derive(ownerKey)) {
  bail('no usable owner key', 'addSigner/removeSigner are onlyOwner; set RESOLVER_OWNER_PRIVATE_KEY')
}

const account = privateKeyToAccount(ownerKey)
const pub = createPublicClient({ chain: net.chain, transport: http(rpcUrl) })
const wallet = createWalletClient({ account, chain: net.chain, transport: http(rpcUrl) })

const onChainOwner = await pub.readContract({ address: resolver, abi: RESOLVER_ABI, functionName: 'owner' })
if (onChainOwner.toLowerCase() !== account.address.toLowerCase()) {
  bail(`configured key ${account.address} is not the resolver owner (${onChainOwner})`, 'addSigner/removeSigner would revert')
}

if (revokeOld) {
  // Step 4. Deliberately a separate invocation from step 1: it is the only irreversible-ish
  // action, and forcing a second explicit command means it cannot happen as a side effect of
  // starting a rotation. The guard below is the last line of defence if step 3 was skipped.
  const newStillAuthorised = await pub.readContract({
    address: resolver, abi: RESOLVER_ABI, functionName: 'signers', args: [newSigner],
  })
  if (!newStillAuthorised) {
    bail(
      `refusing to revoke: the incoming signer ${newSigner} is NOT authorised`,
      'revoking now would leave no valid signer and take resolution down. Run step 1 first.',
    )
  }
  console.log(`Step 4: removeSigner(${oldSigner}) …`)
  const tx = await wallet.writeContract({ address: resolver, abi: RESOLVER_ABI, functionName: 'removeSigner', args: [oldSigner] })
  await pub.waitForTransactionReceipt({ hash: tx })
  const stillOn = await pub.readContract({ address: resolver, abi: RESOLVER_ABI, functionName: 'signers', args: [oldSigner] })
  if (stillOn) bail('removeSigner did not take effect', 'signers(old) is still true — investigate before assuming the old key is retired')

  // Assert the invariant we actually care about, directly, AFTER the write: a valid signer
  // still exists. The pre-checks are pairwise reasoning about inputs; this reads the chain.
  // If it ever trips, resolution is already down and the operator needs to know now rather
  // than discover it from a user report.
  const replacementLive = await pub.readContract({ address: resolver, abi: RESOLVER_ABI, functionName: 'signers', args: [newSigner] })
  if (!replacementLive) {
    console.error('CRITICAL  the revoke succeeded but no authorised signer remains.')
    console.error(`          Restore immediately:  addSigner(${oldSigner})`)
    console.error('          Resolution is DOWN until a signer is authorised again.')
    process.exit(1)
  }
  console.log(`  ok — signers(${oldSigner}) = false, signers(${newSigner}) = true   tx ${tx}`)
  console.log('')
  console.log('Rotation complete. Destroy the old private key and re-run `pnpm preflight`')
  console.log('to confirm the key-role-reuse warning has changed.')
  process.exit(0)
}

console.log(`Step 1: addSigner(${newSigner}) …`)
const tx1 = await wallet.writeContract({ address: resolver, abi: RESOLVER_ABI, functionName: 'addSigner', args: [newSigner] })
await pub.waitForTransactionReceipt({ hash: tx1 })
const authorised = await pub.readContract({ address: resolver, abi: RESOLVER_ABI, functionName: 'signers', args: [newSigner] })
if (!authorised) bail('addSigner did not take effect', 'signers(new) is still false — stop and investigate before touching the Worker')
console.log(`  ok — signers(${newSigner}) = true   tx ${tx1}`)
console.log('')
console.log('STOP HERE. Steps 2-4 touch the live Worker and must be done deliberately:')
console.log('  2. wrangler secret put PRIVATE_KEY_SUPPLIER --env <env>   (in workers/gateway)')
console.log('  3. node scripts/proof-e2e.mjs <name> <expected address>   — must exit 0')
console.log(`  4. re-run with --revoke-old --old-signer ${oldSigner ?? '0x…'} once step 3 passes`)
console.log('')
console.log('This script deliberately does NOT chain steps 2-4 automatically: step 2 is a')
console.log('wrangler action outside this process, and automating the revoke would remove the')
console.log('only safety margin the rollback plan has.')
