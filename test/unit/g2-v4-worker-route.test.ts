import { describe, it, expect, vi } from 'vitest'
import { V4PreflightDenied } from '../../workers/api/src/v4-issuance-preflight'
import { v4ReadonlyPreflightRoute } from '../../workers/api/src/v4-readonly-preflight-route'
import apiWorker from '../../workers/api/src/index'

const config = {
  NETWORK: 'op-sepolia', V4_PREFLIGHT_ENABLED: 'true',
  V4_PREFLIGHT_CONTRACT: '0x1111111111111111111111111111111111111111',
  V4_PREFLIGHT_CODEHASH: `0x${'a'.repeat(64)}`,
  V4_PREFLIGHT_PARENT_NODE: `0x${'b'.repeat(64)}`,
}
const input = { operator: '0x2222222222222222222222222222222222222222',
  member: '0x3333333333333333333333333333333333333333',
  initialAddr: '0x0000000000000000000000000000000000000000',
  label: 'alice', nonce: '0', deadline: '5000000000', signature: '0xabcd' }
const request = (body: unknown, headers: Record<string, string> = {}) => new Request('https://example.test/v4/issuance/preflight', {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body),
})
const reader = { ccipRead: false }
const accepted = vi.fn(async () => ({ scope: 'op-application-only' as const, blockNumber: 10n }))
const run = (body: unknown = input, cfg = config, checker = accepted, headers = {}) =>
  v4ReadonlyPreflightRoute(request(body, headers), cfg, reader as any, checker as any)

describe('G2 V4 Worker endpoint is an optional read-only preflight', () => {
  it('is actually routed and denied by default without touching legacy KV or signer', async () => {
    const res = await apiWorker.fetch(request(input), {
      NETWORK: 'op-sepolia', OP_RPC_URL: 'https://127.0.0.1:1',
      ROOT_DOMAIN: 'example.eth', L2_RECORDS_ADDRESS: config.V4_PREFLIGHT_CONTRACT,
    })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ preflightOnly: true, nativeAuthorityVerified: false })
  })
  it('never submits or certifies native rights', async () => {
    accepted.mockClear()
    const result = await run()
    expect(result).toMatchObject({ status: 200, body: { scope: 'op-application-only',
      preflightOnly: true, nativeAuthorityVerified: false, atomicExecutionVerified: false,
      checkedAtBlock: '10' } })
    expect(accepted).toHaveBeenCalledOnce()
  })
  it.each([
    [{ ...config, V4_PREFLIGHT_ENABLED: 'false' }],
    [{ ...config, NETWORK: 'op-mainnet' }],
    [{ ...config, V4_PREFLIGHT_CODEHASH: '' }],
  ])('disabled and wrong network fail without any RPC check', async cfg => {
    accepted.mockClear()
    expect((await run(input, cfg)).status).toBe(403)
    expect(accepted).not.toHaveBeenCalled()
  })
  it('rejects extra fields, numeric nonce, huge nonce and malformed JSON', async () => {
    for (const body of [{ ...input, extra: true }, { ...input, nonce: 0 },
      { ...input, nonce: (2n ** 256n).toString() }, '{bad json']) {
      expect((await run(body)).status).toBe(400)
    }
  })
  it('does not disclose failed signature or upstream RPC details', async () => {
    const fail = vi.fn(async () => { throw new V4PreflightDenied('stale') })
    expect((await run(input, config, fail)).body).toMatchObject({ preflightOnly: true,
      nativeAuthorityVerified: false, error: 'V4 preflight rejected: stale' })
    const rogue = vi.fn(async () => { throw new Error('private-rpc-secret-URL') })
    expect(JSON.stringify(await run(input, config, rogue))).not.toContain('private-rpc-secret-URL')
  })
  it('rejects non-JSON and >8KiB body', async () => {
    expect((await run(input, config, accepted, { 'content-type': 'text/plain' })).status).toBe(415)
    expect((await run('x'.repeat(8193))).status).toBe(413)
    // 5000 UTF-16 code units but 10000 UTF-8 bytes, without Content-Length.
    expect((await run('×'.repeat(5000))).status).toBe(413)
    expect((await run(input, config, accepted, { 'content-length': '9000' })).status).toBe(413)
  })
})
