/**
 * CometENS runtime configuration — single source of truth for all env vars.
 *
 * Server-side vars (no VITE_ prefix) are available in gateway/vite.config.ts only.
 * Client-side vars (VITE_ prefix) are bundled into the browser build.
 *
 * Required env vars for a fully functional deployment:
 *   VITE_NETWORK                      op-sepolia | op-mainnet
 *   VITE_ROOT_DOMAIN                  e.g. aastar.eth
 *   VITE_L2_RECORDS_ADDRESS           L2Records contract on L2
 *   VITE_L1_OFFCHAIN_RESOLVER_ADDRESS OffchainResolver contract on L1
 *   VITE_GATEWAY_URL                  Gateway base URL (for CCIP-Read)
 *   VITE_L2_RPC_URL                   Optimism RPC endpoint
 *   VITE_L1_SEPOLIA_RPC_URL           Sepolia RPC (used when network=op-sepolia)
 *   VITE_L1_MAINNET_RPC_URL           Mainnet RPC (used when network=op-mainnet)
 */

export type NetworkName = 'op-mainnet' | 'op-sepolia'

export interface CometENSConfig {
  /** Which L2 this instance operates on */
  network: NetworkName
  /** The ENS root domain managed by this instance, e.g. "aastar.eth" */
  rootDomain: string
  /** L2Records contract address on the L2 network */
  l2RecordsAddress: `0x${string}`
  /** OffchainResolver contract address on L1 Ethereum */
  l1ResolverAddress: `0x${string}`
  /** Gateway URL for CCIP-Read signed responses */
  gatewayUrl: string
  /** L2 (Optimism) JSON-RPC endpoint */
  l2RpcUrl: string
  /** L1 Sepolia JSON-RPC endpoint (active when network = op-sepolia) */
  l1SepoliaRpcUrl: string
  /** L1 Mainnet JSON-RPC endpoint (active when network = op-mainnet) */
  l1MainnetRpcUrl: string
}

const env = typeof import.meta !== 'undefined' ? (import.meta as any).env ?? {} : {}

export const config: CometENSConfig = {
  network: (env.VITE_NETWORK || 'op-sepolia') as NetworkName,
  rootDomain: env.VITE_ROOT_DOMAIN || '',
  l2RecordsAddress: (env.VITE_L2_RECORDS_ADDRESS || '0x0000000000000000000000000000000000000000') as `0x${string}`,
  l1ResolverAddress: (env.VITE_L1_OFFCHAIN_RESOLVER_ADDRESS || '0x0000000000000000000000000000000000000000') as `0x${string}`,
  gatewayUrl: env.VITE_GATEWAY_URL || '/api/ccip',
  l2RpcUrl: env.VITE_L2_RPC_URL || '',
  l1SepoliaRpcUrl: env.VITE_L1_SEPOLIA_RPC_URL || '',
  l1MainnetRpcUrl: env.VITE_L1_MAINNET_RPC_URL || '',
}

/** Returns true when the active L1 is Sepolia (testnet mode) */
export const isTestnet = () => config.network === 'op-sepolia'

/** Active L1 chain name */
export const l1ChainName = () => (isTestnet() ? 'sepolia' : 'mainnet')

/** Active L1 RPC URL */
export const l1RpcUrl = () =>
  isTestnet() ? config.l1SepoliaRpcUrl : config.l1MainnetRpcUrl
