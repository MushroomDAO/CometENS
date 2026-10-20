import { isAddress } from 'viem'
import type { NetworkProfile } from './types.js'

export class SDKError extends Error {
  constructor(
    readonly kind:
      | 'invalid-input' | 'unsupported-protocol' | 'chain-mismatch' | 'contract-missing'
      | 'rpc-unavailable' | 'api-unavailable' | 'api-error'
      | 'unauthorized' | 'conflict' | 'rate-limited' | 'service-unavailable',
    message: string,
    readonly status?: number,
    /** Normalized code only; never arbitrary Worker/provider exception content. */
    readonly code?: string,
  ) {
    super(message)
    this.name = 'CometENSError'
  }
}

const isValidUrl = (value: string) => {
  try {
    const url = new URL(value)
    const path = url.pathname.split('/').filter(Boolean)
    const obviousTokenPath = path.length >= 2
      && /^(v2|v3|api-key|apikey|token)$/i.test(path[0])
      && /^[A-Za-z0-9_-]{16,}$/.test(path[1])
    // Public profiles cannot carry query credentials; paths must be audited
    // by the integrator because arbitrary provider token paths are unknowable.
    return (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
      && !url.username && !url.password && !url.hash && !url.search && !obviousTokenPath
  } catch { return false }
}

export function validateNetworkProfile(profile: NetworkProfile): void {
  if (!profile || !profile.id?.trim() || !profile.rootName?.trim()) throw new SDKError('invalid-input', 'id and rootName are required')
  // A profile is safe to share in a browser and diagnostics. Secrets are *only*
  // accepted through the distinct server entrypoint, never extra profile keys.
  for (const [object, allowed] of [
    [profile, ['id', 'mode', 'protocol', 'rootName', 'l1', 'l2', 'apiBaseUrl', 'gatewayUrls']],
    [profile.l1, ['chainId', 'rpcUrl', 'resolverAddress', 'expectedCodeHash']],
    [profile.l2, ['chainId', 'rpcUrl', 'recordsAddress', 'expectedCodeHash']],
  ] as const) {
    if (object && Object.keys(object).some((key) => !(allowed as readonly string[]).includes(key))) {
      throw new SDKError('invalid-input', 'Unknown NetworkProfile field; credentials must stay in server-only authentication')
    }
  }
  if (profile.mode !== 'managed' && profile.mode !== 'selfHosted') throw new SDKError('invalid-input', 'Unknown hosting mode')
  if (!['v3-readonly', 'v3', 'v4'].includes(profile.protocol)) throw new SDKError('invalid-input', 'Unknown contract protocol')
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(profile.rootName) || !profile.rootName.endsWith('.eth')) {
    throw new SDKError('invalid-input', 'rootName must be a normalized .eth name')
  }
  if (!((profile.l1?.chainId === 1 && profile.l2?.chainId === 10) ||
    (profile.l1?.chainId === 11155111 && profile.l2?.chainId === 11155420))) {
    throw new SDKError('chain-mismatch', 'L1/L2 chainId must be Ethereum + Optimism on the same network')
  }
  if (!isAddress(profile.l1.resolverAddress) || !isAddress(profile.l2.recordsAddress) ||
      /^0x0{40}$/i.test(profile.l1.resolverAddress) || /^0x0{40}$/i.test(profile.l2.recordsAddress)) {
    throw new SDKError('invalid-input', 'L1 resolver and L2 records must be nonzero EVM contract addresses')
  }
  for (const hash of [profile.l1.expectedCodeHash, profile.l2.expectedCodeHash]) {
    if (hash !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
      throw new SDKError('invalid-input', 'expectedCodeHash must be a keccak256 bytes32 runtime-code hash')
    }
  }
  for (const url of [profile.l1.rpcUrl, profile.l2.rpcUrl, ...(profile.apiBaseUrl ? [profile.apiBaseUrl] : []), ...(profile.gatewayUrls ?? [])]) {
    if (!isValidUrl(url)) throw new SDKError('invalid-input', 'Profile contains an invalid or non-HTTPS endpoint')
  }
}

/** Reference Sepolia deployment; verify on-chain before relying on its availability. */
export const aastarTestnetProfile: NetworkProfile = Object.freeze({
  id: 'aastar-op-sepolia',
  mode: 'managed',
  protocol: 'v3',
  rootName: 'aastar.eth',
  l1: {
    chainId: 11155111,
    rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com',
    resolverAddress: '0xA54D63a6223B66EDED35286522336e45F21BE512',
  },
  l2: {
    chainId: 11155420,
    rpcUrl: 'https://sepolia.optimism.io',
    recordsAddress: '0xbA692CdfDA33916BbE8d2a1f23E80218db8ebFDc',
  },
  apiBaseUrl: 'https://cometens-api.jhfnetboy.workers.dev',
  gatewayUrls: ['https://cometens-gateway.jhfnetboy.workers.dev/hybrid'],
} satisfies NetworkProfile)

/** All endpoints and addresses are supplied by the self-hoster, with no AAStar fallback. */
export function createSelfHostedProfile(profile: Omit<NetworkProfile, 'mode'>): NetworkProfile {
  const full: NetworkProfile = { ...profile, mode: 'selfHosted' }
  validateNetworkProfile(full)
  return full
}
