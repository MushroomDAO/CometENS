import { isAddress, isHex, keccak256, type Address, type Hex, type PublicClient } from 'viem'

// Standalone read-only G2.6 boundary. Intentionally NOT wired to V3 KV routes.
// A successful dry-run is not transaction authorization or a delivery receipt.
const abi = [
  { type: 'function', name: 'parentNode', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'l1OwnershipVerified', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'rootController', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'controllerEpoch', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint64' }] },
  { type: 'function', name: 'issuanceNonce', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'operatorRevision', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'operators', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [
    { type: 'uint256' }, { type: 'uint64' }, { type: 'uint64' }, { type: 'uint64' },
  ] },
  { type: 'function', name: 'issueBySig', stateMutability: 'nonpayable', inputs: [
    { type: 'string' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' },
    { type: 'uint256' }, { type: 'bytes' },
  ], outputs: [{ type: 'bytes32' }] },
] as const

const OP_SEPOLIA = 11155420
const SIGNED_ISSUER = 5n // CAP_ISSUE | CAP_SIGNED_ISSUE
const INITIAL_ADDR = 2n
const ZERO = '0x0000000000000000000000000000000000000000'
type Reader = Pick<PublicClient, 'getChainId' | 'getBlock' | 'getBytecode' | 'readContract' | 'simulateContract'>

export interface V4IssuancePin {
  chainId: 11155420
  contract: Address
  parentNode: Hex
  expectedCodeHash: Hex
}

export interface V4IssuanceIntent {
  operator: Address
  label: string
  member: Address
  initialAddr: Address
  nonce: bigint
  deadline: bigint
  signature: Hex
}

export class V4PreflightDenied extends Error {
  constructor(readonly code: 'invalid-input' | 'identity' | 'stale' | 'rejected' | 'rpc-unavailable') {
    super(`V4 signed issuance preflight denied: ${code}`)
  }
}

const validAccount = (address: string) => isAddress(address) && address.toLowerCase() !== ZERO
const validBytes32 = (value: string) => /^0x[0-9a-fA-F]{64}$/.test(value)

/**
 * Re-read actual OP state and eth_call the exact contract entrypoint at one
 * pinned block. KV, a cache nonce, or an asserted "approved" flag is never an
 * input. Onchain execution must repeat ALL checks and consume the real nonce.
 */
export async function preflightV4SignedIssuance(reader: Reader, pin: V4IssuancePin, intent: V4IssuanceIntent) {
  // Snapshot untrusted caller objects before the first await. Mutable getters
  // cannot switch operator/nonce/contract between the precheck and eth_call.
  try { pin = { ...pin }; intent = { ...intent } } catch { throw new V4PreflightDenied('invalid-input') }
  if (!pin || pin.chainId !== OP_SEPOLIA || !validAccount(pin.contract) ||
      !validBytes32(pin.parentNode) || pin.parentNode.toLowerCase() === `0x${'0'.repeat(64)}` ||
      !validBytes32(pin.expectedCodeHash) ||
      pin.expectedCodeHash.toLowerCase() === `0x${'0'.repeat(64)}` ||
      !intent || !validAccount(intent.operator) || !validAccount(intent.member) ||
      !isAddress(intent.initialAddr) || typeof intent.label !== 'string' ||
      typeof intent.nonce !== 'bigint' || intent.nonce < 0n ||
      typeof intent.deadline !== 'bigint' || intent.deadline < 0n ||
      !isHex(intent.signature, { strict: true }) || intent.signature.length < 4 ||
      intent.signature.length > 8194) throw new V4PreflightDenied('invalid-input')

  try {
    if (await reader.getChainId() !== OP_SEPOLIA) throw new V4PreflightDenied('identity')
    const block = await reader.getBlock({ blockTag: 'latest' })
    if (!validBytes32(block.hash ?? '') || block.hash?.toLowerCase() === `0x${'0'.repeat(64)}` ||
        typeof block.number !== 'bigint' || block.number < 0n ||
        typeof block.timestamp !== 'bigint' || block.timestamp < 0n) {
      throw new V4PreflightDenied('rpc-unavailable')
    }
    const blockNumber = block.number
    const read = (functionName: 'parentNode' | 'l1OwnershipVerified' | 'rootController' |
      'controllerEpoch' | 'issuanceNonce' | 'operatorRevision' | 'operators') =>
      reader.readContract({ address: pin.contract, abi, functionName,
        args: functionName === 'operatorRevision' || functionName === 'operators' ? [intent.operator] : [], blockNumber })

    const [bytecode, parent, nativeClaim, controller, epoch, nonce, revision, operator] = await Promise.all([
      reader.getBytecode({ address: pin.contract, blockNumber }),
      read('parentNode'), read('l1OwnershipVerified'), read('rootController'),
      read('controllerEpoch'), read('issuanceNonce'), read('operatorRevision'), read('operators'),
    ])
    if (!bytecode || keccak256(bytecode).toLowerCase() !== pin.expectedCodeHash.toLowerCase() ||
        parent !== pin.parentNode || nativeClaim !== false || !validAccount(controller as string)) {
      throw new V4PreflightDenied('identity')
    }

    if (!Array.isArray(operator) || operator.length !== 4 ||
        operator.some((entry: unknown) => typeof entry !== 'bigint')) throw new V4PreflightDenied('identity')
    const [permissions, quota, expiresAt, grantEpoch] = operator as unknown as readonly [bigint, bigint, bigint, bigint]
    if (typeof nonce !== 'bigint' || nonce !== intent.nonce || typeof epoch !== 'bigint' ||
        typeof revision !== 'bigint' || (permissions & SIGNED_ISSUER) !== SIGNED_ISSUER ||
        (intent.initialAddr.toLowerCase() !== ZERO && (permissions & INITIAL_ADDR) === 0n) ||
        quota <= 0n || grantEpoch !== epoch || expiresAt <= block.timestamp ||
        intent.deadline < block.timestamp || intent.deadline > block.timestamp + 86400n) {
      throw new V4PreflightDenied('stale')
    }

    // eth_call executes EOA/ERC-1271 signature verification and receiver hooks,
    // and exposes duplicate/expired/revoked/nonmatching permits without a write.
    await reader.simulateContract({ address: pin.contract, abi, functionName: 'issueBySig',
      account: intent.operator, args: [intent.label, intent.member, intent.initialAddr,
        intent.nonce, intent.deadline, intent.signature], blockNumber })

    // A changing latest head means our positive result could already be stale.
    // This does NOT remove the race between return and a later real tx.
    const after = await reader.getBlock({ blockTag: 'latest' })
    if (after.number !== blockNumber || after.hash !== block.hash ||
        await reader.getChainId() !== OP_SEPOLIA) throw new V4PreflightDenied('stale')
    return { chainId: OP_SEPOLIA, contract: pin.contract, parentNode: pin.parentNode,
      blockNumber, blockHash: block.hash, issuanceNonce: nonce, operatorRevision: revision,
      controllerEpoch: epoch, scope: 'op-application-only' as const,
      preflightOnly: true as const, atomicExecutionVerified: false as const }
  } catch (error) {
    if (error instanceof V4PreflightDenied) throw error
    // No signature, RPC URLs, private keys, or provider exception messages in errors.
    throw new V4PreflightDenied('rejected')
  }
}
