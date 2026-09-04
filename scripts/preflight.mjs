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
import { execFileSync } from 'node:child_process'
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

/**
 * The three key roles, each with its variable names most-specific-first.
 *
 * This table MUST stay in step with ROLE_ENV_VARS in server/gateway/signer.ts — that is what
 * the workers actually read. It is duplicated rather than imported because preflight is a
 * plain .mjs script that node runs directly and cannot import a .ts module; a test asserts
 * the two agree, so drift fails loudly instead of making preflight check the wrong variables.
 */
export const KEY_ROLES = [
  { names: ['WRITER_KEY', 'WORKER_EOA_PRIVATE_KEY'], role: 'writer (L2 transactions)' },
  { names: ['GATEWAY_SIGNER_KEY', 'PRIVATE_KEY_SUPPLIER'], role: 'gateway signer (CCIP-Read responses)' },
  { names: ['OWNER_KEY', 'PRIVATE_KEY_JASON'], role: 'deployer / owner' },
]

/**
 * Whether a shared key is a warning or a hard failure.
 *
 * Self-hosting starts with one key doing everything and that is a reasonable place to begin —
 * failing there would block a first deployment over a risk the operator may knowingly accept.
 * A delegated deployment holds other communities' names, so the same finding is disqualifying.
 * Set PREFLIGHT_KEY_SEPARATION=strict there (docs/DELEGATED-HOSTING.md says to).
 */
export function separationSeverity(env) {
  const raw = env.PREFLIGHT_KEY_SEPARATION
  if (raw === undefined || raw === '') return 'WARN'
  const v = String(raw).toLowerCase()
  if (v === 'strict') return 'FAIL'
  if (v === 'warn') return 'WARN'
  // Refusing to guess, for the same reason resolveMode does in server/gateway/approval.ts:
  // guessing wrong here silently DOWNGRADES a safety gate. The person who sets this variable
  // is a delegated operator at the exact moment they care most that separation is enforced —
  // a typo like `stict` must not leave them believing strict is on while preflight stays green.
  throw new Error(
    `Invalid PREFLIGHT_KEY_SEPARATION "${raw}" — expected "strict" or "warn" (or unset). ` +
      'Refusing to guess: guessing wrong turns a hard gate into a warning.',
  )
}

/** First non-empty variable for a role, mirroring resolveKeySource in signer.ts. */
export function resolveRoleKey(names, env) {
  for (let i = 0; i < names.length; i++) {
    const v = env[names[i]]
    if (v !== undefined && v !== '') return { varName: names[i], value: v, legacy: i > 0 }
  }
  return null
}

/**
 * Two names for one role holding DIFFERENT keys.
 *
 * The workers REFUSE TO START on this (see assertNoConflictingKeys in signer.ts), because
 * which name wins changed when the role-specific names were introduced — so deploying would
 * silently swap the signer. preflight has to report it, or the operator meets it as a dead
 * gateway with a green health check.
 */
export function roleKeyConflicts(env) {
  const out = []
  for (const { names, role } of KEY_ROLES) {
    const present = names.filter((n) => env[n] !== undefined && env[n] !== '')
    if (present.length < 2) continue
    const addrs = new Set(present.map((n) => addressOf(env[n])).filter(Boolean))
    if (addrs.size > 1) out.push({ role, names: present })
  }
  return out
}

const ENS_NAME_RE = /^([a-z0-9-]+\.)+eth$/
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
/** wrangler.toml carries a zero-address placeholder for undeployed envs — not a real value. */
const nonZero = (v) => (v && v.toLowerCase() !== ZERO_ADDRESS ? v : undefined)

/**
 * Load Vite's dotenv files into a plain object without touching process.env.
 *
 * Reading only .env.local left the detection surface narrower than the exposure surface:
 * Vite also loads .env and .env.[mode], so a VITE_-prefixed key placed in .env would have
 * been reported PASS. Precedence follows Vite's own (more specific wins).
 */
