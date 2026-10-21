import { encodeFunctionData, isAddress, keccak256, namehash, type Address, type Hex, type PublicClient } from 'viem'
import { SDKError } from '../profiles.js'

/** Application-level OP V4 contract. NOT native L1 ENS or a sovereign receipt. */
export const v4CommunityAbi = [
  { type: 'function', name: 'parentNode', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'rootController', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'pendingController', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'controllerEpoch', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint64' }] },
  { type: 'function', name: 'l1OwnershipVerified', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'operators', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }, { type: 'uint64' }, { type: 'uint64' }, { type: 'uint64' }] },
  { type: 'function', name: 'operatorActive', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'grantOperator', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }, { type: 'uint64' }, { type: 'uint64' }], outputs: [] },
  { type: 'function', name: 'revokeOperator', stateMutability: 'nonpayable', inputs: [{ type: 'address' }], outputs: [] },
  { type: 'function', name: 'rotateOperator', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint64' }, { type: 'uint64' }], outputs: [] },
  { type: 'function', name: 'proposeController', stateMutability: 'nonpayable', inputs: [{ type: 'address' }], outputs: [] },
  { type: 'function', name: 'acceptController', stateMutability: 'nonpayable', inputs: [], outputs: [] },
] as const

export const V4_CAP_ISSUE = 1n
export const V4_CAP_INITIAL_ADDR = 2n
const MAX_U64 = (1n << 64n) - 1n
const ZERO = '0x0000000000000000000000000000000000000000'

/** Pinned, explicit OP Sepolia application contract identity. No secrets. */
export interface V4ControllerProfile {
  parentName: string
  /** G2 development intentionally has no implicit OP mainnet mode. */
  chainId: 11155420
  contract: Address
  /** Required keccak256 of the *deployed runtime bytecode*. No blind code fallback. */
  expectedCodeHash: Hex
}

type V4Reader = Pick<PublicClient, 'getChainId' | 'getBytecode' | 'readContract'>

export interface V4PreparedTx {
  chainId: 11155420
  from: Address
  to: Address
  data: Hex
  value: 0n
  /** This is an application-level OP NFT service, never an L1 ENS handoff. */
  ownershipScope: 'op-application-only'
}

function validAddress(value: string): value is Address {
  return isAddress(value) && value.toLowerCase() !== ZERO
}

function requiredAddress(value: string) {
  if (!validAddress(value)) throw new SDKError('invalid-input', 'Nonzero EVM address required')
}

function validateGrant(permissions: bigint, quota: bigint, expiresAt: bigint) {
  if ((permissions & V4_CAP_ISSUE) === 0n || (permissions & ~3n) !== 0n || quota <= 0n ||
      quota > MAX_U64 || expiresAt <= BigInt(Math.floor(Date.now() / 1000)) || expiresAt > MAX_U64) {
    throw new SDKError('invalid-input', 'Invalid scoped V4 operator permissions, quota or expiry')
  }
}

/**
 * Read and prepare calldata only. The caller's wallet independently signs and
 * sends via EIP-155 transaction; this module never handles keys or broadcasts.
 */
export class V4ControllerAdapter {
  readonly #profile: Readonly<V4ControllerProfile>

