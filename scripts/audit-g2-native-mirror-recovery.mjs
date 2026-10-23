/** Read-only L1 result / OP provisional mirror diagnosis. No replay authorization. */
import {
  decodeEventLog, decodeFunctionData, encodeAbiParameters, isAddress,
  keccak256, parseAbi, parseAbiItem, parseAbiParameters, toEventSelector, toHex,
} from 'viem'
import { observeNativeIssueReceipt, NativeReceiptFailure } from './observe-g2-native-issuance-receipt.mjs'

const L1 = 11155111
const OP = 11155420
const VERSION = keccak256(toHex('COMETENS_G2_NATIVE_RESULT_V1'))
const HASH = /^0x[0-9a-fA-F]{64}$/
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const MESSENGER = '0x4200000000000000000000000000000000000007'
const ZERO = '0x0000000000000000000000000000000000000000'
const ENTRY = parseAbi(['function issueAndRelay(string label,address member,address resolver,uint64 expiry,address opRequester,uint256 requestNonce,uint32 minGasLimit) returns (bytes32)'])
const SENT = parseAbiItem('event NativeIssueResultSent(bytes32 indexed requestId,bytes32 indexed childNode,address indexed member,uint64 sourceBlockNumber)')
const SOURCE = parseAbi([
  'function destinationInbox() view returns (address)',
  'function l1Messenger() view returns (address)',
  'function messengerRuntimeHash() view returns (bytes32)',
  'function MESSAGE_VERSION() view returns (bytes32)',
  'function sentRequest(bytes32) view returns (bool)',
])
const INBOX = parseAbi([
  'function parentNode() view returns (bytes32)',
  'function l1ResultEmitter() view returns (address)',
  'function requests(bytes32) view returns (address,bytes32,address,uint64,uint256,uint8,uint64)',
])
const ID = parseAbiParameters('bytes32,uint256,uint256,address,address,bytes32,address,bytes32,address,uint64,uint256')
const same = (x, y) => typeof x === 'string' && typeof y === 'string' && x.toLowerCase() === y.toLowerCase()
const codehash = (x) => HASH.test(x ?? '') && !/^0x0+$/i.test(x)
export class MirrorRecoveryFailure extends Error {
  constructor(code) { super(`G2 native mirror recovery audit: ${code}`); this.code = code }
}
const fail = (code) => { throw new MirrorRecoveryFailure(code) }

function validate(raw) {
  const l1 = ['chainId','issuer','issuerCodeHash','registryCodeHash','wrapperCodeHash','parentName',
    'childLabel','member','expiry','transactionHash']
  const extra = ['opInbox','opInboxCodeHash','opRequester','requestNonce','l1Messenger','l1MessengerCodeHash']
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      Object.keys(raw).sort().join(',') !== [...l1,...extra].sort().join(',') ||
      Object.values(Object.getOwnPropertyDescriptors(raw)).some(d => !Object.hasOwn(d,'value'))) fail('invalid-profile')
  const p = Object.fromEntries([...l1,...extra].map(k => [k,raw[k]]))
  if (p.chainId !== L1 || ![p.issuer,p.member,p.opInbox,p.opRequester,p.l1Messenger].every(x =>
      ADDRESS.test(x ?? '') && !same(x,ZERO)) ||
      ![p.issuerCodeHash,p.registryCodeHash,p.wrapperCodeHash,p.opInboxCodeHash,p.l1MessengerCodeHash].every(codehash) ||
      !HASH.test(p.transactionHash ?? '') ||
      typeof p.requestNonce !== 'string' || !/^[1-9][0-9]{0,77}$/.test(p.requestNonce) ||
      BigInt(p.requestNonce) > (1n << 256n) - 1n) fail('invalid-profile')
  return { profile: p, l1Profile: Object.fromEntries(l1.map(k => [k,p[k]])) }
}

