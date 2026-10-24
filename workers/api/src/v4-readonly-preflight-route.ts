import type { Address, Hex } from 'viem'
import { preflightV4SignedIssuance, V4PreflightDenied, type V4IssuanceIntent, type V4IssuancePin } from './v4-issuance-preflight'

type V4Config = {
  NETWORK: string
  V4_PREFLIGHT_ENABLED?: string
  V4_PREFLIGHT_CONTRACT?: string
  V4_PREFLIGHT_CODEHASH?: string
  V4_PREFLIGHT_PARENT_NODE?: string
}

type Reader = Parameters<typeof preflightV4SignedIssuance>[0]
const DECIMAL = /^(0|[1-9][0-9]*)$/
const FIELDS = ['operator', 'label', 'member', 'initialAddr', 'nonce', 'deadline', 'signature']
const denied = (status: number, error: string) => ({ status, body: { error, preflightOnly: true, nativeAuthorityVerified: false } })
const MAX_BODY_BYTES = 8192

async function boundedBody(request: Request): Promise<string | null> {
  const declared = request.headers.get('content-length')
  if (declared !== null && (!DECIMAL.test(declared) || Number(declared) > MAX_BODY_BYTES)) return null
  if (!request.body) return ''
  const reader = request.body.getReader()
  const parts: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > MAX_BODY_BYTES) return null
      parts.push(value)
    }
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const part of parts) { bytes.set(part, offset); offset += part.byteLength }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
}

/** Optional, intentionally unsigned, OP APPLICATION-ONLY preflight; never consumes nonce or forwards a write. */
export async function v4ReadonlyPreflightRoute(request: Request, env: V4Config, client: Reader,
  checker: typeof preflightV4SignedIssuance = preflightV4SignedIssuance) {
  if (env.NETWORK !== 'op-sepolia' || env.V4_PREFLIGHT_ENABLED !== 'true' ||
      !env.V4_PREFLIGHT_CONTRACT || !env.V4_PREFLIGHT_CODEHASH || !env.V4_PREFLIGHT_PARENT_NODE) {
    return denied(403, 'V4 preflight unavailable')
  }
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return denied(415, 'JSON required')
  try {
    const body = await boundedBody(request)
    if (body === null) return denied(413, 'Body too large')
    const parsed: unknown = JSON.parse(body)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
        Object.keys(parsed).sort().join(',') !== FIELDS.slice().sort().join(',')) return denied(400, 'Invalid V4 intent')
    const input = parsed as Record<string, unknown>
    if (!DECIMAL.test(String(input.nonce)) || !DECIMAL.test(String(input.deadline)) ||
        typeof input.nonce !== 'string' || typeof input.deadline !== 'string' ||
        BigInt(input.nonce) > (2n ** 256n - 1n) || BigInt(input.deadline) > (2n ** 256n - 1n)) {
      return denied(400, 'Invalid V4 nonce or deadline')
    }
    const pin: V4IssuancePin = { chainId: 11155420, contract: env.V4_PREFLIGHT_CONTRACT as Address,
      parentNode: env.V4_PREFLIGHT_PARENT_NODE as Hex, expectedCodeHash: env.V4_PREFLIGHT_CODEHASH as Hex }
    const intent: V4IssuanceIntent = { operator: input.operator as Address, member: input.member as Address,
      initialAddr: input.initialAddr as Address, label: input.label as string,
      nonce: BigInt(input.nonce), deadline: BigInt(input.deadline), signature: input.signature as Hex }
    const result = await checker(client, pin, intent)
    return { status: 200, body: { scope: result.scope, preflightOnly: true, nativeAuthorityVerified: false,
      atomicExecutionVerified: false, checkedAtBlock: result.blockNumber.toString(),
      checkedCodeHash: pin.expectedCodeHash } }
  } catch (error) {
    if (error instanceof V4PreflightDenied) return denied(409, `V4 preflight rejected: ${error.code}`)
    return denied(400, 'Invalid V4 intent')
  }
}
