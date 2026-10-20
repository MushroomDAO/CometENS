import {
  createPublicClient, http, isAddress, isHex, keccak256, namehash,
  type Address, type Hex, type PublicClient,
} from 'viem'
import { mainnet, sepolia, optimism, optimismSepolia } from 'viem/chains'
import {
  typedDataForRegister, typedDataForSetAddr, typedDataForSetText, typedDataForSetContenthash,
  typedDataForAddRegistrar, typedDataForRemoveRegistrar,
} from './protocol.js'
import { SDKError, validateNetworkProfile } from './profiles.js'
import type {
  NetworkProfile, ICometENS, ResolvedName, RegisterRequest, RegisterResult,
  SetAddrRequest, SetTextRequest, SetContenthashRequest,
  AddRegistrarRequest, RemoveRegistrarRequest, TxResult,
} from './types.js'

const L2_ABI = [
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'subnodeOwner', stateMutability: 'view', inputs: [{ name: 'node', type: 'bytes32' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'addr', stateMutability: 'view', inputs: [{ name: 'node', type: 'bytes32' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'addr', stateMutability: 'view', inputs: [{ name: 'node', type: 'bytes32' }, { name: 'coinType', type: 'uint256' }], outputs: [{ type: 'bytes' }] },
  { type: 'function', name: 'text', stateMutability: 'view', inputs: [{ name: 'node', type: 'bytes32' }, { name: 'key', type: 'string' }], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'contenthash', stateMutability: 'view', inputs: [{ name: 'node', type: 'bytes32' }], outputs: [{ type: 'bytes' }] },
] as const

const ZERO = '0x0000000000000000000000000000000000000000'
const serialize = (value: unknown) => JSON.stringify(value, (_key, part) => typeof part === 'bigint' ? part.toString() : part)

/** Browser-safe client. No API credentials can be configured in its profile. */
export class CometENS implements ICometENS {
  readonly profile: Readonly<NetworkProfile>
  /** Compatibility alias; profile is the preferred public name. */
  get options(): Readonly<NetworkProfile> { return this.profile }
  private readonly l1Client: PublicClient
  private readonly l2Client: PublicClient
  private verified: Promise<void> | undefined
  private verifiedAt = 0

  constructor(profile: NetworkProfile) {
    validateNetworkProfile(profile)
    if (profile.protocol === 'v4') {
      throw new SDKError('unsupported-protocol', 'V4 root-scoped delegation requires G2; no V4 adapter is available')
    }
    this.profile = Object.freeze({
      ...profile, l1: Object.freeze({ ...profile.l1 }), l2: Object.freeze({ ...profile.l2 }),
      gatewayUrls: profile.gatewayUrls && Object.freeze([...profile.gatewayUrls]),
    })
    const l1 = profile.l1.chainId === 1 ? mainnet : sepolia
    const l2 = profile.l2.chainId === 10 ? optimism : optimismSepolia
    this.l1Client = createPublicClient({ chain: l1, transport: http(profile.l1.rpcUrl) }) as PublicClient
    this.l2Client = createPublicClient({ chain: l2, transport: http(profile.l2.rpcUrl) }) as PublicClient
  }

  getCapabilities() {
    return Object.freeze({ protocol: this.profile.protocol, directL2Reads: true, signedWorkerWrites: this.profile.protocol === 'v3', revocableRootOperator: false })
  }

  /** Network/bytecode verification is reused for at most 60s; writes force a fresh check. */
  async verifyNetwork(options: { force?: boolean } = {}): Promise<void> {
    const expired = this.verifiedAt !== 0 && Date.now() - this.verifiedAt > 60_000
    if (options.force || !this.verified || expired) {
      this.verified = this.checkNetwork().then(() => {
        this.verifiedAt = Date.now()
      }).catch((e: unknown) => {
        this.verified = undefined // transient RPC failure must permit recovery
        this.verifiedAt = 0
        throw e
      })
    }
    return this.verified
  }

  private async safeRpcRead<T>(source: 'L1' | 'L2', operation: () => Promise<T>): Promise<T> {
    try { return await operation() } catch {
      // viem errors often contain the credential-bearing RPC URL and call body.
      throw new SDKError('rpc-unavailable', `${source} records/ENS RPC request failed`)
    }
  }

  private async checkNetwork(): Promise<void> {
    let actualL1: number
    let actualL2: number
    let l1Code: Hex | undefined
    let l2Code: Hex | undefined
    try {
      [actualL1, actualL2] = await Promise.all([this.l1Client.getChainId(), this.l2Client.getChainId()])
      if (actualL1 !== this.profile.l1.chainId || actualL2 !== this.profile.l2.chainId) {
        throw new SDKError('chain-mismatch', `Expected L1/L2 chainId ${this.profile.l1.chainId}/${this.profile.l2.chainId}, received ${actualL1}/${actualL2}`)
      }
      [l1Code, l2Code] = await Promise.all([
        this.l1Client.getBytecode({ address: this.profile.l1.resolverAddress }),
        this.l2Client.getBytecode({ address: this.profile.l2.recordsAddress }),
      ])
    } catch (e) {
      if (e instanceof SDKError) throw e
      throw new SDKError('rpc-unavailable', 'Could not verify the configured Ethereum/Optimism RPC endpoints')
    }
    if (!l1Code || l1Code === '0x' || !l2Code || l2Code === '0x') {
      throw new SDKError('contract-missing', 'The configured L1 resolver or L2 records address has no deployed bytecode')
    }
    if ((this.profile.l1.expectedCodeHash && keccak256(l1Code).toLowerCase() !== this.profile.l1.expectedCodeHash.toLowerCase()) ||
        (this.profile.l2.expectedCodeHash && keccak256(l2Code).toLowerCase() !== this.profile.l2.expectedCodeHash.toLowerCase())) {
      throw new SDKError('contract-missing', 'Contract runtime bytecode hash does not match expectedCodeHash')
    }
    // V3-compatible record reader sanity check. Bytecode alone cannot identify an ABI.
    try {
      const owner = await this.l2Client.readContract({ address: this.profile.l2.recordsAddress, abi: L2_ABI, functionName: 'owner' })
      if (!isAddress(owner)) throw new Error('Invalid owner result')
      const holder = await this.l2Client.readContract({
        address: this.profile.l2.recordsAddress, abi: L2_ABI, functionName: 'subnodeOwner', args: [namehash(this.profile.rootName)],
      })
      if (!isAddress(holder)) throw new Error('Invalid subnodeOwner result')
    } catch {
      throw new SDKError('contract-missing', 'Configured L2 records contract does not implement the V3 read interface')
    }
  }

  async getAddr(name: string): Promise<Address | null> {
    await this.verifyNetwork()
    const value = await this.safeRpcRead('L2', () => this.l2Client.readContract({
      address: this.profile.l2.recordsAddress, abi: L2_ABI, functionName: 'addr', args: [namehash(name)],
    }))
    return value.toLowerCase() === ZERO ? null : value
  }

  async getAddrByCoinType(name: string, coinType: bigint): Promise<Hex | null> {
    if (coinType < 0n) throw new SDKError('invalid-input', 'Invalid coinType')
    await this.verifyNetwork()
    const value = await this.safeRpcRead('L2', () => this.l2Client.readContract({
      address: this.profile.l2.recordsAddress, abi: L2_ABI, functionName: 'addr', args: [namehash(name), coinType],
    }))
    return value === '0x' ? null : value
  }

  async getText(name: string, key: string): Promise<string | null> {
    await this.verifyNetwork()
    const value = await this.safeRpcRead('L2', () => this.l2Client.readContract({
      address: this.profile.l2.recordsAddress, abi: L2_ABI, functionName: 'text', args: [namehash(name), key],
    }))
    return value || null
  }

  async getContenthash(name: string): Promise<Hex | null> {
    await this.verifyNetwork()
    const value = await this.safeRpcRead('L2', () => this.l2Client.readContract({
      address: this.profile.l2.recordsAddress, abi: L2_ABI, functionName: 'contenthash', args: [namehash(name)],
    }))
    return value === '0x' ? null : value
  }

  /** Direct Optimism records; caller supplies desired text keys (not enumerable). */
  async resolve(name: string, options: { textKeys?: readonly string[] } = {}): Promise<ResolvedName> {
    const keys = options.textKeys ?? []
    const [addr, contenthash, ...values] = await Promise.all([
      this.getAddr(name), this.getContenthash(name), ...keys.map((key) => this.getText(name, key)),
    ])
    const texts: Record<string, string | null> = {}
    keys.forEach((key, i) => { texts[key] = values[i] })
    return { addr, contenthash, texts, source: 'l2' }
  }

  /** Ethereum L1 ENS path with CCIP-Read; unlike getAddr, this uses the ENS registry. */
  async getEnsAddress(name: string): Promise<Address | null> {
    await this.verifyNetwork()
    return this.safeRpcRead('L1', () => this.l1Client.getEnsAddress({ name }))
  }

  protected async requestHeaders(): Promise<Record<string, string>> {
    return { 'content-type': 'application/json' }
  }

  private async send<M>(path: string, signed: { from: Address; signature: Hex; message: M }): Promise<TxResult> {
    if (this.profile.protocol !== 'v3') {
      throw new SDKError('unsupported-protocol', 'V3 readonly profile cannot submit record writes')
    }
    const api = this.profile.apiBaseUrl
    if (!api) throw new SDKError('api-unavailable', 'apiBaseUrl is required to write records')
    if (!isAddress(signed.from) || !isHex(signed.signature) || signed.signature === '0x') {
      throw new SDKError('invalid-input', 'Explicit signer address and EIP-712 signature are required')
    }
    await this.verifyNetwork({ force: true })
    let response: Response
    try {
      response = await fetch(`${api.replace(/\/$/, '')}${path}`, {
        method: 'POST', headers: await this.requestHeaders(),
        body: serialize(signed),
      })
    } catch {
      throw new SDKError('api-unavailable', 'Could not reach the configured CometENS write API')
    }
    const body: unknown = await response.json().catch(() => null)
    const payload = body && typeof body === 'object' ? body as Record<string, unknown> : {}
    if (!response.ok) {
      // Never echo upstream free-form messages: RPC/provider failures can embed keys.
      const safeCodes = new Set(['LABEL_TAKEN', 'APPROVAL_REQUIRED', 'OWNER_UNVERIFIABLE'])
      const code = typeof payload.code === 'string' && safeCodes.has(payload.code) ? payload.code : undefined
      const statusKind = response.status === 401 || response.status === 403 ? 'unauthorized'
        : response.status === 409 ? 'conflict'
          : response.status === 429 ? 'rate-limited'
            : response.status === 503 ? 'service-unavailable'
              : response.status === 400 ? 'invalid-input' : 'api-error'
      throw new SDKError(statusKind, `CometENS write API returned HTTP ${response.status}${code ? ` (${code})` : ''}`, response.status, code)
    }
    if (typeof payload.txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(payload.txHash)) {
      throw new SDKError('api-error', 'CometENS API did not confirm an L2 transaction hash', response.status)
    }
    return { txHash: payload.txHash as Hex }
  }

  async register(request: RegisterRequest): Promise<RegisterResult> {
    typedDataForRegister(this.profile, request.message)
    const result = await this.send('/register', request)
    return { ...result, name: `${request.message.label}.${request.message.parent}` }
  }

  async setAddr(request: SetAddrRequest): Promise<TxResult> {
    typedDataForSetAddr(this.profile, request.message)
    return this.send('/set-addr', request)
  }

  async setText(request: SetTextRequest): Promise<TxResult> {
    typedDataForSetText(this.profile, request.message)
    return this.send('/set-text', request)
  }

  async setContenthash(request: SetContenthashRequest): Promise<TxResult> {
    typedDataForSetContenthash(this.profile, request.message)
    return this.send('/set-contenthash', request)
  }

  /** V3 global contract-owner operation; revoking cannot restrict that owner. */
  async addRegistrar(request: AddRegistrarRequest): Promise<TxResult> {
    typedDataForAddRegistrar(this.profile, request.message)
    return this.send('/add-registrar', request)
  }

  /** V3 registrar revocation is owner-only and does not revoke the global owner. */
  async removeRegistrar(request: RemoveRegistrarRequest): Promise<TxResult> {
    typedDataForRemoveRegistrar(this.profile, request.message)
    return this.send('/remove-registrar', request)
  }
}

export function createCometENSClient(profile: NetworkProfile): CometENS {
  return new CometENS(profile)
}
