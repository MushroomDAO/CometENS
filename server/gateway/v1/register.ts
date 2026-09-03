/**
 * Shared handler for POST /api/v1/register.
 * Used by vite.config.ts (dev server) and upstream-api.test.ts (E2E tests).
 * Both import this so there is one implementation to test.
 */
import {
  isAddress,
  recoverMessageAddress,
  namehash,
  labelhash,
  type Address,
  type Hex,
} from 'viem'
import type { L2RecordsWriter } from '../writer/L2RecordsWriter'

export interface V1RegisterPayload {
  label?: string
  owner?: string
  addr?: string
  timestamp?: number
  signature?: Hex
}

export interface V1RegisterResult {
  ok: boolean
  name: string
  node: Hex
  txHash?: Hex | undefined
  /** True when the name already belonged to the requested owner and nothing was written. */
  alreadyRegistered?: boolean
}

/** Reads the current on-chain owner of a node. Zero address means unregistered. */
export type SubnodeOwnerReader = (node: Hex) => Promise<string>

const ZERO = '0x0000000000000000000000000000000000000000'

/**
 * What to do about a label that already exists.
 *
 * Exported and pure so the rule is testable without a chain. The three cases are genuinely
 * different and collapsing any two of them is a bug:
 *
 *   unregistered      → register it
 *   already the same  → idempotent success. Upstream systems retry, and a duplicate job must
 *                       not turn into an error the integrator has to special-case.
 *   someone ELSE's    → refuse. This endpoint previously overwrote it and returned ok:true,
 *                       silently transferring a member's name to a different address — which
 *                       contradicts the one thing this product promises about subdomains.
 */
export function decideOnExisting(
  existingOwner: string,
  requestedOwner: string,
): { action: 'register' | 'noop' } | { action: 'refuse'; status: number; message: string } {
  if (!existingOwner || existingOwner.toLowerCase() === ZERO) return { action: 'register' }
  if (existingOwner.toLowerCase() === requestedOwner.toLowerCase()) return { action: 'noop' }
  return {
    action: 'refuse',
    status: 409,
    message: `Label is already registered to ${existingOwner}. Refusing to reassign it.`,
  }
}

export async function handleV1Register(
  payload: V1RegisterPayload,
  allowedSigners: string[],
  rootDomain: string,
  writer: L2RecordsWriter | undefined,
  readSubnodeOwner: SubnodeOwnerReader,
): Promise<V1RegisterResult> {
  const { signature, timestamp } = payload

  if (!signature || !signature.startsWith('0x')) {
    throw Object.assign(new Error('Missing signature'), { status: 401 })
  }
  if (!timestamp || typeof timestamp !== 'number') {
    throw Object.assign(new Error('Missing or invalid timestamp'), { status: 400 })
  }

  const drift = Math.abs(Math.floor(Date.now() / 1000) - timestamp)
  if (drift > 60) {
    throw Object.assign(
      new Error(`Timestamp drift too large (${drift}s). Must be within 60s of server time.`),
      { status: 401 },
    )
  }

  const label = payload.label?.trim().toLowerCase()
  if (!label || !/^[a-z0-9-]{1,63}$/.test(label)) {
    throw Object.assign(
      new Error('Invalid label: must be 1-63 lowercase alphanumeric or hyphen chars'),
      { status: 400 },
    )
  }

  const owner = payload.owner as Address | undefined
  if (!owner || !isAddress(owner)) {
    throw Object.assign(new Error('Invalid owner: must be a valid Ethereum address'), { status: 400 })
  }

  const message = `CometENS:register:${label}:${owner}:${timestamp}`
  const recovered = await recoverMessageAddress({ message, signature })
  if (!allowedSigners.map(a => a.toLowerCase()).includes(recovered.toLowerCase())) {
    throw Object.assign(
      new Error(`Signer ${recovered} is not in the allowed list`),
      { status: 401 },
    )
  }

  const parentNode = namehash(rootDomain) as Hex
  const lh = labelhash(label) as Hex
  const fullName = `${label}.${rootDomain}`
  const node = namehash(fullName) as Hex

  const addrTarget = (payload.addr && isAddress(payload.addr) ? payload.addr : owner) as Address
  // Address is a validated 20-byte hex string; viem encodes it correctly for `bytes calldata`.
  const addrBytes = addrTarget as Hex

  // Refuse to reassign someone else's name. Checked here rather than relying on the contract:
  // the worker EOA is the contract owner, so on-chain nothing stops the overwrite — the only
  // guard that can exist is this one.
  const existing = await readSubnodeOwner(node)
  const decision = decideOnExisting(existing, owner)
  if (decision.action === 'refuse') {
    throw Object.assign(new Error(decision.message), { status: decision.status, code: 'LABEL_TAKEN' })
  }
  if (decision.action === 'noop') {
    // Already exactly what was asked for. Report success without a transaction rather than
    // paying gas to write the same value, and say so — an integrator seeing no txHash should
    // be able to tell "already done" from "the write silently did not happen".
    return { ok: true, name: fullName, node, alreadyRegistered: true }
  }

  if (!writer) {
    throw Object.assign(new Error('Writer not configured on server'), { status: 503 })
  }
  const txHash = await writer.registerSubnode(parentNode, lh, owner, label, addrBytes)

  return { ok: true, name: fullName, node, txHash }
}
