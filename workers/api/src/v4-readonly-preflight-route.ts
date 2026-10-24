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

/** Optional, intentionally unsigned, OP APPLICATION-ONLY preflight; never consumes nonce or forwards a write. */
export async function v4ReadonlyPreflightRoute(request: Request, env: V4Config, client: Reader,
  checker: typeof preflightV4SignedIssuance = preflightV4SignedIssuance) {
  if (env.NETWORK !== 'op-sepolia' || env.V4_PREFLIGHT_ENABLED !== 'true' ||
      !env.V4_PREFLIGHT_CONTRACT || !env.V4_PREFLIGHT_CODEHASH || !env.V4_PREFLIGHT_PARENT_NODE) {
    return denied(403, 'V4 preflight unavailable')
  }
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return denied(415, 'JSON required')
  try {
    const length = Number(request.headers.get('content-length') ?? 0)
    if (length > 8192) return denied(413, 'Body too large')
    const body = await request.text()
    if (body.length > 8192) return denied(413, 'Body too large')
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
