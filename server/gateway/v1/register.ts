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
  txHash: Hex | undefined
}

export async function handleV1Register(
  payload: V1RegisterPayload,
  allowedSigners: string[],
  rootDomain: string,
  writer: L2RecordsWriter | undefined,
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

  const txHash = await writer?.registerSubnode(parentNode, lh, owner, label, addrBytes)

  return { ok: true, name: fullName, node, txHash }
}
