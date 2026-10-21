/** Finalized LEGACY ENSv1 observations only. Never returns a sovereign receipt. */
import { isAddress, keccak256, namehash, stringToHex } from 'viem'
import { ENSV1_SEPOLIA_REGISTRY as REGISTRY, ENSV1_SEPOLIA_WRAPPER as WRAPPER,
  CANNOT_UNWRAP, PARENT_CANNOT_CONTROL } from './audit-legacy-ensv1-authority.mjs'

export const LEGACY_SEPOLIA_REGISTRAR = '0x57f1887a8bf19b14fc0df6fd9b2acc9af147ea85'
export const CANNOT_SET_RESOLVER = 1 << 3
const ZERO = '0x0000000000000000000000000000000000000000'
const HEX32 = /^0x[0-9a-fA-F]{64}$/
const MIN_EXPIRY = 86400n
const registryAbi = [
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'resolver', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'address' }] },
]
const wrapperAbi = [
  { type: 'function', name: 'getData', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'address' }, { type: 'uint32' }, { type: 'uint64' }] },
  { type: 'function', name: 'getApproved', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'isApprovedForAll', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'upgradeContract', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
]
const registrarAbi = [
  { type: 'function', name: 'nameExpires', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'ownerOf', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'getApproved', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'isApprovedForAll', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'bool' }] },
]
export class LegacyHandoffEvidenceError extends Error {
  constructor(code) { super(`Legacy ENSv1 handoff evidence refused: ${code}`); this.code = code; this.name = 'LegacyHandoffEvidenceError' }
}
const eq = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()
const address = (v) => typeof v === 'string' && isAddress(v)
const nonzero = (v) => address(v) && !eq(v, ZERO)
const labelOk = (v) => typeof v === 'string' && v.length > 0 && v.length <= 63 &&
  /^[a-z0-9-]+$/.test(v) && v[0] !== '-' && !v.endsWith('-') &&
  !(v.length >= 4 && v[2] === '-' && v[3] === '-')

/**
 * This does not enumerate ALL NFT approvals or prove ENSv2 ownership.
 * Public RPC 'finalized' alone is NOT an independently verified consensus proof.
 */
