import type { Address, Hex } from 'viem'

/** A deployment identity, never a carrier for API keys or RPC credentials. */
export interface NetworkProfile {
  id: string
  mode: 'managed' | 'selfHosted'
  /** V4 requires the separate G2 on-chain delegation implementation. */
  protocol: 'v3-readonly' | 'v3' | 'v4'
  /** Exact parent namespace served by this client, e.g. forest.aastar.eth. */
  rootName: string
  /** Optional keccak256(runtime bytecode) pins detect a changed deployed contract. */
  l1: { chainId: 1 | 11155111; rpcUrl: string; resolverAddress: Address; expectedCodeHash?: Hex }
  l2: { chainId: 10 | 11155420; rpcUrl: string; recordsAddress: Address; expectedCodeHash?: Hex }
  /** Write API Worker origin, independent from CCIP-Read gateway URL(s). */
  apiBaseUrl?: string
  /** For provisioning the L1 resolver; SDK direct L2 reads never consult these. */
  gatewayUrls?: readonly string[]
}

export type CometENSOptions = NetworkProfile
export interface ResolvedName {
  addr: Address | null
  texts: Record<string, string | null>
  contenthash: Hex | null
  source: 'l2'
}

export interface MutationMeta {
  /** Caller-generated, signed uint256. The SDK never substitutes a nonce. */
  nonce: bigint
  /** Signed Unix seconds, bounded by the Worker to 24 hours ahead. */
  deadline: bigint
}

export interface RegisterMessage extends MutationMeta {
  parent: string
  label: string
  owner: Address
}
export interface SetAddrMessage extends MutationMeta {
  node: Hex
  coinType: bigint
  /** Current Worker requires an EVM address (20 bytes) for every coinType. Use zero address to clear. */
  addr: Hex
}
export interface SetTextMessage extends MutationMeta {
  node: Hex
  key: string
  value: string
}
export interface SetContenthashMessage extends MutationMeta {
  node: Hex
  hash: Hex
}
/** V3 contract-owner-only legacy registrar management; not root sovereignty. */
export interface AddRegistrarMessage extends MutationMeta {
  parentNode: Hex
  registrar: Address
  quota: bigint
  expiry: bigint
}
export interface RemoveRegistrarMessage extends MutationMeta {
  parentNode: Hex
  registrar: Address
}
/** A signature and the exact message that was signed, with the actual signer. */
export interface SignedRequest<M> {
  from: Address
  signature: Hex
  message: M
}

export type RegisterRequest = SignedRequest<RegisterMessage>
export type SetAddrRequest = SignedRequest<SetAddrMessage>
export type SetTextRequest = SignedRequest<SetTextMessage>
export type SetContenthashRequest = SignedRequest<SetContenthashMessage>
export type AddRegistrarRequest = SignedRequest<AddRegistrarMessage>
export type RemoveRegistrarRequest = SignedRequest<RemoveRegistrarMessage>
export interface RegisterResult {
  name: string
  txHash: Hex
}
export interface TxResult { txHash: Hex }

export interface ICometENS {
  readonly profile: Readonly<NetworkProfile>
  verifyNetwork(options?: { force?: boolean }): Promise<void>
  getAddr(name: string): Promise<Address | null>
  getAddrByCoinType(name: string, coinType: bigint): Promise<Hex | null>
  getText(name: string, key: string): Promise<string | null>
  getContenthash(name: string): Promise<Hex | null>
  resolve(name: string, options?: { textKeys?: readonly string[] }): Promise<ResolvedName>
  getEnsAddress(name: string): Promise<Address | null>
  register(request: RegisterRequest): Promise<RegisterResult>
  setAddr(request: SetAddrRequest): Promise<TxResult>
  setText(request: SetTextRequest): Promise<TxResult>
  setContenthash(request: SetContenthashRequest): Promise<TxResult>
  addRegistrar(request: AddRegistrarRequest): Promise<TxResult>
  removeRegistrar(request: RemoveRegistrarRequest): Promise<TxResult>
}
