import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  encodeAbiParameters, keccak256, namehash, toFunctionSelector, verifyTypedData,
  type Address, type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  CometENS, SDKError, aastarTestnetProfile, createCometENSClient,
  createSelfHostedProfile, typedDataForRegister, typedDataForSetAddr,
  typedDataForSetText, typedDataForSetContenthash,
  typedDataForAddRegistrar, typedDataForRemoveRegistrar,
} from '../../sdk/index'
import type { NetworkProfile } from '../../sdk/types'

const CONTRACT = '0x1111111111111111111111111111111111111111' as Address
const RESOLVER = '0x2222222222222222222222222222222222222222' as Address
const RECIPIENT = '0x3333333333333333333333333333333333333333' as Address
const HASH = ('0x' + '55'.repeat(32)) as Hex
const TX = ('0x' + '44'.repeat(32)) as Hex
const DEADLINE = BigInt(Math.floor(Date.now() / 1000) + 600)
const signer = privateKeyToAccount(('0x' + '01'.repeat(32)) as Hex)
const profile: NetworkProfile = createSelfHostedProfile({
  id: 'community-testnet',
  protocol: 'v3',
  rootName: 'community.eth',
  l1: { chainId: 11155111, resolverAddress: RESOLVER, rpcUrl: 'https://l1.test' },
  l2: { chainId: 11155420, recordsAddress: CONTRACT, rpcUrl: 'https://l2.test' },
  gatewayUrls: ['https://ccip.test/hybrid'],
  apiBaseUrl: 'https://api.test',
})

const encodeAddr = (addr: Address) => encodeAbiParameters([{ type: 'address' }], [addr])
const encodeText = (val: string) => encodeAbiParameters([{ type: 'string' }], [val])
const encodeBytes = (val: Hex) => encodeAbiParameters([{ type: 'bytes' }], [val])
const selectors = {
  text: toFunctionSelector('text(bytes32,string)'),
  contenthash: toFunctionSelector('contenthash(bytes32)'),
  coinAddr: toFunctionSelector('addr(bytes32,uint256)'),
}

function mockRpcAndApi(options: {
  l1Chain?: number; l2Chain?: number; noCode?: boolean; apiStatus?: number;
  noTxHash?: boolean; apiCode?: string; failRead?: boolean;
} = {}) {
  const apiBodies: Array<{ path: string; json: Record<string, unknown>; headers: Headers }> = []
  vi.stubGlobal('fetch', vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
    const url = String(request)
    if (url.startsWith('https://api.test/')) {
      apiBodies.push({
        path: url,
        json: JSON.parse(String(init?.body)) as Record<string, unknown>,
        headers: new Headers(init?.headers),
      })
      const payload = options.apiStatus && options.apiStatus >= 400
        ? { error: 'Unsafe RPC provider URL https://rpc.example/v2/SECRET_VALUE', code: options.apiCode }
        : options.noTxHash ? { ok: true } : { ok: true, txHash: TX }
      return new Response(JSON.stringify(payload), {
        status: options.apiStatus ?? 200, headers: { 'content-type': 'application/json' },
      })
    }
    const rpc = JSON.parse(String(init?.body)) as { id: number; method: string; params?: Array<Record<string, unknown>> }
    const l1 = url === 'https://l1.test/'
    if (rpc.method === 'eth_call' && options.failRead) {
      return new Response(JSON.stringify({
        jsonrpc: '2.0', id: rpc.id,
        error: { code: -32000, message: 'RPC credentials leaked: https://rpc.example/v2/SECRET_VALUE' },
      }))
    }
    let result = '0x'
    if (rpc.method === 'eth_chainId') {
      result = '0x' + (l1 ? options.l1Chain ?? 11155111 : options.l2Chain ?? 11155420).toString(16)
    } else if (rpc.method === 'eth_getCode') {
      result = options.noCode ? '0x' : '0x6001600055'
    } else if (rpc.method === 'eth_call') {
      const data = String(rpc.params?.[0]?.data ?? '')
      result = data.startsWith(selectors.text) ? encodeText('comet ens')
        : data.startsWith(selectors.contenthash) ? encodeBytes('0x1234')
          : data.startsWith(selectors.coinAddr) ? encodeBytes(RECIPIENT)
            : encodeAddr(RECIPIENT)
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }), {
      headers: { 'content-type': 'application/json' },
    })
  }))
  return apiBodies
}

