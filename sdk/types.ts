/**
 * CometENS SDK — public type definitions.
 *
 * These types define the contract between the SDK and its consumers.
 * Applications using CometENS infrastructure depend on these types
 * regardless of which deployment (ours or self-hosted) they point to.
 */

import type { Address, Hex } from 'viem'

// ─── Configuration ─────────────────────────────────────────────────────────────

export interface CometENSOptions {
  /**
   * ENS root domain this SDK instance manages, e.g. "aastar.eth".
   * All registration and resolution operates under this domain.
   */
  rootDomain: string

  /**
   * OffchainResolver contract address on L1 Ethereum (Mainnet or Sepolia).
   * Used as the ENS resolver for the root domain.
   */
  l1ResolverAddress: Address

  /**
   * L2Records contract address on the L2 network (Optimism or OP Sepolia).
   * Stores all subdomain records.
   */
  l2RecordsAddress: Address

  /**
   * Gateway base URL. Handles CCIP-Read signed responses.
   * Default: https://ens.aastar.io/api/ccip (CometENS public gateway)
   */
  gatewayUrl?: string

  /**
   * L1 JSON-RPC endpoint. Must match the chain where l1ResolverAddress is deployed.
   */
  l1RpcUrl: string

  /**
   * L2 JSON-RPC endpoint. Must match the chain where l2RecordsAddress is deployed.
   */
  l2RpcUrl: string
}

// ─── Resolution ────────────────────────────────────────────────────────────────

export interface ResolvedName {
  /** ETH address (coinType 60), or null if not set */
  addr: Address | null
  /** All text records set for this name */
  texts: Record<string, string>
  /** Contenthash bytes, or null if not set */
  contenthash: Hex | null
}

// ─── Registration ──────────────────────────────────────────────────────────────

export interface RegisterRequest {
  /** Subdomain label to register, e.g. "alice" → registers "alice.aastar.eth" */
  label: string
  /** Address that will own the subdomain */
  owner: Address
  /** EIP-712 signature from an authorised signer */
  signature: Hex
  /** Unix timestamp — request must be submitted before this time */
  deadline: number
}

export interface RegisterResult {
  /** Full subdomain name that was registered */
  name: string
  /** L2 transaction hash */
  txHash: Hex
}

// ─── Record updates ────────────────────────────────────────────────────────────

export interface SetAddrRequest {
  /** Full ENS name, e.g. "alice.aastar.eth" */
  name: string
  /** Address to store */
  addr: Address
  /** ENSIP-11 coin type. Default: 60 (ETH) */
  coinType?: bigint
  /** EIP-712 signature from the subdomain owner */
  signature: Hex
  deadline: number
}

export interface SetTextRequest {
  name: string
  key: string
  value: string
  signature: Hex
  deadline: number
}

// ─── SDK interface ─────────────────────────────────────────────────────────────

/**
 * Core CometENS SDK interface.
 *
 * Implementations:
 *   - BrowserCometENS  — browser client, signs with injected wallet (MetaMask)
 *   - ServerCometENS   — server client, signs with private key (Worker EOA)
 *   - ReadOnlyCometENS — read-only, no signing required
 */
export interface ICometENS {
  readonly options: CometENSOptions

  // ── Resolution (public, no auth) ──────────────────────────────────────────

  /** Resolve all records for a name via CCIP-Read */
  resolve(name: string): Promise<ResolvedName>

  /** Get ETH address for a name (coinType 60) */
  getAddr(name: string): Promise<Address | null>

  /** Get address bytes for a specific chain (ENSIP-11 coinType) */
  getAddrByCoinType(name: string, coinType: bigint): Promise<Hex | null>

  /** Get a text record by key */
  getText(name: string, key: string): Promise<string | null>

  // ── Registration (user-initiated via EIP-712) ─────────────────────────────

  /** Register a subdomain under rootDomain */
  register(req: RegisterRequest): Promise<RegisterResult>

  // ── Record updates (owner-initiated via EIP-712) ──────────────────────────

  /** Update the ETH address for a name */
  setAddr(req: SetAddrRequest): Promise<{ txHash: Hex }>

  /** Update a text record */
  setText(req: SetTextRequest): Promise<{ txHash: Hex }>
}