const header = async (client, chain, now) => {
  if (await client.getChainId() !== chain) fail('wrong-chain')
  const h = await client.getBlock({ blockTag:'finalized' })
  if (typeof h?.number !== 'bigint' || typeof h?.timestamp !== 'bigint' || !HASH.test(h.hash ?? '') ||
      h.timestamp > now + 120n || h.timestamp + 7200n < now) fail('invalid-finalized-head')
  return h
}
const consistent = async (client, chain, first, sourceHeight, sourceHash, now) => {
  const second = await header(client, chain, now)
  if (second.number < first.number || second.number < sourceHeight ||
      (second.number === first.number && !same(second.hash,first.hash)) ||
      (second.number === sourceHeight && !same(second.hash,sourceHash))) fail('finality-drift')
  const historic = await client.getBlock({ blockNumber:sourceHeight })
  if (historic?.number !== sourceHeight || !same(historic.hash,sourceHash)) fail('source-reorg')
}

/** This can identify an OP synchronization gap, never prove retry eligibility. */
export async function auditNativeMirrorRecovery({ l1Client, opClient, profile, now = () => BigInt(Math.floor(Date.now()/1000)) }) {
  const { profile:p, l1Profile } = validate(profile)
  if (!l1Client || !opClient || l1Client === opClient) fail('invalid-clients')
  const at = now()
  if (typeof at !== 'bigint' || at <= 0n) fail('invalid-clock')
  try {
    const [l1Head, opHead] = await Promise.all([header(l1Client,L1,at),header(opClient,OP,at)])
    // Existing reviewed L1 observer pins actual native issuance receipt, ENSv1
    // runtime, holder, fuses, child expiry and finalized block hashes.
    const native = await observeNativeIssueReceipt({client:l1Client,profile:l1Profile})
    const l1Height = BigInt(native.sourceBlock.number)
    if (l1Height > l1Head.number ||
        (l1Height === l1Head.number && !same(l1Head.hash,native.sourceBlock.hash))) fail('l1-finality-mismatch')
    const tx = await l1Client.getTransaction({hash:p.transactionHash})
    if (!same(tx?.to,p.issuer) || tx.blockNumber !== l1Height || typeof tx.input !== 'string') fail('wrong-l1-entrypoint')
    let decoded
    try { decoded = decodeFunctionData({abi:ENTRY,data:tx.input}) } catch { fail('wrong-l1-entrypoint') }
    if (decoded.functionName !== 'issueAndRelay' || decoded.args[0] !== p.childLabel ||
        !same(decoded.args[1],p.member) || BigInt(decoded.args[3]) !== BigInt(p.expiry) ||
        !same(decoded.args[4],p.opRequester) || decoded.args[5] !== BigInt(p.requestNonce)) fail('wrong-l1-request')
    const requestId = keccak256(encodeAbiParameters(ID,[VERSION,BigInt(L1),BigInt(OP),p.issuer,
      p.opInbox,native.parentNode,p.opRequester,native.node,p.member,BigInt(p.expiry),BigInt(p.requestNonce)]))
    const l1Read = (functionName,args=[]) => l1Client.readContract({address:p.issuer,abi:SOURCE,functionName,args,blockNumber:l1Height})
    const [inbox,messenger,messengerHash,version,sent] = await Promise.all([
      l1Read('destinationInbox'),l1Read('l1Messenger'),l1Read('messengerRuntimeHash'),
      l1Read('MESSAGE_VERSION'),l1Read('sentRequest',[requestId]),
    ])
    if (!same(inbox,p.opInbox) || !same(messenger,p.l1Messenger) ||
        !same(messengerHash,p.l1MessengerCodeHash) || !same(version,VERSION) || sent !== true) fail('wrong-relay-identity')
    const messengerCode = await l1Client.getBytecode({address:p.l1Messenger,blockNumber:l1Height})
    if (!messengerCode || !same(keccak256(messengerCode),p.l1MessengerCodeHash)) fail('l1-messenger-codehash')
    const receipt = await l1Client.getTransactionReceipt({hash:p.transactionHash})
    if (receipt?.status !== 'success' || receipt.blockNumber !== l1Height ||
        !same(receipt.blockHash,native.sourceBlock.hash) || !Array.isArray(receipt.logs)) fail('l1-receipt-mismatch')
    const events = receipt.logs.filter(x => same(x.address,p.issuer) && same(x.topics?.[0],toEventSelector(SENT)))
    if (events.length !== 1) fail('missing-or-duplicate-l1-result')
    let event
    try { event = decodeEventLog({abi:[SENT],...events[0],strict:true}).args } catch { fail('bad-l1-result-event') }
    if (!same(event.requestId,requestId) || !same(event.childNode,native.node) ||
        !same(event.member,p.member) || event.sourceBlockNumber !== l1Height ||
        !same(events[0].blockHash,receipt.blockHash) || !same(events[0].transactionHash,p.transactionHash) ||
        events[0].blockNumber !== l1Height || events[0].removed === true) fail('bad-l1-result-event')

    const opCode = await opClient.getBytecode({address:p.opInbox,blockNumber:opHead.number})
    if (!opCode || !same(keccak256(opCode),p.opInboxCodeHash)) fail('op-inbox-codehash')
    const opRead = (functionName,args=[]) => opClient.readContract({address:p.opInbox,abi:INBOX,functionName,args,blockNumber:opHead.number})
    const [opParent,emitter,r] = await Promise.all([
      opRead('parentNode'),opRead('l1ResultEmitter'),opRead('requests',[requestId]),
    ])
    if (!same(opParent,native.parentNode) || !same(emitter,p.issuer) || !Array.isArray(r) || r.length !== 7) fail('op-identity-mismatch')
    const status = Number(r[5])
    if (![0,1,2,3].includes(status)) fail('invalid-op-status')
    const zero = same(r[0],ZERO) && same(r[1],`0x${'0'.repeat(64)}`) && same(r[2],ZERO) &&
      BigInt(r[3]) === 0n && BigInt(r[4]) === 0n && BigInt(r[6]) === 0n
    if (status === 0 ? !zero : !same(r[0],p.opRequester) || !same(r[1],native.node) ||
        !same(r[2],p.member) || BigInt(r[3]) !== BigInt(p.expiry) ||
        BigInt(r[4]) !== BigInt(p.requestNonce) ||
        (status === 3 ? BigInt(r[6]) !== l1Height : BigInt(r[6]) !== 0n)) fail('op-request-mismatch')
    await Promise.all([
      consistent(l1Client,L1,l1Head,l1Height,native.sourceBlock.hash,at),
      consistent(opClient,OP,opHead,opHead.number,opHead.hash,at),
    ])
    const expiredAtSample = BigInt(p.expiry) <= opHead.timestamp
    const recoveryStatus = status === 0 ? 'OP_REQUEST_NOT_QUEUED' : status === 2 ? 'OP_CANCELLED' :
      status === 3 ? 'OP_PROVISIONALLY_OBSERVED' : expiredAtSample ? 'OP_PENDING_NATIVE_EXPIRED' : 'OP_PENDING_DELIVERY_UNKNOWN'
    return { recoveryStatus, requestId, opRequestStatus:status,
      l1SourceBlock:{number:l1Height.toString(),hash:native.sourceBlock.hash},
      opSnapshot:{number:opHead.number.toString(),hash:opHead.hash},
      nativeExpiryAtOpSnapshot:expiredAtSample, mirrorReadOnly:true, automaticReplayAuthorized:false,
      failedMessengerDeliveryProven:false, nativeRollbackProven:false, opGrantsNativeRights:false,
      sourceFinalityIndependentlyVerified:false, opFinalityIndependentlyVerified:false,
      currentNativeAuthorityVerified:false, sovereignReceipt:false,
      nextAction:'CHECK_MESSENGER_AND_REQUEST_STATE_INDEPENDENTLY_NO_AUTOMATIC_REPLAY',
      caveat:'Historical single-provider L1/OP RPC snapshots; OP OBSERVED is provisional, cancellation/expiry never undo native issuance.',
    }
  } catch (error) {
    if (error instanceof MirrorRecoveryFailure) throw error
    if (error instanceof NativeReceiptFailure) fail(`l1-${error.code}`)
    fail('unverifiable-rpc')
  }
}
