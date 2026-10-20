import { isAddress, isHex, namehash } from 'viem'
import type { Address, Hex } from 'viem'
import type {
  NetworkProfile, RegisterMessage, SetAddrMessage, SetTextMessage,
  SetContenthashMessage, AddRegistrarMessage, RemoveRegistrarMessage,
} from './types.js'
import { SDKError } from './profiles.js'

// These fields and primary types mirror workers/api/src/index.ts and
// server/gateway/manage/schemas.ts. Keep them versioned for V3 compatibility.
export const RegisterTypes = {
  Register: [
    { name: 'parent', type: 'string' }, { name: 'label', type: 'string' },
    { name: 'owner', type: 'address' }, { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const
export const SetAddrTypes = {
  SetAddr: [
    { name: 'node', type: 'bytes32' }, { name: 'coinType', type: 'uint256' },
    { name: 'addr', type: 'bytes' }, { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const
export const SetTextTypes = {
  SetText: [
    { name: 'node', type: 'bytes32' }, { name: 'key', type: 'string' },
    { name: 'value', type: 'string' }, { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const
export const SetContenthashTypes = {
  SetContenthash: [
    { name: 'node', type: 'bytes32' }, { name: 'hash', type: 'bytes' },
    { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
  ],
} as const
export const AddRegistrarTypes = {
  AddRegistrar: [
    { name: 'parentNode', type: 'bytes32' }, { name: 'registrar', type: 'address' },
    { name: 'quota', type: 'uint256' }, { name: 'expiry', type: 'uint256' },
    { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
  ],
} as const
export const RemoveRegistrarTypes = {
  RemoveRegistrar: [
    { name: 'parentNode', type: 'bytes32' }, { name: 'registrar', type: 'address' },
    { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
  ],
} as const

function checkCommon(message: { nonce: bigint; deadline: bigint }): void {
  if (typeof message.nonce !== 'bigint' || message.nonce < 0n ||
      typeof message.deadline !== 'bigint' || message.deadline <= 0n) {
    throw new SDKError('invalid-input', 'nonce and deadline must be explicit nonnegative uint256 / positive Unix seconds')
  }
  const now = BigInt(Math.floor(Date.now() / 1000))
  if (message.deadline < now || message.deadline > now + 86_400n) {
    throw new SDKError('invalid-input', 'deadline is expired or exceeds Worker 24-hour validity limit')
  }
}

export const nodeOf = (name: string): Hex => namehash(name) as Hex

export function validateRegister(message: RegisterMessage, rootName: string): void {
  checkCommon(message)
  if (message.parent !== rootName) throw new SDKError('invalid-input', 'Signed parent must equal configured rootName')
  if (!/^[a-z0-9_-]{1,63}$/.test(message.label) || !isAddress(message.owner)) {
    throw new SDKError('invalid-input', 'Invalid registration label or owner')
  }
}

export function validateSetAddr(message: SetAddrMessage): void {
  checkCommon(message)
  if (!isBytes32(message.node) || typeof message.coinType !== 'bigint' || message.coinType < 0n ||
    !isHex(message.addr) || message.addr.length !== 42) {
    throw new SDKError('invalid-input', 'Invalid node, coinType or address bytes')
  }
}

export function validateSetText(message: SetTextMessage): void {
  checkCommon(message)
  if (!isBytes32(message.node) || !message.key || typeof message.value !== 'string') {
    throw new SDKError('invalid-input', 'Invalid node, text key or value')
  }
}

export function validateSetContenthash(message: SetContenthashMessage): void {
  checkCommon(message)
  if (!isBytes32(message.node) || !isHex(message.hash)) {
    throw new SDKError('invalid-input', 'Invalid node or contenthash bytes')
  }
}

function validateRegistrar(message: RemoveRegistrarMessage, profile: NetworkProfile): void {
  checkCommon(message)
  if (!isBytes32(message.parentNode) || message.parentNode.toLowerCase() !== nodeOf(profile.rootName).toLowerCase() ||
      !isAddress(message.registrar)) {
    throw new SDKError('invalid-input', 'Registrar must be an address scoped to the configured rootName parentNode')
  }
}

export function validateAddRegistrar(profile: NetworkProfile, message: AddRegistrarMessage): void {
  validateRegistrar(message, profile)
  if (typeof message.quota !== 'bigint' || message.quota < 0n || typeof message.expiry !== 'bigint' || message.expiry < 0n) {
    throw new SDKError('invalid-input', 'quota and expiry must be uint256 values')
  }
}

export function validateRemoveRegistrar(profile: NetworkProfile, message: RemoveRegistrarMessage): void {
  validateRegistrar(message, profile)
}

function isBytes32(hex: unknown): hex is Hex {
  return typeof hex === 'string' && /^0x[0-9a-fA-F]{64}$/.test(hex)
}

/** EIP-712 verifyingContract is always the actual L2 records contract. */
export const typedDataDomain = (profile: NetworkProfile) => ({
  name: 'CometENS' as const,
  version: '1' as const,
  chainId: profile.l2.chainId,
  verifyingContract: profile.l2.recordsAddress as Address,
})

export function typedDataForRegister(profile: NetworkProfile, message: RegisterMessage) {
  validateRegister(message, profile.rootName)
  return { domain: typedDataDomain(profile), primaryType: 'Register' as const, types: RegisterTypes, message }
}

export function typedDataForSetAddr(profile: NetworkProfile, message: SetAddrMessage) {
  validateSetAddr(message)
  return { domain: typedDataDomain(profile), primaryType: 'SetAddr' as const, types: SetAddrTypes, message }
}

export function typedDataForSetText(profile: NetworkProfile, message: SetTextMessage) {
  validateSetText(message)
  return { domain: typedDataDomain(profile), primaryType: 'SetText' as const, types: SetTextTypes, message }
}

export function typedDataForSetContenthash(profile: NetworkProfile, message: SetContenthashMessage) {
  validateSetContenthash(message)
  return { domain: typedDataDomain(profile), primaryType: 'SetContenthash' as const, types: SetContenthashTypes, message }
}

export function typedDataForAddRegistrar(profile: NetworkProfile, message: AddRegistrarMessage) {
  validateAddRegistrar(profile, message)
  return { domain: typedDataDomain(profile), primaryType: 'AddRegistrar' as const, types: AddRegistrarTypes, message }
}

export function typedDataForRemoveRegistrar(profile: NetworkProfile, message: RemoveRegistrarMessage) {
  validateRemoveRegistrar(profile, message)
  return { domain: typedDataDomain(profile), primaryType: 'RemoveRegistrar' as const, types: RemoveRegistrarTypes, message }
}
