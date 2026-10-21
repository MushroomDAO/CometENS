import { encodeFunctionData, isAddress, isHex } from 'viem'
import type { Address, Hex } from 'viem'
import { SDKError } from '../profiles.js'

/** OP application V4 only. This builds bytes; it never signs or broadcasts. */
export const v4IssuePermitTypes = {
  Issue: [
    { name: 'label', type: 'string' },
    { name: 'member', type: 'address' },
    { name: 'initialAddr', type: 'address' },
    { name: 'operator', type: 'address' },
    { name: 'controllerEpoch', type: 'uint64' },
    { name: 'operatorRevision', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const

const ZERO = '0x0000000000000000000000000000000000000000'
const MAX_U64 = (1n << 64n) - 1n
const MAX_U256 = (1n << 256n) - 1n
const MAX_ISSUANCE_NONCE = MAX_U256 - (1n << 128n)
const abi = [{ type: 'function', name: 'issueBySig', stateMutability: 'nonpayable', inputs: [
  { type: 'string', name: 'label' }, { type: 'address', name: 'member' },
  { type: 'address', name: 'initialAddr' }, { type: 'uint256', name: 'nonce' },
  { type: 'uint256', name: 'deadline' }, { type: 'bytes', name: 'signature' },
], outputs: [{ type: 'bytes32', name: 'node' }] }] as const

export interface V4IssueDomain {
  chainId: 11155420
  verifyingContract: Address
}

export interface V4IssuePermit {
  label: string
  member: Address
  initialAddr: Address
  operator: Address
  controllerEpoch: bigint
  operatorRevision: bigint
  nonce: bigint
  deadline: bigint
}

const invalid = () => { throw new SDKError('invalid-input', 'Invalid scoped OP V4 issue permit') }
const isUInt = (value: unknown, max: bigint, min = 0n) =>
  typeof value === 'bigint' && value >= min && value <= max
const nonzero = (address: unknown): address is Address =>
  typeof address === 'string' && isAddress(address) && address.toLowerCase() !== ZERO

/**
 * Pure EIP-712 intent: caller MUST verify deployed runtime/parent, active
 * controller and onchain epoch/revision/nonce independently before signing.
 * This is not an authority/expiry/nonce reservation or native ENS proof.
 */
export function createV4IssueTypedData(profile: V4IssueDomain, permit: V4IssuePermit) {
  let p: V4IssueDomain, m: V4IssuePermit
  try { p = { ...profile }; m = { ...permit } } catch { return invalid() }
  if (!p || !m || Object.keys(p).sort().join(',') !== 'chainId,verifyingContract' ||
      Object.keys(m).sort().join(',') !== 'controllerEpoch,deadline,initialAddr,label,member,nonce,operator,operatorRevision' ||
      p.chainId !== 11155420 || !nonzero(p.verifyingContract) ||
      !nonzero(m.member) || !nonzero(m.operator) ||
      typeof m.initialAddr !== 'string' || !isAddress(m.initialAddr) ||
      typeof m.label !== 'string' || m.label.length < 1 || m.label.length > 63 ||
      !/^[a-z0-9-]+$/.test(m.label) || m.label.startsWith('-') || m.label.endsWith('-') ||
      (m.label.length >= 4 && m.label[2] === '-' && m.label[3] === '-') ||
      !isUInt(m.controllerEpoch, MAX_U64, 1n) || !isUInt(m.operatorRevision, MAX_U256, 1n) ||
      !isUInt(m.nonce, MAX_ISSUANCE_NONCE - 1n) || !isUInt(m.deadline, MAX_U256, 1n)) invalid()

  return {
    domain: { name: 'CometENS Community V4', version: '1', chainId: 11155420,
      verifyingContract: p.verifyingContract },
    types: v4IssuePermitTypes,
    primaryType: 'Issue' as const,
    message: { label: m.label, member: m.member, initialAddr: m.initialAddr,
      operator: m.operator, controllerEpoch: m.controllerEpoch,
      operatorRevision: m.operatorRevision, nonce: m.nonce, deadline: m.deadline },
  }
}

/** Encodes operator-submitted calldata after a separate controller EIP-712 signature. */
export function prepareV4IssueBySig(profile: V4IssueDomain, permit: V4IssuePermit, signature: Hex) {
  const typed = createV4IssueTypedData(profile, permit)
  if (typeof signature !== 'string' || !isHex(signature, { strict: true }) ||
      signature.length <= 2 || signature.length > 8194 || signature.length % 2 !== 0) invalid()
  return {
    chainId: typed.domain.chainId, from: typed.message.operator, to: typed.domain.verifyingContract,
    value: 0n, data: encodeFunctionData({ abi, functionName: 'issueBySig', args: [
      typed.message.label, typed.message.member, typed.message.initialAddr,
      typed.message.nonce, typed.message.deadline, signature,
    ] }),
    ownershipScope: 'op-application-only' as const, controllerSignatureIncluded: true as const,
    transactionSigned: false as const, broadcast: false as const, l1OwnershipVerified: false as const,
  }
}
