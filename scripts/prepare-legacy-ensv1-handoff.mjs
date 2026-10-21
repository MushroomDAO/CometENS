/**
 * Unsigned, read-only draft for a legacy ENSv1 Sepolia NameWrapper transaction.
 * This is NOT current Sepolia ENSv2 ownership, a broadcast, or a sovereign receipt.
 */
import { encodeFunctionData, isAddress, keccak256, namehash, stringToHex } from 'viem'
import { ENSV1_SEPOLIA_REGISTRY, ENSV1_SEPOLIA_WRAPPER, CANNOT_UNWRAP, PARENT_CANNOT_CONTROL } from './audit-legacy-ensv1-authority.mjs'

export const ENSV1_SEPOLIA_REGISTRAR = '0x57f1887a8bf19b14fc0df6fd9b2acc9af147ea85'
const ZERO = '0x0000000000000000000000000000000000000000'
const PIN = /^0x[0-9a-fA-F]{64}$/
const MIN_VALIDITY_SECONDS = 24n * 60n * 60n
const CANNOT_CREATE_SUBDOMAIN = 1 << 5
const legacyRegistryAbi = [{ type: 'function', name: 'owner', stateMutability: 'view', inputs: [{ name: 'node', type: 'bytes32' }], outputs: [{ type: 'address' }] }]
const legacyWrapperAbi = [
  { type: 'function', name: 'getData', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ type: 'address' }, { type: 'uint32' }, { type: 'uint64' }] },
  { type: 'function', name: 'upgradeContract', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'setSubnodeRecord', stateMutability: 'nonpayable',
    inputs: [
      { name: 'parentNode', type: 'bytes32' }, { name: 'label', type: 'string' },
      { name: 'owner', type: 'address' }, { name: 'resolver', type: 'address' },
      { name: 'ttl', type: 'uint64' }, { name: 'fuses', type: 'uint32' }, { name: 'expiry', type: 'uint64' },
    ], outputs: [{ type: 'bytes32' }],
  },
]
const legacyRegistrarAbi = [
  { type: 'function', name: 'nameExpires', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'ownerOf', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'getApproved', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'address' }] },
]

export class HandoffPreparationError extends Error {
  constructor(code) { super(`ENSv1 unsigned handoff refused: ${code}`); this.name = 'HandoffPreparationError'; this.code = code }
}

function validLabel(label) {
  return typeof label === 'string' && label.length > 0 && label.length <= 63 &&
    /^[a-z0-9-]+$/.test(label) && !label.startsWith('-') && !label.endsWith('-') &&
    !(label.length >= 4 && label[2] === '-' && label[3] === '-')
}

function nonzeroAddress(value) { return typeof value === 'string' && isAddress(value) && value.toLowerCase() !== ZERO }
function equals(a, b) { return typeof a === 'string' && a.toLowerCase() === b.toLowerCase() }

/**
 * Read a single finalized snapshot; prepare calldata ONLY for parent-owner wallet.
 * Parent scope intentionally limited to one lowercase ASCII .eth 2LD, not ENSIP-15.
 */