export async function verifyLegacyNativeHandoff({
  client, parentName, childName, expectedMember, expectedResolver,
  expectedRegistryCodeHash, expectedWrapperCodeHash, expectedRegistrarCodeHash,
  sampledOperators = [],
}) {
  const p = typeof parentName === 'string' && parentName.endsWith('.eth') ? parentName.slice(0, -4) : ''
  const c = typeof childName === 'string' && childName.endsWith(`.${parentName}`) ?
    childName.slice(0, -(parentName.length + 1)) : ''
  if (!client || !labelOk(p) || parentName !== `${p}.eth` || !labelOk(c) ||
      childName !== `${c}.${parentName}` || !nonzero(expectedMember) ||
      !nonzero(expectedResolver) || ![expectedRegistryCodeHash, expectedWrapperCodeHash,
        expectedRegistrarCodeHash].every((v) => HEX32.test(v ?? '')) ||
      !Array.isArray(sampledOperators) || sampledOperators.length > 20 ||
      !sampledOperators.every(nonzero)) throw new LegacyHandoffEvidenceError('invalid-input')

  try {
    if (await client.getChainId() !== 11155111) throw new LegacyHandoffEvidenceError('wrong-chain')
    const block = await client.getBlock({ blockTag: 'finalized' })
    const now = BigInt(Math.floor(Date.now() / 1000))
    if (typeof block.number !== 'bigint' || typeof block.timestamp !== 'bigint' ||
        !HEX32.test(block.hash ?? '')) throw new LegacyHandoffEvidenceError('missing-finalized-block')
    if (block.timestamp > now + 120n || block.timestamp + 7200n < now) {
      throw new LegacyHandoffEvidenceError('stale-finality')
    }
    const blockNumber = block.number
    const addrs = [REGISTRY, WRAPPER, LEGACY_SEPOLIA_REGISTRAR]
    const expectedHashes = [expectedRegistryCodeHash, expectedWrapperCodeHash, expectedRegistrarCodeHash]
    const codes = await Promise.all(addrs.map((addr) => client.getBytecode({ address: addr, blockNumber })))
    if (codes.some((code, i) => !code || code === '0x' ||
        keccak256(code).toLowerCase() !== expectedHashes[i].toLowerCase())) {
      throw new LegacyHandoffEvidenceError('untrusted-code')
    }
    const parentNode = namehash(parentName)
    const childNode = namehash(childName)
    const token = BigInt(keccak256(stringToHex(p)))
    const read = (target, abi, functionName, args = []) => client.readContract({
      address: target, abi, functionName, args, blockNumber,
    })
    const [parentRegistryOwner, childRegistryOwner, resolver, parentData, childData,
      registrarOwner, registrarExpiry, registrarApproved, childApproved, upgradeContract] = await Promise.all([
      read(REGISTRY, registryAbi, 'owner', [parentNode]),
      read(REGISTRY, registryAbi, 'owner', [childNode]),
      read(REGISTRY, registryAbi, 'resolver', [childNode]),
      read(WRAPPER, wrapperAbi, 'getData', [BigInt(parentNode)]),
      read(WRAPPER, wrapperAbi, 'getData', [BigInt(childNode)]),
      read(LEGACY_SEPOLIA_REGISTRAR, registrarAbi, 'ownerOf', [token]),
      read(LEGACY_SEPOLIA_REGISTRAR, registrarAbi, 'nameExpires', [token]),
      read(LEGACY_SEPOLIA_REGISTRAR, registrarAbi, 'getApproved', [token]),
      read(WRAPPER, wrapperAbi, 'getApproved', [BigInt(childNode)]),
      read(WRAPPER, wrapperAbi, 'upgradeContract'),
    ])
    if (![parentRegistryOwner, childRegistryOwner, resolver, registrarOwner,
      registrarApproved, childApproved, upgradeContract].every(address) ||
        ![parentData, childData].every((d) => Array.isArray(d) && d.length === 3 &&
          address(d[0]) && typeof d[1] === 'number' && typeof d[2] === 'bigint') ||
        typeof registrarExpiry !== 'bigint') throw new LegacyHandoffEvidenceError('invalid-contract-state')
    const approvals = await Promise.all(sampledOperators.map(async (operator) => ({
      operator,
      wrapperApproved: await read(WRAPPER, wrapperAbi, 'isApprovedForAll', [expectedMember, operator]),
      registrarApproved: await read(LEGACY_SEPOLIA_REGISTRAR, registrarAbi,
        'isApprovedForAll', [WRAPPER, operator]),
    })))
    if (!approvals.every((v) => typeof v.wrapperApproved === 'boolean' &&
        typeof v.registrarApproved === 'boolean')) throw new LegacyHandoffEvidenceError('invalid-approvals')
    const childUnexpired = childData[2] > now + MIN_EXPIRY && childData[2] <= parentData[2] &&
      childData[2] + MIN_EXPIRY <= registrarExpiry
    const nativeHolderConditions = eq(parentRegistryOwner, WRAPPER) && eq(childRegistryOwner, WRAPPER) &&
      eq(registrarOwner, WRAPPER) && registrarExpiry > now + MIN_EXPIRY &&
      (parentData[1] & CANNOT_UNWRAP) !== 0 && childUnexpired &&
      eq(childData[0], expectedMember) &&
      (childData[1] & (CANNOT_UNWRAP | PARENT_CANNOT_CONTROL)) ===
        (CANNOT_UNWRAP | PARENT_CANNOT_CONTROL)
    const memberResolverAutonomyObserved = nativeHolderConditions && eq(resolver, expectedResolver) &&
      (childData[1] & CANNOT_SET_RESOLVER) === 0 && eq(childApproved, ZERO) &&
      eq(registrarApproved, ZERO) && eq(upgradeContract, ZERO) &&
      !approvals.some((a) => a.wrapperApproved || a.registrarApproved)
    return {
      mode: 'LEGACY_ENSV1_FINALIZED_OBSERVATIONS_NOT_SOVEREIGN', chainId: 11155111,
      finalizedBlockNumber: blockNumber.toString(), finalizedBlockHash: block.hash,
      finalizedBlockTimestamp: block.timestamp.toString(), parentName, childName,
      parentNode, childNode, expectedMember, childResolver: resolver,
      registrarExpiry: registrarExpiry.toString(), parentExpiry: parentData[2].toString(),
      childExpiry: childData[2].toString(), parentRegistryOwner, childRegistryOwner,
      childWrappedOwner: childData[0], childFuses: childData[1],
      registrarNFTCustodyMatchesWrapper: eq(registrarOwner, WRAPPER),
      registrarNFTApprovalObserved: nonzero(registrarApproved),
      childApprovalObserved: nonzero(childApproved),
      upstreamWrapperUpgradeContractConfigured: nonzero(upgradeContract),
      sampledOperatorApprovals: approvals,
      approvalInventoryExhaustive: false,
      nativeLegacyHandoffConditionsObserved: nativeHolderConditions,
      memberResolverAutonomyObserved,
      sovereignReceipt: false, ensV2AuthorityVerified: false,
      opControllerAuthorityVerified: false, independentConsensusProofVerified: false,
    }
  } catch (error) {
    if (error instanceof LegacyHandoffEvidenceError) throw error
    throw new LegacyHandoffEvidenceError('rpc-or-contract-error')
  }
}
