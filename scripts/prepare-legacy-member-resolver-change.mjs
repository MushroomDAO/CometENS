/** A native ENSv1 Sepolia member's UNSIGNED resolver-change draft only. */
import { encodeFunctionData, isAddress, keccak256 } from 'viem'
import { ENSV1_SEPOLIA_WRAPPER } from './audit-legacy-ensv1-authority.mjs'
import { verifyLegacyNativeHandoff } from './verify-legacy-native-handoff.mjs'

const ZERO = '0x0000000000000000000000000000000000000000'
const PIN = /^0x[0-9a-fA-F]{64}$/
const abi = [{ type: 'function', name: 'setResolver', stateMutability: 'nonpayable',
  inputs: [{ name: 'node', type: 'bytes32' }, { name: 'resolver', type: 'address' }], outputs: [] }]

export class ResolverDraftRefused extends Error {
  constructor(code) { super(`Legacy resolver draft refused: ${code}`); this.name = 'ResolverDraftRefused'; this.code = code }
}

/**
 * Only prepares a wallet transaction; it cannot establish full ENSv2 ownership,
 * unlimited member control, or a SOVEREIGN/LOCKED_RECORD receipt.
 */
export async function prepareLegacyMemberResolverChange({ client, nextResolver, expectedNextResolverCodeHash, ...evidenceInputs }) {
  if (typeof nextResolver !== 'string' || !isAddress(nextResolver) ||
      nextResolver.toLowerCase() === ZERO || !PIN.test(expectedNextResolverCodeHash ?? '')) {
    throw new ResolverDraftRefused('invalid-next-resolver')
  }

  // The evidence is intentionally re-read on every prepare, never cached.
  const evidence = await verifyLegacyNativeHandoff({ client, ...evidenceInputs })
  if (!evidence.memberCanSetResolverObserved ||
      nextResolver.toLowerCase() === evidence.childResolver.toLowerCase()) {
    throw new ResolverDraftRefused('native-member-control-not-observed')
  }
  // Reject EOAs and code substitutions; no resolver ABI/CCIP availability claim.
  // Both code and header are sampled at the SAME verified finalized height.
  const blockNumber = BigInt(evidence.finalizedBlockNumber)
  try {
    const code = await client.getBytecode({ address: nextResolver, blockNumber })
    if (!code || code === '0x' || keccak256(code).toLowerCase() !== expectedNextResolverCodeHash.toLowerCase()) {
      throw new ResolverDraftRefused('next-resolver-code-untrusted')
    }
    const header = await client.getBlock({ blockNumber })
    if (!header || header.hash?.toLowerCase() !== evidence.finalizedBlockHash.toLowerCase()) {
      throw new ResolverDraftRefused('changed-finalized-block')
    }
  } catch (error) {
    if (error instanceof ResolverDraftRefused) throw error
    throw new ResolverDraftRefused('resolver-rpc-unavailable')
  }
  return {
    mode: 'LEGACY_ENSV1_SEPOLIA_MEMBER_UNSIGNED_RESOLVER_DRAFT',
    chainId: 11155111, from: evidence.expectedMember, to: ENSV1_SEPOLIA_WRAPPER,
    value: '0', data: encodeFunctionData({ abi, functionName: 'setResolver',
      args: [evidence.childNode, nextResolver] }),
    childName: evidence.childName, previousResolver: evidence.childResolver,
    proposedResolver: nextResolver, evidenceBlockNumber: evidence.finalizedBlockNumber,
    evidenceBlockHash: evidence.finalizedBlockHash,
    nextResolverCodeVerified: true,
    resolverInterfaceVerified: false, resolutionVerified: false, gatewayAvailabilityVerified: false,
    // The wallet must recheck L1 at execution; no proof of a completed change.
    transactionSent: false, nativeHandoffCompleted: false,
    sovereignReceipt: false, lockedRecordVerified: false,
    ensV2AuthorityVerified: false, opControllerAuthorityVerified: false,
  }
}