export async function prepareLegacyEnsV1Handoff({
  client, parentName, label, member, resolver, expectedParentOwner, expiry,
  expectedRegistryCodeHash, expectedWrapperCodeHash, expectedRegistrarCodeHash,
}) {
  const parentLabel = typeof parentName === 'string' && parentName.endsWith('.eth') ? parentName.slice(0, -4) : ''
  if (!client || !validLabel(parentLabel) || parentName !== `${parentLabel}.eth` ||
      !validLabel(label) || !nonzeroAddress(member) || !nonzeroAddress(resolver) ||
      !nonzeroAddress(expectedParentOwner) || typeof expiry !== 'bigint' ||
      expiry > (1n << 64n) - 1n || expiry <= 0n ||
      !PIN.test(expectedRegistryCodeHash ?? '') || !PIN.test(expectedWrapperCodeHash ?? '') ||
      !PIN.test(expectedRegistrarCodeHash ?? '')) throw new HandoffPreparationError('invalid-input')

  try {
    if (await client.getChainId() !== 11155111) throw new HandoffPreparationError('wrong-chain')
    const block = await client.getBlock({ blockTag: 'finalized' })
    const now = BigInt(Math.floor(Date.now() / 1000))
    if (typeof block.number !== 'bigint' || typeof block.timestamp !== 'bigint' ||
        !PIN.test(block.hash ?? '') || /^0x0{64}$/i.test(block.hash) ||
        block.timestamp + 7200n < now || block.timestamp > now + 120n) {
      throw new HandoffPreparationError('stale-finality')
    }
    const blockNumber = block.number
    const addresses = [ENSV1_SEPOLIA_REGISTRY, ENSV1_SEPOLIA_WRAPPER, ENSV1_SEPOLIA_REGISTRAR]
    const hashes = [expectedRegistryCodeHash, expectedWrapperCodeHash, expectedRegistrarCodeHash]
    const bytecodes = await Promise.all(addresses.map((address) => client.getBytecode({ address, blockNumber })))
    if (bytecodes.some((code, i) => !code || code === '0x' || keccak256(code).toLowerCase() !== hashes[i].toLowerCase())) {
      throw new HandoffPreparationError('untrusted-bytecode')
    }

    const parentNode = namehash(parentName)
    const childNode = namehash(`${label}.${parentName}`)
    const registrarId = BigInt(keccak256(stringToHex(parentLabel)))
    const [registryOwner, childRegistryOwner, parentData, childData, registrarExpiry, registrarOwner, registrarApproval, wrapperUpgrade] = await Promise.all([
      client.readContract({ address: ENSV1_SEPOLIA_REGISTRY, abi: legacyRegistryAbi, functionName: 'owner', args: [parentNode], blockNumber }),
      client.readContract({ address: ENSV1_SEPOLIA_REGISTRY, abi: legacyRegistryAbi, functionName: 'owner', args: [childNode], blockNumber }),
      client.readContract({ address: ENSV1_SEPOLIA_WRAPPER, abi: legacyWrapperAbi, functionName: 'getData', args: [BigInt(parentNode)], blockNumber }),
      client.readContract({ address: ENSV1_SEPOLIA_WRAPPER, abi: legacyWrapperAbi, functionName: 'getData', args: [BigInt(childNode)], blockNumber }),
      client.readContract({ address: ENSV1_SEPOLIA_REGISTRAR, abi: legacyRegistrarAbi,
        functionName: 'nameExpires', args: [registrarId], blockNumber }),
      client.readContract({ address: ENSV1_SEPOLIA_REGISTRAR, abi: legacyRegistrarAbi,
        functionName: 'ownerOf', args: [registrarId], blockNumber }),
      client.readContract({ address: ENSV1_SEPOLIA_REGISTRAR, abi: legacyRegistrarAbi,
        functionName: 'getApproved', args: [registrarId], blockNumber }),
      client.readContract({ address: ENSV1_SEPOLIA_WRAPPER, abi: legacyWrapperAbi,
        functionName: 'upgradeContract', blockNumber }),
    ])
    if (!equals(registryOwner, ENSV1_SEPOLIA_WRAPPER) || !equals(childRegistryOwner, ZERO) ||
        !Array.isArray(parentData) || parentData.length !== 3 ||
        !equals(parentData[0], expectedParentOwner) || typeof parentData[1] !== 'number' ||
        (parentData[1] & CANNOT_UNWRAP) === 0 || (parentData[1] & CANNOT_CREATE_SUBDOMAIN) !== 0 ||
        typeof parentData[2] !== 'bigint' ||
        !Array.isArray(childData) || childData.length !== 3 ||
        !equals(childData[0], ZERO) || childData[1] !== 0 || typeof childData[2] !== 'bigint' ||
        childData[2] > expiry ||
        !equals(registrarOwner, ENSV1_SEPOLIA_WRAPPER) || !equals(registrarApproval, ZERO) ||
        !equals(wrapperUpgrade, ZERO) ||
        typeof registrarExpiry !== 'bigint' || registrarExpiry <= now + MIN_VALIDITY_SECONDS ||
        parentData[2] <= now + MIN_VALIDITY_SECONDS ||
        expiry <= now + MIN_VALIDITY_SECONDS || expiry + MIN_VALIDITY_SECONDS > registrarExpiry ||
        expiry > parentData[2]) {
      throw new HandoffPreparationError('unsafe-parent-or-expiry')
    }

    const fuses = CANNOT_UNWRAP | PARENT_CANNOT_CONTROL
    const data = encodeFunctionData({ abi: legacyWrapperAbi, functionName: 'setSubnodeRecord',
      args: [parentNode, label, member, resolver, 0n, fuses, expiry] })
    return {
      mode: 'LEGACY_ENSV1_SEPOLIA_UNSIGNED_PREPARATION_ONLY',
      sovereignReceipt: false, ensV2AuthorityVerified: false, opControllerAuthorityVerified: false,
      chainId: 11155111, from: expectedParentOwner, to: ENSV1_SEPOLIA_WRAPPER,
      value: '0', data, parentName, childName: `${label}.${parentName}`,
      blockNumber: blockNumber.toString(), blockHash: block.hash, blockTimestamp: block.timestamp.toString(),
      registrarExpiry: registrarExpiry.toString(), requestedExpiry: expiry.toString(),
      wrappedParentHolder: parentData[0], previousChildExpiry: childData[2].toString(),
      registrarNftHolder: registrarOwner, fuses,
      // This is NOT a proof of a resulting owner, fuse, expiry, resolver or transaction inclusion.
      nativeHandoffCompleted: false,
    }
  } catch (error) {
    if (error instanceof HandoffPreparationError) throw error
    throw new HandoffPreparationError('rpc-or-contract-error')
  }
}
