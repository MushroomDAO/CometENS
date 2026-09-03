// Bootstrap a new community deployment on OP Sepolia.
//
// Usage:
//   node scripts/bootstrap-community.mjs --root community.eth --owner 0x… [--dry-run]
//   node scripts/bootstrap-community.mjs --root community.eth --owner 0x… --execute
//
// This is the "anyone can deploy this" path. A community that wants to run CometENS itself
// needs its own L2Records contract with ITS OWN address as owner — the deploy script in
// contracts/script/ hardwires the deployer as owner, which is fine for our own deployments
// but wrong for a community whose owner should be a multisig they control.
//
// Dry run is the default. Deploying is not destructive, but an accidental run spends testnet
// funds and leaves a stray contract that later confuses "which address is ours?" — the exact
// class of drift T1.0.1 existed to clean up.
import { createPublicClient, createWalletClient, http, namehash } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { staticChecks, probeChain, summarize, render, readEnvFiles, deploymentVars } from './preflight.mjs'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ARTIFACT = join(REPO_ROOT, 'contracts/out/L2RecordsV3.sol/L2RecordsV3.json')

const NETWORKS = {
  testnet: { chainId: 11155420, label: 'OP Sepolia', defaultRpc: 'https://sepolia.optimism.io' },
}

const argv = process.argv.slice(2)
const BOOL_FLAGS = ['--dry-run', '--execute', '--json']
const VALUE_FLAGS = ['--root', '--owner', '--env']

const flag = (n) => {
  const i = argv.indexOf(`--${n}`)
  return i === -1 ? undefined : argv[i + 1]
}

function bail(msg, hint, code = 2) {
  console.error(`ERROR  ${msg}`)
  if (hint) console.error(`       → ${hint}`)
  process.exit(code)
}

// Unknown flags are rejected, not ignored. A dropped `--owner` would silently deploy with
// whatever the fallback is, and the owner is the single most consequential argument here.
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (!a.startsWith('--')) continue
  if (BOOL_FLAGS.includes(a)) continue
  if (VALUE_FLAGS.includes(a)) { i++; continue }
  bail(`unknown flag "${a}"`, `supported: ${[...BOOL_FLAGS, ...VALUE_FLAGS].join(' ')}`)
}

// --dry-run wins over --execute: when the intent is ambiguous, take the reading that spends
// nothing and creates nothing.
const dryRun = argv.includes('--dry-run') || !argv.includes('--execute')
const envName = flag('env') ?? 'testnet'
const net = NETWORKS[envName]
if (!net) bail(`unknown --env "${envName}"`, `supported: ${Object.keys(NETWORKS).join(' | ')} (mainnet is out of scope — see roadmap M2)`)

const root = flag('root')
const owner = flag('owner')
if (!root) bail('--root is required', 'the .eth name this deployment will issue subdomains under, e.g. --root community.eth')
if (!/^([a-z0-9-]+\.)+eth$/.test(root)) bail(`"${root}" is not a valid .eth name`, 'expected lowercase, ending in .eth')
if (!owner || !/^0x[0-9a-fA-F]{40}$/.test(owner)) {
  bail('--owner is required', 'the address that will own the deployment. Use a multisig you control, not a hot key.')
}
if (owner.toLowerCase() === '0x0000000000000000000000000000000000000000') {
  bail('--owner cannot be the zero address', 'the constructor rejects it, and an unowned contract can never issue subdomains')
}

const rootNode = namehash(root)

console.log(`Bootstrap a CometENS deployment — ${net.label}`)
console.log(`  root domain  ${root}`)
console.log(`  namehash     ${rootNode}`)
console.log(`  owner        ${owner}`)
console.log(`  mode         ${dryRun ? 'DRY RUN (nothing is deployed)' : 'EXECUTE (will deploy a contract)'}`)
console.log('')

// ── Step 1: preflight ─────────────────────────────────────────────────────────
// Running the checks here rather than telling the reader to run them separately: a bootstrap
// that proceeds on a broken RPC produces a confusing failure three steps later.
console.log('Step 1: preflight')
const env = { ...deploymentVars(envName, REPO_ROOT), ...readEnvFiles(REPO_ROOT), ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v)) }
const findings = staticChecks(env, envName)
findings.push(...(await probeChain(env, envName)))
const s = summarize(findings)
console.log(render(findings, false).split('\n').map((l) => `  ${l}`).join('\n'))
if (s.fail > 0) {
  bail('preflight found failures — not bootstrapping on a broken configuration', 'fix the FAIL items above, then re-run', 1)
}
console.log('')

// ── Step 2: contract artifact ─────────────────────────────────────────────────
console.log('Step 2: contract artifact')
if (!existsSync(ARTIFACT)) {
  console.log('  out/ missing — running `forge build`…')
  try {
    execFileSync('forge', ['build'], { cwd: join(REPO_ROOT, 'contracts'), stdio: 'pipe' })
  } catch (e) {
    bail('forge build failed', 'install Foundry (https://getfoundry.sh) and run `forge build` in contracts/', 1)
  }
}
const artifact = JSON.parse(readFileSync(ARTIFACT, 'utf8'))
const bytecode = artifact.bytecode?.object
if (!bytecode || bytecode === '0x') bail('artifact has no bytecode', 'run `forge build` in contracts/ and retry', 1)
console.log(`  L2RecordsV3 artifact ok (${artifact.abi.length} ABI entries)`)
console.log('')

// ── Step 3: deploy ────────────────────────────────────────────────────────────
console.log('Step 3: deploy L2RecordsV3')
let deployedAt = '<address printed here after --execute>'

