import { decodeEventLog, isAddress, isHex, keccak256, toHex, type Address, type Hex, type PublicClient } from 'viem'
import { prepareV4IssueBySig } from '../../../sdk/v4/issuance'
import { preflightV4SignedIssuance, type V4IssuanceIntent, type V4IssuancePin } from './v4-issuance-preflight'

// No Worker HTTP route or writer/wallet implementation imports this file.
// External signer custody, durable atomic admission and identity proofs must be
// separately audited before connecting an actual send/broadcast capability.
const OP = 11155420
const ZERO32 = `0x${'00'.repeat(32)}`
const events = [{ type: 'event', name: 'IssuanceNonceConsumed', inputs: [
  { name: 'operator', type: 'address', indexed: true },
  { name: 'nonce', type: 'uint256', indexed: false },
  { name: 'node', type: 'bytes32', indexed: true },
] }, { type: 'event', name: 'SubnodeIssued', inputs: [
  { name: 'parent', type: 'bytes32', indexed: true },
  { name: 'node', type: 'bytes32', indexed: true },
  { name: 'holder', type: 'address', indexed: true },
  { name: 'issuer', type: 'address', indexed: false },
] }] as const
const readAbi = [{ type: 'function', name: 'issuanceNonce', stateMutability: 'view',
  inputs: [], outputs: [{ type: 'uint256' }] }] as const
const same = (a: unknown, b: unknown) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()
const bytes32 = (v: unknown): v is Hex => typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v)
const nonzero = (v: unknown): v is Address => typeof v === 'string' && isAddress(v) && !same(v, '0x0000000000000000000000000000000000000000')

export class V4ExecutionDenied extends Error {
  constructor(readonly code: 'disabled' | 'invalid' | 'unauthorized' | 'rate-limited' |
    'nonce-busy' | 'preflight-failed' | 'unverified-receipt') {
    super(`OP V4 execution adapter denied: ${code}`)
  }
}

/**
 * Each contract implementation must provide a different trust boundary:
 * authorize: verified authenticated HTTP principal, scoped to this contract;
 * throttle: durable atomic abuse limiter (not in-memory/V3 KV);
 * reserve: durable atomic claim with TTL (not in-memory/V3 KV).
 * No signing key or sendTransaction interface is accepted anywhere here.
 */
export interface V4Admission {
  authenticate: (credential: string, operator: Address, contract: Address) => Promise<string | null>
  throttle: (principal: string, key: string) => Promise<boolean>
  reserve: (key: string, deadline: bigint) => Promise<boolean>
}
export type V4ReadClient = Parameters<typeof preflightV4SignedIssuance>[0]
export type V4ReceiptClient = Pick<PublicClient,
  'getChainId' | 'getBlock' | 'getBytecode' | 'getTransaction' | 'getTransactionReceipt' | 'readContract'>

export interface V4UnsignedHandoff {
  chainId: 11155420
  contract: Address
  expectedCodeHash: Hex
  parentNode: Hex
  operator: Address
  member: Address
  label: string
  nonce: bigint
  deadline: bigint
  blockNumber: bigint
  blockHash: Hex
  data: Hex
  digest: Hex
  scope: 'op-application-only'
  status: 'UNSIGNED_HANDOFF_ONLY'
  signed: false
  broadcast: false
  l1NativeRights: false
}

/** Request metadata / feature gate are trusted server-side only. Never accept them from a JSON body. */
export async function prepareV4UnsignedExecution(input: {
  enabled?: boolean
  credential: string
  admission: V4Admission
  reader: V4ReadClient
  pin: V4IssuancePin
  intent: V4IssuanceIntent
  expectedOperator: Address
}): Promise<V4UnsignedHandoff> {
  if (input?.enabled !== true) throw new V4ExecutionDenied('disabled')
  const { admission, reader, expectedOperator, credential } = input
  // Capture all caller values once; reject getters/injected trust objects before awaits.
  let pin: V4IssuancePin, intent: V4IssuanceIntent
  try { pin = { ...input.pin }; intent = { ...input.intent } } catch { throw new V4ExecutionDenied('invalid') }
  if (!admission || !reader || !nonzero(expectedOperator) ||
      !same(intent.operator, expectedOperator) || !nonzero(pin.contract) ||
      typeof credential !== 'string' || credential.length < 24 || credential.length > 4096) {
    throw new V4ExecutionDenied('invalid')
  }
  let principal: string | null
  try { principal = await admission.authenticate(credential, expectedOperator, pin.contract) }
  catch { throw new V4ExecutionDenied('unauthorized') }
  if (typeof principal !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(principal)) {
    throw new V4ExecutionDenied('unauthorized')
  }
  const namespace = `${OP}:${pin.contract.toLowerCase()}:${intent.operator.toLowerCase()}`
  try {
    if (await admission.throttle(principal, namespace) !== true) throw new V4ExecutionDenied('rate-limited')
  } catch { throw new V4ExecutionDenied('rate-limited') }

  let proof: Awaited<ReturnType<typeof preflightV4SignedIssuance>>
  let calldata: ReturnType<typeof prepareV4IssueBySig>
  try {
    proof = await preflightV4SignedIssuance(reader, pin, intent)
    if (proof.issuanceNonce !== intent.nonce || !same(proof.contract, pin.contract) ||
        !same(proof.parentNode, pin.parentNode)) throw new V4ExecutionDenied('preflight-failed')
    calldata = prepareV4IssueBySig({ chainId: OP, verifyingContract: pin.contract },
      { label: intent.label, member: intent.member, initialAddr: intent.initialAddr,
        operator: intent.operator, nonce: intent.nonce, deadline: intent.deadline,
        controllerEpoch: proof.controllerEpoch, operatorRevision: proof.operatorRevision }, intent.signature)
  } catch { throw new V4ExecutionDenied('preflight-failed') }
  // The EVM, not this reservation, atomically consumes the nonce. Claim only
  // AFTER valid EIP-712 simulation; a bad signature must not poison a nonce.
  const claim = `${OP}:${pin.contract.toLowerCase()}:issue:${String(intent.nonce)}`
  try {
    if (await admission.reserve(claim, intent.deadline) !== true) throw Error('occupied')
  } catch { throw new V4ExecutionDenied('nonce-busy') }
  // Signature bytes are carried ONLY in this unsigned, restricted handoff;
  // never put this result in an unauthenticated response, KV, logs or analytics.
  return Object.freeze({ chainId: OP, contract: pin.contract, expectedCodeHash: pin.expectedCodeHash,
    parentNode: pin.parentNode,
    operator: intent.operator, member: intent.member, label: intent.label,
    nonce: intent.nonce, deadline: intent.deadline, blockNumber: proof.blockNumber,
    blockHash: proof.blockHash, data: calldata.data, digest: keccak256(calldata.data),
    scope: 'op-application-only', status: 'UNSIGNED_HANDOFF_ONLY',
    signed: false, broadcast: false, l1NativeRights: false })
}

