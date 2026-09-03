/**
 * Where signing keys come from.
 *
 * Both workers used `privateKeyToAccount(env.SOME_KEY)` inline, which hardwired two things
 * that should be separate: WHICH key a role uses, and HOW that key signs. Pulling them apart
 * gives a seam for a KMS/TEE backend (TB.3) without touching any business logic, and keeps
 * self-hosting a one-environment-variable affair — the self-host path must never require our
 * infrastructure (see docs/agent/architecture.md).
 *
 * The abstraction is deliberately viem's `Account`, not a bespoke interface: viem's
 * `toAccount()` already accepts arbitrary sign functions, so a KMS-backed signer is a drop-in
 * at this boundary and nothing downstream changes.
 *
 * This module does NOT implement KMS. That is T1.5.3, and it needs infrastructure.
 */
import { privateKeyToAccount } from 'viem/accounts'
import type { Account, Hex } from 'viem'

/**
 * The three roles, kept distinct because one key doing all three means a single leak
 * forges resolution AND seizes subdomains. See TB.3 in docs/agent/tasks.md.
 */
export type SignerRole = 'writer' | 'gateway' | 'owner'

/**
 * Environment variable names per role, most specific first.
 *
 * The role-specific names come first so an operator can move to separated keys, while the
 * historical names keep working — an upgrade must not take a running deployment offline.
 * `pnpm preflight` check 3b reports whether separation was actually achieved.
 */
export const ROLE_ENV_VARS: Record<SignerRole, readonly string[]> = {
  writer: ['WRITER_KEY', 'WORKER_EOA_PRIVATE_KEY'],
  gateway: ['GATEWAY_SIGNER_KEY', 'PRIVATE_KEY_SUPPLIER'],
  owner: ['OWNER_KEY', 'PRIVATE_KEY_JASON'],
}

const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/

export class SignerError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message)
  }
}

/** Which variable supplied the key, for diagnostics. Never returns the key itself. */
export function resolveKeySource(
  role: SignerRole,
  env: Record<string, string | undefined>,
): { varName: string; legacy: boolean } | null {
  const names = ROLE_ENV_VARS[role]
  for (let i = 0; i < names.length; i++) {
    const v = env[names[i]]
    if (v !== undefined && v !== '') return { varName: names[i], legacy: i > 0 }
  }
  return null
}

/**
 * Build the signing account for a role.
 *
 * Throws with the variable NAME and never the value — an error string ends up in logs and
 * pasted reports, and this repo has already shipped one credential leak that way (#30).
 */
export function createSigner(role: SignerRole, env: Record<string, string | undefined>): Account {
  assertNoConflictingKeys(role, env)
  const source = resolveKeySource(role, env)
  if (!source) {
    throw new SignerError(
      `No signing key configured for role "${role}"`,
      `set ${ROLE_ENV_VARS[role][0]} (or the legacy ${ROLE_ENV_VARS[role][1]})`,
    )
  }
  const raw = env[source.varName] as string
  if (!PRIVATE_KEY_RE.test(raw)) {
    throw new SignerError(
      `${source.varName} is not a valid private key`,
      'expected 0x followed by 64 hex characters (66 in total)',
    )
  }
  return privateKeyToAccount(raw as Hex)
}

/**
 * Refuse to start when two names for the same role hold DIFFERENT keys.
 *
 * Before this module existed, the gateway read `PRIVATE_KEY_SUPPLIER` directly and
 * `GATEWAY_SIGNER_KEY` was inert. Introducing the preference order makes the new name an
 * effective input — so **the same set of secrets means something different before and after
 * the upgrade**. If both are present with different values, deploying silently swaps the
 * signing key.
 *
 * The three roles are not equally exposed, and the gateway one is the dangerous one:
 *   writer  — a wrong key fails loudly on the next write
 *   owner   — a wrong key reverts on onlyOwner, equally visible
 *   gateway — a wrong key is simply not in the resolver's `signers` allowlist, so
 *             `_verifySignature` reverts and resolution fails NETWORK-WIDE, while the deploy
 *             side reports nothing: /health does not sign, so health checks stay green.
 *             The failure only appears to users.
 *
 * Same value under both names is fine — that is what a careful migration looks like. An
 * operator genuinely switching keys deletes the old secret, which this permits.
 */
export function conflictingNames(
  role: SignerRole,
  env: Record<string, string | undefined>,
): string[] | null {
  const present = ROLE_ENV_VARS[role]
    .map((name) => ({ name, value: env[name] }))
    .filter((e): e is { name: string; value: string } => e.value !== undefined && e.value !== '')
  if (present.length < 2) return null

  const addresses = new Set<string>()
  for (const e of present) {
    if (!PRIVATE_KEY_RE.test(e.value)) continue
    addresses.add(privateKeyToAccount(e.value as Hex).address.toLowerCase())
  }
  return addresses.size > 1 ? present.map((e) => e.name) : null
}

function assertNoConflictingKeys(role: SignerRole, env: Record<string, string | undefined>): void {
  const names = conflictingNames(role, env)
  if (!names) return
  throw new SignerError(
    `${names.join(' and ')} are both set but hold different keys`,
    `refusing to start: which one wins changed with this upgrade, so deploying would silently swap the ${role} signer. Delete the one you are not using.`,
  )
}

/** Like createSigner but returns null instead of throwing, for optional paths. */
export function tryCreateSigner(
  role: SignerRole,
  env: Record<string, string | undefined>,
): Account | null {
  try {
    return createSigner(role, env)
  } catch {
    return null
  }
}

/**
 * Addresses per role, for diagnostics — never the keys.
 *
 * Used by preflight to report whether the roles are actually separated. Roles with no key
 * configured are omitted rather than reported as a shared address, because "not visible here"
 * and "same as another role" are different facts (see preflight check 3b).
 *
 * A CONFLICTING role is a third fact again, and this function CANNOT express it: the conflict
 * makes `createSigner` throw, `tryCreateSigner` swallows that, and the role comes back looking
 * exactly like an unconfigured one — reported as "not configured" by the very tool whose job is
 * to say what IS configured. That is not fixable here without changing the return type, so
 * **callers must consult `signerConflicts` as well**; preflight check 3b does.
 */
export function signerAddresses(env: Record<string, string | undefined>): Partial<Record<SignerRole, string>> {
  const out: Partial<Record<SignerRole, string>> = {}
  for (const role of Object.keys(ROLE_ENV_VARS) as SignerRole[]) {
    const account = tryCreateSigner(role, env)
    if (account) out[role] = account.address
  }
  return out
}

/** Roles whose two variable names hold different keys. Empty when the config is coherent. */
export function signerConflicts(
  env: Record<string, string | undefined>,
): Partial<Record<SignerRole, string[]>> {
  const out: Partial<Record<SignerRole, string[]>> = {}
  for (const role of Object.keys(ROLE_ENV_VARS) as SignerRole[]) {
    const names = conflictingNames(role, env)
    if (names) out[role] = names
  }
  return out
}