if (dryRun) {
  console.log(`  would deploy L2RecordsV3(owner=${owner}) to ${net.label}`)
  console.log('  (dry run — no transaction sent)')
} else {
  const rpcUrl = process.env.OP_SEPOLIA_RPC_URL || net.defaultRpc
  const key = process.env.DEPLOYER_PRIVATE_KEY ?? process.env.PRIVATE_KEY_JASON
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    bail('no deployer key', 'set DEPLOYER_PRIVATE_KEY (the account paying gas — it need NOT be the owner)')
  }
  const account = privateKeyToAccount(key)
  const pub = createPublicClient({ transport: http(rpcUrl) })
  const chainId = await pub.getChainId()
  if (chainId !== net.chainId) bail(`RPC is chain ${chainId}, expected ${net.chainId}`, 'this RPC points at a different network')

  const balance = await pub.getBalance({ address: account.address })
  if (balance === 0n) bail(`deployer ${account.address} has no balance`, 'fund it with testnet ETH and retry')

  const wallet = createWalletClient({ account, transport: http(rpcUrl) })
  console.log(`  deploying from ${account.address}…`)
  const hash = await wallet.deployContract({ abi: artifact.abi, bytecode, args: [owner], chain: null })
  const receipt = await pub.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success' || !receipt.contractAddress) {
    bail(`deployment transaction failed (${hash})`, 'check the transaction on the explorer', 1)
  }
  deployedAt = receipt.contractAddress

  // Print the address BEFORE verifying. Gas has already been spent at this point; if the
  // verification below fails for any reason, the operator must still walk away knowing what
  // was deployed. An earlier version threw here and the address was lost with the stack trace.
  console.log(`  deployed at  ${deployedAt}`)
  console.log(`  tx           ${hash}`)

  // Verify the constructor argument actually took. A receipt says the transaction was mined,
  // not that the contract is owned by who was asked for.
  //
  // Retried: a read issued immediately after deployment can hit a load-balanced node that has
  // not caught up and returns "0x" for a contract that exists. Observed on the public OP
  // Sepolia endpoint — the deploy had succeeded and owner() was correct one second later.
  const OWNER_ABI = [{ name: 'owner', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }]
  let onChainOwner
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      onChainOwner = await pub.readContract({ address: deployedAt, abi: OWNER_ABI, functionName: 'owner' })
      break
    } catch (e) {
      if (attempt === 5) {
        console.error('')
        console.error(`WARN   could not read owner() after 5 attempts: ${String(e?.shortMessage || e?.message || e).split('\n')[0]}`)
        console.error(`       The contract IS deployed at ${deployedAt} — verify manually before using it:`)
        console.error(`         cast call ${deployedAt} 'owner()(address)' --rpc-url <your rpc>`)
        console.error(`       Expected: ${owner}`)
        break
      }
      await new Promise((r) => setTimeout(r, 1000 * attempt))
    }
  }
  if (onChainOwner && onChainOwner.toLowerCase() !== owner.toLowerCase()) {
    bail(`deployed contract owner is ${onChainOwner}, expected ${owner} — do NOT use this deployment`, `it was deployed at ${deployedAt}`, 1)
  }
  if (onChainOwner) console.log(`  owner()      ${onChainOwner}  ✓ matches --owner`)
}
console.log('')

// ── Step 4: the finishing checklist ───────────────────────────────────────────
// Printed in both modes on purpose: someone evaluating whether to adopt this needs to see
// what they are signing up for BEFORE spending anything.
console.log('Step 4: finish the setup — copy the values below')
console.log('')
console.log('  A. workers/api/wrangler.toml and workers/gateway/wrangler.toml, [env.testnet.vars]:')
console.log(`       L2_RECORDS_ADDRESS = "${deployedAt}"`)
console.log(`       ROOT_DOMAIN        = "${root}"`)
console.log('')
console.log('  B. You also need an L1 resolver — this script does NOT deploy one.')
console.log('     It is a separate contract on Ethereum, and you have two options:')
console.log('       • deploy your own:')
console.log('           cd contracts && forge script script/DeployHybridResolver.s.sol \\')
console.log('             --rpc-url <eth sepolia rpc> --broadcast --slow')
console.log('       • or use an existing operator resolver (then you are in the delegated')
console.log('         model — read docs/DELEGATED-HOSTING.md first, it is not free of trust)')
console.log('')
console.log('  C. .env.local (local tooling only — never commit it).')
console.log('     All four are required by the verification in E; the first two come from')
console.log('     above, the last two from step B:')
console.log(`       VITE_ROOT_DOMAIN=${root}`)
console.log(`       VITE_L2_RECORDS_ADDRESS=${deployedAt}`)
console.log('       VITE_L1_OFFCHAIN_RESOLVER_ADDRESS=<your L1 resolver from step B>')
console.log('       VITE_L1_SEPOLIA_RPC_URL=<an Ethereum Sepolia RPC>')
console.log('')
console.log(`  D. On Ethereum ENS, set the resolver for ${root} to that L1 resolver.`)
console.log('     This script deliberately does NOT do it for you: it is a transaction on a')
console.log('     name you own, from an account this tool has no business holding.')
console.log('')
console.log('  E. Verify, in this order:')
console.log('       pnpm check:chain      # chainId + contract + owner — needs nothing else')
console.log('       pnpm preflight        # full configuration check — needs nothing else')
console.log(`       bash scripts/resolve-testnet.sh alice.${root}`)
console.log('                             # end-to-end resolution — needs all four vars in C')
console.log('')
console.log('     The .sh form is listed rather than resolve-testnet.ts because running a .ts')
console.log('     file directly depends on the Node version stripping types, and tsx is not a')
console.log('     dependency of this repo.')
console.log('')

if (dryRun) {
  console.log('DRY RUN — nothing was deployed. Re-run with --execute to perform it.')
}
