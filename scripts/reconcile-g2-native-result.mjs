/**
 * Correlates native issuance and OP observation at two finalized-RPC snapshots.
 * Never certifies Ethereum consensus, live ENS title, or L2 permission.
 */
import {
  decodeEventLog, decodeFunctionData, encodeAbiParameters, isAddress,
  keccak256, parseAbi, parseAbiItem, parseAbiParameters, toEventSelector, toHex,
} from 'viem'
import { observeNativeIssueReceipt, NativeReceiptFailure } from './observe-g2-native-issuance-receipt.mjs'

const OP_CHAIN = 11155420
const L1_CHAIN = 11155111
const MESSENGER = '0x4200000000000000000000000000000000000007'
const VERSION = keccak256(toHex('COMETENS_G2_NATIVE_RESULT_V1'))
const HEX32 = /^0x[0-9a-fA-F]{64}$/
const DECIMAL = /^(0|[1-9][0-9]*)$/
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()
const ISSUE_ABI = parseAbi([
  'function issueAndRelay(string label,address member,address resolver,uint64 expiry,address opRequester,uint256 requestNonce,uint32 minGasLimit) returns (bytes32)',
])
const L1_SENT = parseAbiItem(
  'event NativeIssueResultSent(bytes32 indexed requestId,bytes32 indexed childNode,address indexed member,uint64 sourceBlockNumber)',
)
const OP_OBSERVED = parseAbiItem(
  'event NativeResultObserved(bytes32 indexed requestId,bytes32 indexed childNode,uint64 sourceBlockNumber)',
)
const OP_ABI = parseAbi([
  'function parentNode() view returns (bytes32)',
  'function l1ResultEmitter() view returns (address)',
  'function requests(bytes32) view returns (address requester,bytes32 childNode,address member,uint64 expiry,uint256 nonce,uint8 status,uint64 observedSourceBlock)',
])
const RELAY_ABI = parseAbi([
  'function destinationInbox() view returns (address)',
  'function l1Messenger() view returns (address)',
  'function messengerRuntimeHash() view returns (bytes32)',
  'function MESSAGE_VERSION() view returns (bytes32)',
  'function sentRequest(bytes32) view returns (bool)',
])
const ID_TYPES = parseAbiParameters(
  'bytes32,uint256,uint256,address,address,bytes32,address,bytes32,address,uint64,uint256',
)

export class CrosschainReconciliationFailure extends Error {
  constructor(code) { super(`G2 native result reconciliation: ${code}`); this.code = code }
}
const fail = (code) => { throw new CrosschainReconciliationFailure(code) }
const blockPinned = async (client, number, hash, requireTransaction) => {
  const block = await client.getBlock({ blockNumber: number })
  if (block?.number !== number || !same(block.hash, hash) ||
      !Array.isArray(block.transactions) ||
      !block.transactions.some(x => same(typeof x === 'string' ? x : x?.hash, requireTransaction))) {
    fail('unanchored-transaction')
  }
}
const checkFinalized = async (client, priorHead, sourceNumber, sourceHash) => {
  const head = await client.getBlock({ blockTag: 'finalized' })
  if (typeof head?.number !== 'bigint' || head.number < priorHead.number ||
      head.number < sourceNumber ||
      (head.number === priorHead.number && !same(head.hash, priorHead.hash))) fail('finality-conflict')
  const block = await client.getBlock({ blockNumber: sourceNumber })
  if (block?.number !== sourceNumber || !same(block.hash, sourceHash)) fail('finality-conflict')
}

/**
 * Positive result is *two bounded RPC observations*, not a native proof.
 * The caller cannot manufacture a sovereign status via an optional profile field.
 */
