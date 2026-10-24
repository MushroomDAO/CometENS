/** Read-only ENSv2 member autonomy risk probe. Never an issuance permit. */
import { keccak256, toHex } from 'viem'

// ENS PermissionedRegistry ABI, https://docs.ens.domains/ensv2/permissioned-registry/
export const REGISTRY_ABI = [
  { type: 'function', name: 'getState', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'tuple', components: [
    { name: 'status', type: 'uint8' }, { name: 'expiry', type: 'uint64' },
    { name: 'latestOwner', type: 'address' }, { name: 'tokenId', type: 'uint256' },
    { name: 'resource', type: 'uint256' },
  ] }] },
  { type: 'function', name: 'getResolver', stateMutability: 'view', inputs: [{ type: 'string' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'getSubregistry', stateMutability: 'view', inputs: [{ type: 'string' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'isEmancipated', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'roleCount', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'isApprovedForAll', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'bool' }] },
]

const ZERO = '0x0000000000000000000000000000000000000000'
const danger = [8n, 12n, 20n, 24n, 124n]
const count = (bitmap, shift) => (bitmap >> shift) & 15n
const deny = (reason, findings = []) => ({ verdict: 'UNPROVEN', sovereignReceipt: false, reason, findings })

/** All reads at one immutable block; a second call is needed after any mutation. */
export async function probeMemberAutonomy({ client, chainId, registry, label, member, resolver, blockNumber }) {
  if (chainId !== 11155111 || !/^0x[0-9a-fA-F]{40}$/.test(registry ?? '') ||
      !/^0x[0-9a-fA-F]{40}$/.test(member ?? '') || !/^0x[0-9a-fA-F]{40}$/.test(resolver ?? '') ||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label ?? '') ||
      typeof blockNumber !== 'bigint' || blockNumber < 1n) return deny('INVALID_INPUT')
  const read = (functionName, args = []) => client.readContract({ address: registry, abi: REGISTRY_ABI, functionName, args, blockNumber })
  try {
    if (await client.getChainId() !== chainId) return deny('CHAIN_MISMATCH')
    const code = await client.getBytecode({ address: registry, blockNumber })
    if (!code || code === '0x') return deny('NO_REGISTRY_CODE')
    const id = BigInt(keccak256(toHex(label)))
    const [state, actualResolver, emancipated, rootCounts] = await Promise.all([
      read('getState', [id]), read('getResolver', [label]), read('isEmancipated'), read('roleCount', [0n]),
    ])
    if (state?.status !== 2 || state.expiry <= 0n || state.latestOwner?.toLowerCase() !== member.toLowerCase())
      return deny('TRANSFER_EXPIRY_OR_REREGISTRATION', ['MEMBER_TITLE_CHANGED'])
    const block = await client.getBlock({ blockNumber })
    if (!block || state.expiry <= block.timestamp) return deny('EXPIRED')
    if (actualResolver?.toLowerCase() !== resolver.toLowerCase()) return deny('RESOLVER_POINTER_CHANGED')
    if (typeof rootCounts !== 'bigint' || typeof emancipated !== 'boolean') return deny('ABI_MISMATCH')
    const rootDanger = danger.filter(shift => count(rootCounts, shift) > 0n || count(rootCounts, shift + 128n) > 0n)
    const findings = ['PARENT_HIERARCHY_UNVERIFIED', 'PROXY_UPGRADE_UNVERIFIED',
      'RESOLVER_EAC_AND_RECORDS_UNVERIFIED', 'THIRD_PARTY_APPROVALS_UNENUMERATED',
      'REGISTRY_REPLACEMENT_AND_REREGISTRATION_RISK']
    if (!emancipated || rootDanger.length) findings.push('ROOT_EAC_OVERRIDE_AVAILABLE')
    return deny('MEMBER_AUTONOMY_NOT_PROVEN', findings)
  } catch { return deny('RPC_OR_ABI_FAILURE') }
}