afterEach(() => vi.unstubAllGlobals())

describe('@cometens/sdk network and reads', () => {
  it('supports verified explicit Sepolia profiles, L2 reads and requested text keys', async () => {
    mockRpcAndApi()
    const client = createCometENSClient(profile)
    await client.verifyNetwork()
    expect(await client.getAddr('alice.community.eth')).toBe(RECIPIENT)
    expect(await client.getAddrByCoinType('alice.community.eth', 60n)).toBe(RECIPIENT)
    expect(await client.getText('alice.community.eth', 'url')).toBe('comet ens')
    expect(await client.getContenthash('alice.community.eth')).toBe('0x1234')
    expect(await client.resolve('alice.community.eth', { textKeys: ['url'] })).toEqual({
      addr: RECIPIENT, contenthash: '0x1234', source: 'l2', texts: { url: 'comet ens' },
    })
  })

  it('reads records only from OP, while ENS lookup follows the L1 ENS path', async () => {
    mockRpcAndApi()
    const client = new CometENS(profile)
    await client.verifyNetwork()
    const fetchSpy = vi.mocked(fetch)
    fetchSpy.mockClear()
    await client.getAddr('alice.community.eth')
    expect(fetchSpy.mock.calls.map(([url]) => String(url))).toEqual(['https://l2.test/'])
    fetchSpy.mockClear()
    // The generic mock doesn't implement the complete universal resolver ABI,
    // but still verifies this method invokes the canonical L1, never OP.
    await client.getEnsAddress('alice.community.eth').catch(() => null)
    expect(fetchSpy.mock.calls.some(([url]) => String(url) === 'https://l1.test/')).toBe(true)
    expect(fetchSpy.mock.calls.some(([url]) => String(url) === 'https://l2.test/')).toBe(false)
  })

  it('fails closed on incorrect RPC networks and missing deployed contract code', async () => {
    mockRpcAndApi({ l2Chain: 10 })
    await expect(new CometENS(profile).getAddr('alice.community.eth')).rejects.toMatchObject({ kind: 'chain-mismatch' })
    vi.unstubAllGlobals()
    mockRpcAndApi({ noCode: true })
    await expect(new CometENS(profile).verifyNetwork()).rejects.toMatchObject({ kind: 'contract-missing' })
  })

  it('expires verified network state after 60s and forces fresh checks before writes', async () => {
    const settings = { l2Chain: 11155420 }
    mockRpcAndApi(settings)
    const client = new CometENS(profile)
    await client.getAddr('alice.community.eth')
    settings.l2Chain = 10
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 61_000)
    try {
      await expect(client.getAddr('alice.community.eth')).rejects.toMatchObject({ kind: 'chain-mismatch' })
    } finally { clock.mockRestore() }

    settings.l2Chain = 11155420
    const writer = new CometENS(profile)
    await writer.getAddr('alice.community.eth')
    settings.l2Chain = 10
    await expect(writer.register({ from: signer.address, signature: '0x1234', message: {
      parent: profile.rootName, label: 'alice', owner: RECIPIENT, nonce: 1n, deadline: DEADLINE,
    } })).rejects.toMatchObject({ kind: 'chain-mismatch' })
  })

  it('redacts provider failure details when a verified L2 read fails', async () => {
    const settings = { failRead: false }
    mockRpcAndApi(settings)
    const client = new CometENS(profile)
    await client.verifyNetwork()
    settings.failRead = true
    await expect(client.getText('alice.community.eth', 'url')).rejects.toMatchObject({ kind: 'rpc-unavailable' })
    try {
      await client.getAddr('alice.community.eth')
      throw new Error('expected failure')
    } catch (error) {
      expect(String(error)).not.toContain('SECRET_VALUE')
    }
  })

  it('pins L1 and L2 runtime bytecode hashes when the profile supplies them', async () => {
    mockRpcAndApi()
    const expectedCodeHash = keccak256('0x6001600055')
    await expect(new CometENS({
      ...profile,
      l1: { ...profile.l1, expectedCodeHash },
      l2: { ...profile.l2, expectedCodeHash },
    }).verifyNetwork()).resolves.toBeUndefined()
    await expect(new CometENS({
      ...profile,
      l2: { ...profile.l2, expectedCodeHash: '0x' + 'aa'.repeat(32) as Hex },
    }).verifyNetwork()).rejects.toMatchObject({ kind: 'contract-missing' })
  })

  it('rejects invalid chain pairs, contract addresses, and unimplemented V4', () => {
    expect(() => new CometENS({ ...profile, l2: { ...profile.l2, chainId: 10 } })).toThrow(SDKError)
    expect(() => new CometENS({ ...profile, l1: { ...profile.l1, resolverAddress: '0x0000000000000000000000000000000000000000' } })).toThrow(SDKError)
    expect(() => new CometENS({ ...profile, protocol: 'v4' })).toThrow(/G2/)
    expect(() => new CometENS({ ...profile, apiBaseUrl: 'https://api.test/?token=secret' })).toThrow(SDKError)
    expect(() => new CometENS({ ...profile, l2: { ...profile.l2,
      rpcUrl: 'https://rpc.example/v2/0123456789abcdef0123456789abcdef',
    } })).toThrow(SDKError)
    expect(aastarTestnetProfile.l1.chainId).toBe(11155111)
    expect(aastarTestnetProfile.l2.chainId).toBe(11155420)
  })

  it('supports v3-readonly profiles but rejects any worker writes', async () => {
    const client = new CometENS({ ...profile, protocol: 'v3-readonly' })
    expect(client.getCapabilities()).toMatchObject({ signedWorkerWrites: false, revocableRootOperator: false })
    await expect(client.register({ from: signer.address, signature: '0x1234', message: {
      parent: profile.rootName, label: 'alice', owner: RECIPIENT, nonce: 1n, deadline: DEADLINE,
    } })).rejects.toMatchObject({ kind: 'unsupported-protocol' })
  })
})

