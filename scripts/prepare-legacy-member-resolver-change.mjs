/** A native ENSv1 Sepolia member's UNSIGNED resolver-change draft only. */
import { encodeFunctionData, isAddress } from 'viem'
import { ENSV1_SEPOLIA_WRAPPER } from './audit-legacy-ensv1-authority.mjs'
import { verifyLegacyNativeHandoff } from './verify-legacy-native-handoff.mjs'

const ZERO = '0x0000000000000000000000000000000000000000'
const abi = [{ type: 'function', name: 'setResolver', stateMutability: 'nonpayable',
  inputs: [{ name: 'node', type: 'bytes32' }, { name: 'resolver', type: 'address' }], outputs: [] }]

export class ResolverDraftRefused extends Error {
  constructor(code) { super(`Legacy resolver draft refused: ${code}`); this.name = 'ResolverDraftRefused'; this.code = code }
}

/**
 * Only prepares a wallet transaction; it cannot establish full ENSv2 ownership,
 * unlimited member control, or a SOVEREIGN/LOCKED_RECORD receipt.
 */
export async function prepareLegacyMemberResolverChange({ client, nextResolver, ...evidenceInputs }) {
  if (typeof nextResolver !== 'string' || !isAddress(nextResolver) ||
      nextResolver.toLowerCase() === ZERO) throw new ResolverDraftRefused('invalid-next-resolver')

  // The evidence is intentionally re-read on every prepare, never cached.
  const evidence = await verifyLegacyNativeHandoff({ client, ...evidenceInputs })
  if (!evidence.memberResolverAutonomyObserved ||
      nextResolver.toLowerCase() === evidence.childResolver.toLowerCase()) {
    throw new ResolverDraftRefused('native-member-control-not-observed')
  }
  return {
    mode: 'LEGACY_ENSV1_SEPOLIA_MEMBER_UNSIGNED_RESOLVER_DRAFT',
    chainId: 11155111, from: evidence.expectedMember, to: ENSV1_SEPOLIA_WRAPPER,
    value: '0', data: encodeFunctionData({ abi, functionName: 'setResolver',
      args: [evidence.childNode, nextResolver] }),
    childName: evidence.childName, previousResolver: evidence.childResolver,
    proposedResolver: nextResolver, evidenceBlockNumber: evidence.finalizedBlockNumber,
    evidenceBlockHash: evidence.finalizedBlockHash,
    // The wallet must recheck L1 at execution; no proof of a completed change.
    transactionSent: false, nativeHandoffCompleted: false,
    sovereignReceipt: false, lockedRecordVerified: false,
    ensV2AuthorityVerified: false, opControllerAuthorityVerified: false,
  }
}