export function readEnvFiles(root = REPO_ROOT, mode = 'production') {
  const files = ['.env', `.env.${mode}`, '.env.local', `.env.${mode}.local`]
  let out = {}
  for (const f of files) out = { ...out, ...readOneEnvFile(join(root, f)) }
  return out
}

/** Load a single dotenv file into a plain object. */
export function readOneEnvFile(path) {
  try {
    const raw = readFileSync(path, 'utf8')
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

/** Back-compat alias — .env.local only. */
export const readEnvFile = (root = REPO_ROOT) => readOneEnvFile(join(root, '.env.local'))

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

/**
 * The wrangler values as COMMITTED in git, i.e. the reference deployment this repo ships.
 *
 * Compared against the working tree so the warning disappears the moment an operator edits
 * the file to their own values — which is exactly the signal we want, and it maintains itself
 * when we redeploy (a hardcoded constant would go stale and silently stop warning).
 *
 * Returns null when git is unavailable (a tarball download, say). Callers must treat null as
 * "could not check", never as "no defaults in use".
 */
export function repoCommittedVars(envName, root = REPO_ROOT) {
  try {
    const toml = execFileSync('git', ['show', `HEAD:workers/api/wrangler.toml`], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    })
    const start = toml.indexOf(`[env.${envName}.vars]`)
    if (start === -1) return {}
    const rest = toml.slice(start)
    const nextRel = rest.slice(1).search(/\n[ \t]*\[/)
    const block = nextRel === -1 ? rest : rest.slice(0, nextRel + 1)
    const out = {}
    for (const line of block.split('\n')) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*"([^"]*)"/)
      if (m && m[2] !== '') out[m[1]] = m[2]
    }
    return out
  } catch {
    return null
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
export function staticChecks(env, envName = 'testnet', repoDefaults = undefined) {
  const net = NETWORKS[envName]
  const out = []
  const add = (id, level, title, detail, hint) => out.push({ id, level, title, detail, hint })

  /**
   * Values that came from the repo's own committed wrangler.toml rather than from anything
   * the operator set.
   *
   * Without this the checks are actively misleading on a fresh clone: wrangler.toml carries
   * the reference deployment, so `pnpm preflight` reported "all present" with OUR root domain,
   * OUR contract and OUR owner — 7 passed, 0 failures — to someone who had configured nothing.
   * That is the first step of SELF-HOSTING.md, and false confidence there propagates through
   * every later step.
   *
   * Same shape as the provenance bug fixed in check-chain.mjs: a tool must not report a value
   * without saying where it came from, especially when the convenient default is someone else's.
   */
  const defaults = repoDefaults ?? {}
  const isRepoDefault = (key, value) =>
    value !== undefined && defaults[key] !== undefined && String(defaults[key]) === String(value)

  // 1 — required variables
  const required = [
    ['L2_RECORDS_ADDRESS', nonZero(env.L2_RECORDS_ADDRESS || env.OP_L2_RECORDS_ADDRESS || env.VITE_L2_RECORDS_ADDRESS)],
    ['ROOT_DOMAIN', env.ROOT_DOMAIN || env.VITE_ROOT_DOMAIN],
  ]
  const missing = required.filter(([, v]) => !v).map(([k]) => k)
  if (missing.length) {
    add(1, 'FAIL', 'required configuration', `missing: ${missing.join(', ')}`,
      'copy .env.op-sepolia to .env.local and fill these in')
  } else {
    const addrKey = env.L2_RECORDS_ADDRESS ? 'L2_RECORDS_ADDRESS' : 'L2_RECORDS_ADDRESS'
    const fromRepo = [
      isRepoDefault('L2_RECORDS_ADDRESS', env.L2_RECORDS_ADDRESS) ? 'L2_RECORDS_ADDRESS' : null,
      isRepoDefault('ROOT_DOMAIN', env.ROOT_DOMAIN) ? 'ROOT_DOMAIN' : null,
    ].filter(Boolean)
    if (fromRepo.length) {
      add(1, 'WARN', 'required configuration',
        `present, but ${fromRepo.join(' and ')} ${fromRepo.length > 1 ? 'still hold' : 'still holds'} the repo's example value${fromRepo.length > 1 ? 's' : ''}`,
        "this is OUR reference deployment as shipped in workers/*/wrangler.toml, not yours. Run `pnpm bootstrap:community` and put YOUR addresses there before relying on any check below.")
    } else {
      add(1, 'PASS', 'required configuration', 'all present (from your own configuration)')
    }
  }

  // The RPC is reported separately rather than listed as a "required" variable: there is
  // always a working public default, so folding it into the missing-list made that entry
  // impossible to ever trigger — a check that cannot fail is not a check.
  const explicitRpc = env.OP_SEPOLIA_RPC_URL || env.VITE_L2_RPC_URL
  add('1b', 'PASS', 'RPC endpoint',
    explicitRpc ? 'configured explicitly' : `not configured — using the public default (${net?.defaultRpc})`)

  // 2 — private key format. Report the KEY NAME and validity, never the value.
  const badFormat = []
  const present = []
  // Every name a role can be set under, not just the preferred one: a malformed key under the
  // legacy name is exactly as fatal, and checking only the new name would report PASS on a
  // deployment whose actual key is unusable.
  for (const { names } of KEY_ROLES) {
    for (const name of names) {
      const v = env[name]
      if (!v) continue
      present.push(name)
      if (!PRIVATE_KEY_RE.test(v)) badFormat.push(name)
    }
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

  // 3a — a provider key hidden inside a VITE_ URL.
  //
  // Check 3 above only looks for PRIVATE-KEY shapes, so it says PASS on
  // `VITE_L2_RPC_URL=https://opt-sepolia.g.alchemy.com/v2/<key>` — and that URL is compiled
  // into the bundle and served to every visitor, key included.
  //
  // Not hypothetical: building this repo with a real `.env.local` and grepping `dist/` found
  // two Alchemy keys in the JS, minutes before a frontend deploy that would have published
  // them. And SELF-HOSTING.md walks the reader straight into it — it says
  // `VITE_L1_SEPOLIA_RPC_URL=<一个 Ethereum Sepolia RPC>`, and for most people that string is
  // a provider URL with their key in the path.
  //
  // WARN, not FAIL: a `VITE_` RPC URL is legitimate — the browser has to read the chain from
  // somewhere. What it must not carry is a credential. Public endpoints
  // (https://sepolia.optimism.io) do the same job for a frontend that only reads.
  const PROVIDER_KEY_IN_URL = /https?:\/\/[^\s"']*\/(v2|v3)\/[A-Za-z0-9_-]{16,}/
  const urlKeys = Object.keys(env).filter(
    (k) => k.startsWith('VITE_') && PROVIDER_KEY_IN_URL.test(env[k] ?? ''),
  )
  if (urlKeys.length) {
    add(3, 'WARN', 'provider key inside a VITE_ URL', `bundled and served publicly: ${urlKeys.join(', ')}`,
      'The key is in the URL path, so `pnpm build` bakes it into dist/ and anyone loading the page can read it. ' +
      'Use a public RPC for VITE_ variables, or accept that this key is public and restrict it at the provider.')
  } else {
    // Says what it looked for, not "nothing is exposed". The reviewer measured the gap on 8
    // real provider URL shapes: Alchemy and Infura are caught; QuickNode (`quiknode.pro/<key>/`),
    // Ankr, dRPC (`?dkey=`), Chainstack and BlastAPI are NOT. Widening the pattern to reach them
    // is the wrong fix for the same reason the `0x{64}` scan was deleted: `quiknode.pro/<32hex>/`
    // is indistinguishable from an uncredentialed path segment, so it would start false-positiving,
    // and a check that cries wolf gets ignored. Narrow and honest beats wide and noisy.
    add(3, 'PASS', 'provider key inside a VITE_ URL', 'no VITE_ URL carries a `/v2/<key>` or `/v3/<key>` credential')
  }

  // 3b — role separation. One key for all three roles means a single leak lets an attacker
  // both forge resolution responses and seize subdomains.
  //
  // Crucially this must distinguish "checked, and they are separate" from "only one role was
  // visible from here". Reporting PASS on a single visible key is a false assurance, and it is
  // the NORMAL case for the deployment shape TB.3 recommends (owner key cold, the rest held as
  // Workers secrets) — precisely the configuration whose separation most needs stating
  // honestly. Shaped like check 2, which already gets the "nothing to look at" case right.
  // Validate the severity knob BEFORE anything can short-circuit past it.
  //
  // Called lazily it only ran when a shared key was actually found — so an operator who typed
  // `stict` while their keys happened to be separate got no signal at all, and would meet the
  // downgrade later, at the exact moment a key started being shared. The knob has to be
  // checked because it was SET, not because it was needed.
  const severity = separationSeverity(env)

  // A CONFLICT outranks everything else here: the workers will not start at all, so reporting
  // anything about separation first would bury the finding that stops the deployment dead.
  const conflicts = roleKeyConflicts(env)
  if (conflicts.length) {
    const c = conflicts[0]
    add('3b', 'FAIL', 'key role separation', `${c.names.join(' and ')} are both set but hold different keys (${c.role})`,
      'the workers refuse to start on this: which name wins changed when the role-specific names were introduced, so deploying would silently swap this signer. Delete the one you are not using.')
  } else {

  const byAddress = new Map()
  const unseen = []
  const legacyNames = []
  for (const { names, role } of KEY_ROLES) {
    const found = resolveRoleKey(names, env)
    const addr = found ? addressOf(found.value) : null
    if (!addr) {
      // Name BOTH: telling an operator on legacy names to "set GATEWAY_SIGNER_KEY" walks them
      // straight into the conflict that makes the workers refuse to start.
      unseen.push(`${names[0]} (or legacy ${names[1]})`)
      continue
    }
    if (found.legacy) legacyNames.push(`${found.varName} → ${names[0]}`)
    if (!byAddress.has(addr)) byAddress.set(addr, [])
    byAddress.get(addr).push(role)
  }
  const shared = [...byAddress.entries()].filter(([, roles]) => roles.length > 1)
  if (shared.length) {
    const [addr, roles] = shared[0]
    add('3b', severity, 'key role separation', `${addr} serves ${roles.length} roles: ${roles.join(', ')}`,
      'one leak of this key compromises every role at once. Use a separate key per role; keep the owner key cold and out of the routine write path. Delegated deployments should set PREFLIGHT_KEY_SEPARATION=strict so this fails instead of warning.')
  } else if (byAddress.size === 0) {
    add('3b', 'WARN', 'key role separation', 'not verified — no signing keys visible here',
      'all three keys live elsewhere (Workers secrets / cold storage). Separation cannot be checked from this machine; verify it where the keys are held.')
  } else if (unseen.length) {
    add('3b', 'WARN', 'key role separation', `only ${byAddress.size} of ${KEY_ROLES.length} roles visible — not verified for: ${unseen.join(', ')}`,
      'the keys not visible here may or may not differ from the ones that are. This is normal when they live in Workers secrets, but it means separation is unverified, not confirmed.')
  } else {
    add('3b', 'PASS', 'key role separation', `${byAddress.size} distinct key(s) across all ${KEY_ROLES.length} roles`)
  }

  // Reported separately from separation: using the legacy name is not a security finding, it
  // just means this deployment predates the rename and will keep working.
  if (legacyNames.length) {
    add('3c', 'WARN', 'legacy key variable names', legacyNames.join(', '),
      'these still work and nothing breaks today. Renaming makes the role explicit — but set only ONE name per role: setting both with different keys makes the workers refuse to start.')
  }

  }

  // 3d — the frontend's URLs still point at the reference deployment.
  //
  // src/config.ts falls back to OUR workers when VITE_API_URL / VITE_GATEWAY_URL are unset.
  // That default is right for someone hacking on this repo and wrong for a self-hoster: their
  // build silently routes resolution and writes through our infrastructure, and nothing in the
  // build output says so. Acceptance criterion A4 is "no step needs our worker" — this check
  // is what makes that verifiable instead of assumed.
  const REFERENCE_HOSTS = ['cometens-api.jhfnetboy.workers.dev', 'cometens-gateway.jhfnetboy.workers.dev']
  const frontendUrls = [
    { name: 'VITE_API_URL', value: env.VITE_API_URL, fallback: REFERENCE_HOSTS[0] },
    { name: 'VITE_GATEWAY_URL', value: env.VITE_GATEWAY_URL, fallback: REFERENCE_HOSTS[1] },
  ]
  const pointingAtUs = frontendUrls.filter(
    (u) => !u.value || REFERENCE_HOSTS.some((h) => String(u.value).includes(h)),
  )
  if (pointingAtUs.length) {
    add('3d', 'WARN', 'frontend targets your own workers',
      pointingAtUs.map((u) => (u.value ? `${u.name}=${u.value}` : `${u.name} unset → defaults to ${u.fallback}`)).join(', '),
      'a self-hosted frontend built like this routes resolution and writes through OUR workers. Set both to your own deployed workers. (If you ARE working on this repo, this warning is expected.)')
  } else {
    add('3d', 'PASS', 'frontend targets your own workers', 'neither URL points at the reference deployment')
  }

  // 8 — root domain shape
  const root = env.ROOT_DOMAIN || env.VITE_ROOT_DOMAIN
  if (root && !ENS_NAME_RE.test(root)) {
    add(8, 'FAIL', 'root domain', `"${root}" is not a valid .eth ENS name`,
      'expected something like community.eth (lowercase, ends in .eth)')
  } else if (root) {
    add(8, isRepoDefault('ROOT_DOMAIN', root) ? 'WARN' : 'PASS', 'root domain',
      isRepoDefault('ROOT_DOMAIN', root) ? `${root} — the repo's example value, not yours` : root,
      isRepoDefault('ROOT_DOMAIN', root) ? 'set ROOT_DOMAIN in workers/*/wrangler.toml to your own .eth name' : undefined)
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
  const writer = addressOf(resolveRoleKey(KEY_ROLES[0].names, env)?.value)
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
    // Honour --json even on usage errors, or a caller piping into jq dies on the one path
    // it cannot anticipate. Same fix already applied to check-chain.mjs.
    const msg = `unknown --env "${envName}" (expected: ${Object.keys(NETWORKS).join(' | ')})`
    if (asJson) console.log(JSON.stringify({ ok: false, error: msg }, null, 2))
    else console.error(msg)
    process.exit(2)
  }

  // Precedence, lowest to highest: wrangler.toml (what is deployed) < .env.local (local
  // overrides) < exported shell variables (explicit, one-off). Matching the rest of the repo.
  const env = {
    ...deploymentVars(envName),
    ...readEnvFiles(),
    ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v)),
  }

  const committed = repoCommittedVars(envName)
  if (committed === null) {
    console.error('note: could not read the committed wrangler.toml (no git?) — cannot tell your values from the repo\'s examples')
  }
  // A misconfigured variable is the user's mistake, not a crash. Without this a typo in
  // PREFLIGHT_KEY_SEPARATION printed a Node stack trace — which reads as "the tool is broken",
  // exactly the wrong conclusion when the tool is in fact refusing to guess on their behalf.
  let findings
  try {
    findings = staticChecks(env, envName, committed ?? undefined)
  } catch (e) {
    const msg = e?.message ?? String(e)
    if (asJson) console.log(JSON.stringify({ ok: false, error: msg }, null, 2))
    else console.error(`preflight: ${msg}`)
    process.exit(2)
  }
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