/** Observe an EXTERNAL tx hash; cannot sign, send, replay or grant L1 rights. */
export async function verifyV4ExternalReceipt(reader: V4ReceiptClient,
  handoff: V4UnsignedHandoff, txHash: Hex) {
  try {
    if (!reader || !bytes32(txHash) || same(txHash, ZERO32) ||
        !handoff || handoff.chainId !== OP || handoff.status !== 'UNSIGNED_HANDOFF_ONLY' ||
        handoff.signed !== false || handoff.broadcast !== false ||
        !nonzero(handoff.operator) || !nonzero(handoff.member) || !nonzero(handoff.contract) ||
        !bytes32(handoff.parentNode) || !bytes32(handoff.expectedCodeHash) ||
        same(handoff.expectedCodeHash, ZERO32) || !bytes32(handoff.digest) ||
        !isHex(handoff.data, { strict: true }) || keccak256(handoff.data) !== handoff.digest ||
        await reader.getChainId() !== OP) throw Error('invalid')
    const [tx, receipt, finalized] = await Promise.all([
      reader.getTransaction({ hash: txHash }), reader.getTransactionReceipt({ hash: txHash }),
      reader.getBlock({ blockTag: 'finalized' }),
    ])
    if (!same(tx.hash, txHash) || !same(receipt.transactionHash, txHash) ||
        !same(tx.from, handoff.operator) || !same(receipt.from, handoff.operator) ||
        !same(tx.to, handoff.contract) || !same(receipt.to, handoff.contract) ||
        !same(tx.input, handoff.data) || tx.value !== 0n ||
        receipt.status !== 'success' || receipt.blockNumber !== tx.blockNumber ||
        !bytes32(receipt.blockHash) || !bytes32(finalized.hash) || same(finalized.hash, ZERO32) ||
        typeof finalized.number !== 'bigint' || finalized.number < receipt.blockNumber ||
        receipt.blockNumber < handoff.blockNumber) throw Error('receipt')
    const [historicalBlock, bytecode] = await Promise.all([
      reader.getBlock({ blockNumber: receipt.blockNumber }),
      reader.getBytecode({ address: handoff.contract, blockNumber: receipt.blockNumber }),
    ])
    if (!same(historicalBlock.hash, receipt.blockHash) ||
        !bytecode || !same(keccak256(bytecode), handoff.expectedCodeHash)) throw Error('reorg-or-code')
    const node = keccak256(`${handoff.parentNode}${keccak256(toHex(handoff.label)).slice(2)}`)
    const seen = new Set<string>()
    for (const log of receipt.logs) {
      if (!same(log.address, handoff.contract) || log.removed === true ||
          log.blockNumber !== receipt.blockNumber ||
          !same(log.transactionHash, txHash) || !same(log.blockHash, receipt.blockHash)) continue
      let event: ReturnType<typeof decodeEventLog>
      try { event = decodeEventLog({ abi: events, data: log.data, topics: log.topics }) }
      catch { continue }
      const args = event.args as Record<string, unknown>
      if (event.eventName === 'IssuanceNonceConsumed' &&
          same(args.operator, handoff.operator) && args.nonce === handoff.nonce &&
          same(args.node, node)) seen.add('nonce')
      if (event.eventName === 'SubnodeIssued' && same(args.parent, handoff.parentNode) &&
          same(args.node, node) && same(args.holder, handoff.member) &&
          same(args.issuer, handoff.operator)) seen.add('issued')
    }
    if (seen.size !== 2) throw Error('events')
    const consumed = await reader.readContract({ address: handoff.contract, abi: readAbi,
      functionName: 'issuanceNonce', blockNumber: receipt.blockNumber })
    if (typeof consumed !== 'bigint' || consumed <= handoff.nonce) throw Error('nonce')
    const repeat = await reader.getBlock({ blockNumber: receipt.blockNumber })
    if (!same(repeat.hash, receipt.blockHash) || await reader.getChainId() !== OP) throw Error('drift')
    return { status: 'EXTERNAL_OP_TX_OBSERVED_ONLY' as const,
      chainId: OP, txHash, blockNumber: receipt.blockNumber, node,
      scope: 'op-application-only' as const, receiptVerified: true as const,
      signedHere: false as const, broadcastHere: false as const, l1NativeRights: false as const }
  } catch { throw new V4ExecutionDenied('unverified-receipt') }
}