export async function reconcileNativeIssueResult({ l1Client, opClient, profile }) {
  if (!l1Client || !opClient || !profile || typeof profile !== 'object' || Array.isArray(profile)) fail('invalid-input')
  const {
    opInbox, opInboxCodeHash, opTransactionHash, opRequester, requestNonce,
    l1Messenger, l1MessengerCodeHash, ...l1Profile
  } = profile
  if (!ADDRESS.test(opInbox ?? '') || !ADDRESS.test(opRequester ?? '') ||
      !ADDRESS.test(l1Messenger ?? '') ||
      !HEX32.test(l1MessengerCodeHash ?? '') || /^0x0+$/i.test(l1MessengerCodeHash) ||
      !HEX32.test(opInboxCodeHash ?? '') || /^0x0+$/i.test(opInboxCodeHash) ||
      !HEX32.test(opTransactionHash ?? '') || typeof requestNonce !== 'string' ||
      !DECIMAL.test(requestNonce) || requestNonce.length > 78 ||
      BigInt(requestNonce) === 0n || BigInt(requestNonce) > (1n << 256n) - 1n) fail('invalid-profile')
  try {
    if (await l1Client.getChainId() !== L1_CHAIN || await opClient.getChainId() !== OP_CHAIN) fail('wrong-chain')
    // This independently checks native ENSv1 child event, issuer source/code and
    // end-of-L1-block Registry/NameWrapper holder, expiry and CU/PCC observations.
    const native = await observeNativeIssueReceipt({ client: l1Client, profile: l1Profile })
    const l1Height = BigInt(native.sourceBlock.number)
    const l1Tx = await l1Client.getTransaction({ hash: native.transactionHash })
    if (!same(l1Tx?.to, native.source) || l1Tx?.blockNumber !== l1Height ||
        typeof l1Tx?.input !== 'string') fail('wrong-l1-entrypoint')
    let calldata
    try { calldata = decodeFunctionData({ abi: ISSUE_ABI, data: l1Tx.input }) } catch { fail('wrong-l1-entrypoint') }
    if (calldata.functionName !== 'issueAndRelay' ||
        calldata.args[0] !== l1Profile.childLabel || !same(calldata.args[1], native.member) ||
        BigInt(calldata.args[3]) !== BigInt(native.expiry) ||
        !same(calldata.args[4], opRequester) ||
        calldata.args[5] !== BigInt(requestNonce)) fail('wrong-l1-request')

    const requestId = keccak256(encodeAbiParameters(ID_TYPES, [
      VERSION, BigInt(L1_CHAIN), BigInt(OP_CHAIN), native.source, opInbox,
      native.parentNode, opRequester, native.node, native.member, BigInt(native.expiry),
      BigInt(requestNonce),
    ]))
    const l1Read = (functionName, args = []) => l1Client.readContract({
      address: native.source, abi: RELAY_ABI, functionName, args, blockNumber: l1Height,
    })
    const [relayDestination, relayMessenger, relayMessengerHash, relayVersion, sent] = await Promise.all([
      l1Read('destinationInbox'), l1Read('l1Messenger'), l1Read('messengerRuntimeHash'),
      l1Read('MESSAGE_VERSION'), l1Read('sentRequest', [requestId]),
    ])
    if (!same(relayDestination, opInbox) || !same(relayMessenger, l1Messenger) ||
        !same(relayMessengerHash, l1MessengerCodeHash) ||
        !same(relayVersion, VERSION) || sent !== true) fail('wrong-l1-relay-identity')
    const messengerCode = await l1Client.getBytecode({ address: l1Messenger, blockNumber: l1Height })
    if (!messengerCode || !same(keccak256(messengerCode), l1MessengerCodeHash)) {
      fail('l1-messenger-codehash-mismatch')
    }
    const l1Receipt = await l1Client.getTransactionReceipt({ hash: native.transactionHash })
    if (l1Receipt?.status !== 'success' || l1Receipt.blockNumber !== l1Height ||
        !same(l1Receipt.blockHash, native.sourceBlock.hash) ||
        !Array.isArray(l1Receipt.logs)) fail('unanchored-l1-result')
    const sourceLogs = l1Receipt.logs.filter(x => same(x.address, native.source) &&
      same(x.topics?.[0], toEventSelector(L1_SENT)))
    if (sourceLogs.length !== 1) fail('missing-l1-result')
    let sourceEvent
    try { sourceEvent = decodeEventLog({ abi: [L1_SENT], ...sourceLogs[0], strict: true }).args }
    catch { fail('invalid-l1-result') }
    if (!same(sourceEvent.requestId, requestId) || !same(sourceEvent.childNode, native.node) ||
        !same(sourceEvent.member, native.member) ||
        BigInt(sourceEvent.sourceBlockNumber) !== l1Height ||
        !same(sourceLogs[0].transactionHash, native.transactionHash) ||
        !same(sourceLogs[0].blockHash, native.sourceBlock.hash) ||
        sourceLogs[0].blockNumber !== l1Height) fail('invalid-l1-result')

    const head = await opClient.getBlock({ blockTag: 'finalized' })
    if (typeof head?.number !== 'bigint' || typeof head.timestamp !== 'bigint' ||
        !HEX32.test(head.hash ?? '') || head.timestamp > BigInt(Math.floor(Date.now() / 1000)) + 120n ||
        head.timestamp + 7200n < BigInt(Math.floor(Date.now() / 1000))) fail('invalid-op-finality')
    const opReceipt = await opClient.getTransactionReceipt({ hash: opTransactionHash })
    if (opReceipt?.status !== 'success' || !same(opReceipt.transactionHash, opTransactionHash) ||
        typeof opReceipt.blockNumber !== 'bigint' || opReceipt.blockNumber > head.number ||
        !HEX32.test(opReceipt.blockHash ?? '') || !Array.isArray(opReceipt.logs)) fail('invalid-op-receipt')
    await blockPinned(opClient, opReceipt.blockNumber, opReceipt.blockHash, opTransactionHash)
    const opTx = await opClient.getTransaction({ hash: opTransactionHash })
    if (!same(opTx?.to, MESSENGER) || opTx.blockNumber !== opReceipt.blockNumber) fail('wrong-op-execution')
    const bytecode = await opClient.getBytecode({ address: opInbox, blockNumber: opReceipt.blockNumber })
    if (!bytecode || !same(keccak256(bytecode), opInboxCodeHash)) fail('op-runtime-mismatch')
    const read = (functionName, args = []) => opClient.readContract({
      address: opInbox, abi: OP_ABI, functionName, args, blockNumber: opReceipt.blockNumber,
    })
    const [parent, emitter, request] = await Promise.all([
      read('parentNode'), read('l1ResultEmitter'), read('requests', [requestId]),
    ])
    if (!same(parent, native.parentNode) || !same(emitter, native.source) ||
        !Array.isArray(request) || request.length !== 7 ||
        !same(request[0], opRequester) || !same(request[1], native.node) ||
        !same(request[2], native.member) || BigInt(request[3]) !== BigInt(native.expiry) ||
        BigInt(request[4]) !== BigInt(requestNonce) || Number(request[5]) !== 3 ||
        BigInt(request[6]) !== l1Height) fail('op-request-mismatch')
    const opLogs = opReceipt.logs.filter(x => same(x.address, opInbox) &&
      same(x.topics?.[0], toEventSelector(OP_OBSERVED)))
    if (opLogs.length !== 1) fail('missing-op-observation')
    let opEvent
    try { opEvent = decodeEventLog({ abi: [OP_OBSERVED], ...opLogs[0], strict: true }).args }
    catch { fail('invalid-op-observation') }
    if (!same(opEvent.requestId, requestId) || !same(opEvent.childNode, native.node) ||
        BigInt(opEvent.sourceBlockNumber) !== l1Height ||
        !same(opLogs[0].blockHash, opReceipt.blockHash) ||
        !same(opLogs[0].transactionHash, opTransactionHash) ||
        opLogs[0].blockNumber !== opReceipt.blockNumber) fail('invalid-op-observation')
    await checkFinalized(l1Client, { number: BigInt(native.finalizedBlock.number),
      hash: native.finalizedBlock.hash }, l1Height, native.sourceBlock.hash)
    await checkFinalized(opClient, head, opReceipt.blockNumber, opReceipt.blockHash)

    return {
      status: 'DUAL_RPC_OBSERVED', requestId, node: native.node,
      l1TransactionHash: native.transactionHash, opTransactionHash,
      sourceBlock: native.sourceBlock, opBlock: {
        number: opReceipt.blockNumber.toString(), hash: opReceipt.blockHash,
      },
      evidenceLevel: 'TWO_FINALIZED_RPC_OBSERVATIONS_ONLY',
      historicalIssuanceObserved: true, opHistoricalResultObserved: true,
      ethereumConsensusIndependentlyVerified: false,
      nativeCurrentAuthorityVerified: false, finalizedL1IssuanceVerifiedOnOP: false,
      opGrantsNativeRights: false, sovereignReceipt: false,
    }
  } catch (error) {
    if (error instanceof CrosschainReconciliationFailure) throw error
    // NativeReceiptFailure.code is a small, controlled reason code (not an
    // upstream RPC body or credential). Preserve its distinct failure class.
    if (error instanceof NativeReceiptFailure) fail(`l1-${error.code}`)
    // Neither external ABI errors nor provider URLs (possibly secret-bearing)
    // should cross this API boundary.
    fail('unverifiable-rpc')
  }
}