  get profile(): Readonly<V4ControllerProfile> { return this.#profile }

  constructor(profile: V4ControllerProfile, private readonly publicClient: V4Reader) {
    // Read all properties once. Accessors on an untrusted object must not
    // yield a different chain/contract between validation and storage.
    const p = profile && { ...profile }
    if (!p || p.chainId !== 11155420 ||
        !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.eth$/.test(p.parentName) ||
        !validAddress(p.contract) || !/^0x[0-9a-fA-F]{64}$/.test(p.expectedCodeHash)) {
      throw new SDKError('invalid-input', 'Explicit OP Sepolia parent and contract codehash pin required')
    }
    if (Object.keys(p).some((key) => !['parentName', 'chainId', 'contract', 'expectedCodeHash'].includes(key))) {
      throw new SDKError('invalid-input', 'Unexpected field in public V4 profile')
    }
    this.#profile = Object.freeze(p)
  }

  private async contractRead(functionName: 'parentNode' | 'rootController' | 'pendingController' | 'controllerEpoch' | 'l1OwnershipVerified') {
    return this.publicClient.readContract({ address: this.#profile.contract, abi: v4CommunityAbi, functionName })
  }

  /** Always verifies fresh RPC identity, runtime hash and deployed parent. */
  async verify(): Promise<{ controller: Address; l1OwnershipVerified: false }> {
    try {
      const chain = await this.publicClient.getChainId()
      if (chain !== this.#profile.chainId) throw new SDKError('chain-mismatch', 'Unexpected OP chainId')
      const code = await this.publicClient.getBytecode({ address: this.#profile.contract })
      if (!code || code === '0x' || keccak256(code).toLowerCase() !== this.#profile.expectedCodeHash.toLowerCase()) {
        throw new SDKError('contract-missing', 'V4 runtime bytecode missing or does not match expected hash')
      }
      const [parent, controller, verified] = await Promise.all([
        this.contractRead('parentNode'), this.contractRead('rootController'), this.contractRead('l1OwnershipVerified'),
      ])
      if (parent !== namehash(this.#profile.parentName) || !validAddress(controller as string) || verified !== false) {
        throw new SDKError('unsupported-protocol', 'V4 application contract/parent is not this pinned G2 PoC')
      }
      return { controller: controller as Address, l1OwnershipVerified: false }
    } catch (error) {
      if (error instanceof SDKError) throw error
      throw new SDKError('rpc-unavailable', 'Unable to verify the pinned OP application contract')
    }
  }

  async getOperator(operator: Address) {
    requiredAddress(operator)
    const { controller, l1OwnershipVerified } = await this.verify()
    try {
      const [data, canIssue, canInitialAddr] = await Promise.all([
        this.publicClient.readContract({ address: this.#profile.contract, abi: v4CommunityAbi, functionName: 'operators', args: [operator] }),
        this.publicClient.readContract({ address: this.#profile.contract, abi: v4CommunityAbi, functionName: 'operatorActive', args: [operator, V4_CAP_ISSUE] }),
        this.publicClient.readContract({ address: this.#profile.contract, abi: v4CommunityAbi, functionName: 'operatorActive', args: [operator, V4_CAP_ISSUE | V4_CAP_INITIAL_ADDR] }),
      ])
      const [permissions, remainingQuota, expiresAt, epoch] = data as readonly [bigint, bigint, bigint, bigint]
      if (typeof canIssue !== 'boolean' || typeof canInitialAddr !== 'boolean') throw new Error('Invalid operator status')
      return { operator, controller, permissions, remainingQuota, expiresAt, epoch, canIssue,
        canInitialAddr,
        l1OwnershipVerified, scope: 'op-application-only' as const }
    } catch {
      throw new SDKError('rpc-unavailable', 'Unable to read V4 operator state')
    }
  }

  /** Independent OP state only. Pending controller and epoch are actual on-chain values. */
  async getControllerStatus() {
    const { controller, l1OwnershipVerified } = await this.verify()
    try {
      const [pendingController, controllerEpoch] = await Promise.all([
        this.contractRead('pendingController'), this.contractRead('controllerEpoch'),
      ])
      if (typeof pendingController !== 'string' || !isAddress(pendingController) ||
          typeof controllerEpoch !== 'bigint' || controllerEpoch < 1n) {
        throw new Error('Invalid controller status')
      }
      return { controller, pendingController, controllerEpoch, parentName: this.#profile.parentName,
        contract: this.#profile.contract, chainId: this.#profile.chainId, l1OwnershipVerified,
        scope: 'op-application-only' as const }
    } catch {
      throw new SDKError('rpc-unavailable', 'Unable to read pinned V4 controller status')
    }
  }

  /** Validate a mined OP receipt's destination. Success does not attest ENS authority. */
  async getReceipt(hash: Hex) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new SDKError('invalid-input', 'Transaction hash must be 32 bytes')
    await this.verify()
    const receiptReader = this.publicClient as V4Reader & { getTransactionReceipt?: PublicClient['getTransactionReceipt'] }
    if (!receiptReader.getTransactionReceipt) throw new SDKError('unsupported-protocol', 'Receipt lookup is unavailable on this reader')
    try {
      const receipt = await receiptReader.getTransactionReceipt({ hash })
      if (receipt.to?.toLowerCase() !== this.#profile.contract.toLowerCase()) {
        throw new SDKError('invalid-input', 'Receipt destination differs from the pinned V4 contract')
      }
      if (await this.publicClient.getChainId() !== this.#profile.chainId) {
        throw new SDKError('chain-mismatch', 'RPC network changed during receipt read')
      }
      return { transactionHash: receipt.transactionHash, blockNumber: receipt.blockNumber,
        status: receipt.status, from: receipt.from, to: receipt.to, chainId: this.#profile.chainId,
        scope: 'op-application-only' as const }
    } catch (error) {
      if (error instanceof SDKError) throw error
      throw new SDKError('rpc-unavailable', 'Unable to read V4 transaction receipt')
    }
  }

  private async controllerTx(from: Address, data: Hex): Promise<V4PreparedTx> {
    requiredAddress(from)
    const { controller } = await this.verify()
    if (from.toLowerCase() !== controller.toLowerCase()) throw new SDKError('unauthorized', 'Only the current community controller may authorize operators')
    // Typed ABI encoding is the sole output: never auto-send or guess from/wallet.
    return { from, to: this.#profile.contract, chainId: this.#profile.chainId, data, value: 0n, ownershipScope: 'op-application-only' }
  }

  async prepareGrant(from: Address, operator: Address, permissions: bigint, quota: bigint, expiresAt: bigint) {
    requiredAddress(operator)
    validateGrant(permissions, quota, expiresAt)
    if (operator.toLowerCase() === (await this.verify()).controller.toLowerCase()) throw new SDKError('invalid-input', 'Cannot grant operator permissions to the controller')
    return this.controllerTx(from, encodeFunctionData({ abi: v4CommunityAbi, functionName: 'grantOperator', args: [operator, permissions, quota, expiresAt] }))
  }

  async prepareRevoke(from: Address, operator: Address) {
    requiredAddress(operator)
    return this.controllerTx(from, encodeFunctionData({ abi: v4CommunityAbi, functionName: 'revokeOperator', args: [operator] }))
  }

  async prepareRotate(from: Address, oldOperator: Address, newOperator: Address, permissions: bigint, quota: bigint, expiresAt: bigint) {
    requiredAddress(oldOperator)
    requiredAddress(newOperator)
    if (oldOperator.toLowerCase() === newOperator.toLowerCase()) throw new SDKError('invalid-input', 'Operator rotation must change the address')
    validateGrant(permissions, quota, expiresAt)
    if (newOperator.toLowerCase() === (await this.verify()).controller.toLowerCase()) throw new SDKError('invalid-input', 'Cannot rotate an operator to the controller')
    return this.controllerTx(from, encodeFunctionData({ abi: v4CommunityAbi, functionName: 'rotateOperator', args: [oldOperator, newOperator, permissions, quota, expiresAt] }))
  }

  async prepareControllerHandoff(from: Address, nextController: Address) {
    requiredAddress(nextController)
    if (nextController.toLowerCase() === (await this.verify()).controller.toLowerCase()) throw new SDKError('invalid-input', 'Already the current controller')
    return this.controllerTx(from, encodeFunctionData({ abi: v4CommunityAbi, functionName: 'proposeController', args: [nextController] }))
  }

  /** Cancel a pending nomination by preparing proposeController(address(0)). */
  async prepareCancelHandoff(from: Address): Promise<V4PreparedTx> {
    requiredAddress(from)
    const status = await this.getControllerStatus()
    if (from.toLowerCase() !== status.controller.toLowerCase()) {
      throw new SDKError('unauthorized', 'Only the current controller may cancel a handoff')
    }
    if (status.pendingController.toLowerCase() === ZERO) {
      throw new SDKError('invalid-input', 'No pending controller handoff to cancel')
    }
    return this.controllerTx(from, encodeFunctionData({
      abi: v4CommunityAbi, functionName: 'proposeController', args: [ZERO],
    }))
  }

  /** Only the nominated next controller signs the second handoff transaction. */
  async prepareAcceptController(from: Address): Promise<V4PreparedTx> {
    requiredAddress(from)
    await this.verify()
    try {
      const pending = await this.contractRead('pendingController')
      if (typeof pending !== 'string' || !validAddress(pending) || pending.toLowerCase() !== from.toLowerCase()) {
        throw new SDKError('unauthorized', 'Wallet is not the pending community controller')
      }
      return { from, to: this.#profile.contract, chainId: this.#profile.chainId,
        data: encodeFunctionData({ abi: v4CommunityAbi, functionName: 'acceptController' }),
        value: 0n, ownershipScope: 'op-application-only' }
    } catch (error) {
      if (error instanceof SDKError) throw error
      throw new SDKError('rpc-unavailable', 'Unable to verify the proposed controller')
    }
  }
}
