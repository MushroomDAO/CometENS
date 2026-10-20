import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCometENSServerClient } from '../../sdk/server'
import { createSelfHostedProfile } from '../../sdk/profiles'
import type { NetworkProfile } from '../../sdk/types'

const signer = '0x1111111111111111111111111111111111111111' as const
const DEADLINE = BigInt(Math.floor(Date.now() / 1000) + 600)
const profile: NetworkProfile = createSelfHostedProfile({
  id: 'selfhost-test',
  protocol: 'v3',
  rootName: 'example.eth',
  l1: { chainId: 11155111, rpcUrl: 'https://l1.example', resolverAddress: '0x2222222222222222222222222222222222222222' },
  l2: { chainId: 11155420, rpcUrl: 'https://l2.example', recordsAddress: '0x3333333333333333333333333333333333333333' },
  apiBaseUrl: 'https://api.example',
})

afterEach(() => vi.unstubAllGlobals())

describe('@cometens/sdk/server secret segregation', () => {
  it('never carries an API key inside the public profile', () => {
    expect(() => createCometENSServerClient(
      { ...profile, apiKey: 'secret' } as NetworkProfile,
      { getApiKey: () => 'secret' },
    )).toThrow(/Unknown NetworkProfile field/)
    expect(JSON.stringify(profile)).not.toContain('secret')
  })

  it('only sends keys in headers and still requires signed writes', async () => {
    const calls: Array<{ url: string; body: string; authorization: string | null }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const body = String(init?.body)
      if (url === 'https://api.example/register') {
        calls.push({ url, body, authorization: new Headers(init?.headers).get('authorization') })
        return new Response(JSON.stringify({ ok: true, txHash: '0x' + 'ab'.repeat(32) }))
      }
      const rpc = JSON.parse(body) as { id: number; method: string }
      const result = rpc.method === 'eth_chainId'
        ? (url.includes('l1.') ? '0xaa36a7' : '0xaa37dc')
        : rpc.method === 'eth_getCode' ? '0x6000'
          : '0x0000000000000000000000000000000000000000000000000000000000000001'
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }))
    }))
    const client = createCometENSServerClient(profile, { getApiKey: async () => 'server-only-key' })
    await expect(client.register({ from: signer, signature: '0x', message: {
      parent: 'example.eth', label: 'alice', owner: signer, nonce: 4n, deadline: DEADLINE,
    } })).rejects.toMatchObject({ kind: 'invalid-input' })
    await client.register({ from: signer, signature: '0x1234', message: {
      parent: 'example.eth', label: 'alice', owner: signer, nonce: 4n, deadline: DEADLINE,
    } })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.authorization).toBe('Bearer server-only-key')
    expect(calls[0]?.body).not.toContain('server-only-key')
    expect(client.profile).not.toHaveProperty('apiKey')
  })
})