describe('@cometens/sdk signed write compatibility', () => {
  it('preserves exact signer/nonce/deadline and uses the Worker register endpoint', async () => {
    const bodies = mockRpcAndApi()
    const client = new CometENS(profile)
    const message = { parent: profile.rootName, label: 'alice', owner: RECIPIENT, nonce: 701n, deadline: DEADLINE }
    const typed = typedDataForRegister(profile, message)
    const signature = await signer.signTypedData(typed)
    expect(await client.register({ from: signer.address, signature, message })).toEqual({ name: 'alice.community.eth', txHash: TX })
    expect(bodies[0]?.path).toBe('https://api.test/register')
    expect(bodies[0]?.json).toEqual({
      from: signer.address, signature,
      message: { ...message, nonce: '701', deadline: DEADLINE.toString() },
    })
    expect(bodies[0]?.headers.get('authorization')).toBeNull()
    expect(await verifyTypedData({ ...typed, address: signer.address, signature })).toBe(true)
    expect(await verifyTypedData({ ...typed, address: signer.address, signature, message: { ...message, nonce: 702n } })).toBe(false)
  })

  it('submits SetAddr, SetText and SetContenthash as byte-exact EIP-712 signed payloads', async () => {
    const bodies = mockRpcAndApi()
    const client = new CometENS(profile)
    const common = { node: namehash('alice.community.eth'), nonce: 12n, deadline: DEADLINE }
    const addr = { ...common, coinType: 60n, addr: RECIPIENT }
    const text = { ...common, key: 'com.twitter', value: '@alice' }
    const contenthash = { ...common, hash: '0x1234' as Hex }
    const messages = [
      { path: '/set-addr', data: typedDataForSetAddr(profile, addr), message: addr, run: client.setAddr.bind(client) },
      { path: '/set-text', data: typedDataForSetText(profile, text), message: text, run: client.setText.bind(client) },
      { path: '/set-contenthash', data: typedDataForSetContenthash(profile, contenthash), message: contenthash, run: client.setContenthash.bind(client) },
    ] as const
    for (const item of messages) {
      const signature = await signer.signTypedData(item.data)
      await item.run({ from: signer.address, signature, message: item.message } as never)
      expect(await verifyTypedData({ ...item.data, address: signer.address, signature })).toBe(true)
    }
    expect(bodies.map(b => b.path)).toEqual(messages.map(item => 'https://api.test' + item.path))
    expect(bodies[0]?.json.message).toEqual({
      node: common.node, coinType: '60', addr: RECIPIENT, nonce: '12', deadline: DEADLINE.toString(),
    })
    expect(bodies[1]?.json.message).toEqual({
      node: common.node, key: 'com.twitter', value: '@alice', nonce: '12', deadline: DEADLINE.toString(),
    })
  })

  it('submits V3 owner-only registrar grant/revoke without claiming scoped-owner control', async () => {
    const bodies = mockRpcAndApi()
    const client = new CometENS(profile)
    const base = { parentNode: namehash(profile.rootName), registrar: RECIPIENT, nonce: 55n, deadline: DEADLINE }
    const add = { ...base, quota: 10n, expiry: DEADLINE }
    const remove = { ...base, nonce: 56n }
    const addData = typedDataForAddRegistrar(profile, add)
    const addSignature = await signer.signTypedData(addData)
    const removeData = typedDataForRemoveRegistrar(profile, remove)
    const removeSignature = await signer.signTypedData(removeData)
    await client.addRegistrar({ from: signer.address, signature: addSignature, message: add })
    await client.removeRegistrar({ from: signer.address, signature: removeSignature, message: remove })
    expect(bodies.map(item => item.path)).toEqual(['https://api.test/add-registrar', 'https://api.test/remove-registrar'])
    expect(bodies[0]?.json.message).toMatchObject({ parentNode: base.parentNode, registrar: RECIPIENT, quota: '10', expiry: DEADLINE.toString(), nonce: '55' })
    expect(bodies[1]?.json.message).toMatchObject({ parentNode: base.parentNode, registrar: RECIPIENT, nonce: '56', deadline: DEADLINE.toString() })
    expect(await verifyTypedData({ ...addData, address: signer.address, signature: addSignature })).toBe(true)
    expect(await verifyTypedData({ ...removeData, address: signer.address, signature: removeSignature })).toBe(true)
    await expect(client.addRegistrar({ from: signer.address, signature: addSignature,
      message: { ...add, parentNode: namehash('another.eth') },
    })).rejects.toMatchObject({ kind: 'invalid-input' })
    expect(client.getCapabilities().revocableRootOperator).toBe(false)
  })

  it('rejects different parent before request and refuses responses without a transaction', async () => {
    const bodies = mockRpcAndApi({ noTxHash: true })
    const client = new CometENS(profile)
    const mismatch = { parent: 'another.eth', label: 'alice', owner: RECIPIENT, nonce: 1n, deadline: DEADLINE }
    await expect(client.register({ from: signer.address, signature: '0x1234', message: mismatch })).rejects.toMatchObject({ kind: 'invalid-input' })
    expect(bodies).toHaveLength(0)
    await expect(client.register({ from: signer.address, signature: '0x1234', message: { ...mismatch, parent: profile.rootName } }))
      .rejects.toMatchObject({ kind: 'api-error' })
    expect(bodies).toHaveLength(1)
  })

  it('rejects stale or excessive EIP-712 deadlines without modifying caller-provided values', () => {
    const message = {
      parent: profile.rootName, label: 'alice', owner: RECIPIENT, nonce: 1n,
      deadline: BigInt(Math.floor(Date.now() / 1000) - 5),
    }
    expect(() => typedDataForRegister(profile, message)).toThrow(/deadline/)
    expect(() => typedDataForRegister(profile, {
      ...message, deadline: BigInt(Math.floor(Date.now() / 1000) + 86_401),
    })).toThrow(/24-hour/)
  })

  it.each([
    [401, 'unauthorized', undefined],
    [403, 'unauthorized', undefined],
    [409, 'conflict', 'LABEL_TAKEN'],
    [429, 'rate-limited', undefined],
    [503, 'service-unavailable', undefined],
  ] as const)('maps write HTTP %i to safe %s without exposing upstream credentials', async (status, kind, code) => {
    mockRpcAndApi({ apiStatus: status, apiCode: code })
    const client = new CometENS(profile)
    const req = { from: signer.address, signature: '0x1234' as Hex,
      message: { parent: profile.rootName, label: 'alice', owner: RECIPIENT, nonce: 1n, deadline: DEADLINE },
    }
    try {
      await client.register(req)
      throw new Error('expected SDKError')
    } catch (error) {
      expect(error).toMatchObject({ kind, status, code })
      expect(String(error)).not.toContain('SECRET_VALUE')
    }
  })
})
