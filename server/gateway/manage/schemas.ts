export type Eip712Domain = {
  name: string
  version: string
  chainId: number
  verifyingContract: `0x${string}`
}

export const RegisterTypes = {
  Register: [
    { name: 'parent', type: 'string' },
    { name: 'label', type: 'string' },
    { name: 'owner', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const

export type RegisterMessage = {
  parent: string
  label: string
  owner: `0x${string}`
  nonce: bigint
  deadline: bigint
}

export const SetAddrTypes = {
  SetAddr: [
    { name: 'node', type: 'bytes32' },
    { name: 'coinType', type: 'uint256' },
    { name: 'addr', type: 'bytes' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const

export type SetAddrMessage = {
  node: `0x${string}`
  coinType: bigint
  addr: `0x${string}`
  nonce: bigint
  deadline: bigint
}

export const SetTextTypes = {
  SetText: [
    { name: 'node', type: 'bytes32' },
    { name: 'key', type: 'string' },
    { name: 'value', type: 'string' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const

export type SetTextMessage = {
  node: `0x${string}`
  key: string
  value: string
  nonce: bigint
  deadline: bigint
}

export const SetContenthashTypes = {
  SetContenthash: [
    { name: 'node', type: 'bytes32' },
    { name: 'hash', type: 'bytes' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const

export type SetContenthashMessage = {
  node: `0x${string}`
  hash: `0x${string}`
  nonce: bigint
  deadline: bigint
}

export const AddRegistrarTypes = {
  AddRegistrar: [
    { name: 'parentNode', type: 'bytes32' },
    { name: 'registrar', type: 'address' },
    { name: 'quota', type: 'uint256' },
    { name: 'expiry', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const

export type AddRegistrarMessage = {
  parentNode: `0x${string}`
  registrar: `0x${string}`
  quota: bigint
  expiry: bigint
  nonce: bigint
  deadline: bigint
}

export function buildDomain(chainId: number, verifyingContract: `0x${string}`): Eip712Domain {
  return { name: 'CometENS', version: '1', chainId, verifyingContract }
}

