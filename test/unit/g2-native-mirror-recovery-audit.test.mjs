import {describe,expect,it,vi} from 'vitest'
import {encodeAbiParameters,encodeEventTopics,encodeFunctionData,encodePacked,keccak256,namehash,parseAbi,parseAbiItem,parseAbiParameters,toHex} from 'viem'
import {auditNativeMirrorRecovery} from '../../scripts/audit-g2-native-mirror-recovery.mjs'

const source = '0x1111111111111111111111111111111111111111'
const inbox = '0x2222222222222222222222222222222222222222'
const requester = '0x3333333333333333333333333333333333333333'
const member = '0x4444444444444444444444444444444444444444'
const resolver = '0x5555555555555555555555555555555555555555'
const l1Messenger = '0x6666666666666666666666666666666666666666'
const registry = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e'
const wrapper = '0x0635513f179D50A207757E05759CbD106d7dFcE8'
const messenger = '0x4200000000000000000000000000000000000007'
const sourceCode = '0x6001600055'
const registryCode = '0x6002600055'
const wrapperCode = '0x6003600055'
const inboxCode = '0x6004600055'
const messengerCode = '0x6005600055'
const l1TxHash = `0x${'ab'.repeat(32)}`
const opTxHash = `0x${'cd'.repeat(32)}`
const l1Hash = `0x${'12'.repeat(32)}`
const opHash = `0x${'34'.repeat(32)}`
const l1HeadHash = `0x${'56'.repeat(32)}`
const opHeadHash = `0x${'78'.repeat(32)}`
const parentNode = namehash('community.eth')
const childNode = keccak256(encodePacked(['bytes32', 'bytes32'], [
  parentNode, keccak256(toHex('alice')),
]))
const expiry = '2000000000'
const VERSION = keccak256(toHex('COMETENS_G2_NATIVE_RESULT_V1'))
const ABI = parseAbi([
  'function issueAndRelay(string label,address member,address resolver,uint64 expiry,address opRequester,uint256 requestNonce,uint32 minGasLimit) returns (bytes32)',
])
const CHILD = parseAbiItem(
  'event NativeChildIssued(bytes32 indexed node,address indexed member,uint64 expiry)',
)
const SENT = parseAbiItem(
  'event NativeIssueResultSent(bytes32 indexed requestId,bytes32 indexed childNode,address indexed member,uint64 sourceBlockNumber)',
)
const OBSERVED = parseAbiItem(
  'event NativeResultObserved(bytes32 indexed requestId,bytes32 indexed childNode,uint64 sourceBlockNumber)',
)
const requestId = keccak256(encodeAbiParameters(parseAbiParameters(
  'bytes32,uint256,uint256,address,address,bytes32,address,bytes32,address,uint64,uint256',
), [VERSION, 11155111n, 11155420n, source, inbox, parentNode,
  requester, childNode, member, BigInt(expiry), 1n]))

const profile = () => ({
  chainId: 11155111, issuer: source, issuerCodeHash: keccak256(sourceCode),
  registryCodeHash: keccak256(registryCode), wrapperCodeHash: keccak256(wrapperCode),
  parentName: 'community.eth', childLabel: 'alice', member, expiry, transactionHash: l1TxHash,
  opInbox: inbox, opInboxCodeHash: keccak256(inboxCode),
  opRequester: requester, requestNonce: '1',
  l1Messenger, l1MessengerCodeHash: keccak256(messengerCode),
})
const log = (abi, args, eventData, chain) => ({
  address: chain === 'op' ? inbox : source,
  topics: encodeEventTopics({ abi: [abi], eventName: abi.name, args }),
  data: encodeAbiParameters(parseAbiParameters('uint64'), [BigInt(eventData)]),
  blockHash: chain === 'op' ? opHash : l1Hash,
  blockNumber: chain === 'op' ? 200n : 100n,
  transactionHash: chain === 'op' ? opTxHash : l1TxHash,
  logIndex: chain === 'op' ? 0 : abi.name === 'NativeChildIssued' ? 0 : 1,
  removed: false,
})
const nativeChild = () => log(CHILD, { node: childNode, member }, expiry, 'l1')
const nativeSent = () => log(SENT, { requestId, childNode, member }, 100n, 'l1')
const opObserved = () => log(OBSERVED, { requestId, childNode }, 100n, 'op')
const l1Input = () => encodeFunctionData({ abi: ABI, functionName: 'issueAndRelay',
  args: ['alice', member, resolver, BigInt(expiry), requester, 1n, 300000] })

function fixture(change = {}) {
  const calls = []
  let l1Heads = 0
  let l1ReceiptReads = 0
  let opHeads = 0
  const now = BigInt(Math.floor(Date.now() / 1000) - 60)
  const l1 = {
    async getChainId() { return change.l1Chain ?? 11155111 },
    async getBlock(arg) {
      calls.push(['l1block', arg])
      if (arg.blockTag === 'finalized') {
        l1Heads++
        return { number: change.l1Head ?? 110n, hash: l1Heads > 2 ?
          (change.l1HeadChanged ?? l1HeadHash) : l1HeadHash, timestamp: now }
      }
      return { number: arg.blockNumber, hash: change.l1BlockHash ?? l1Hash,
        transactions: [l1TxHash] }
    },
    async getTransactionReceipt() {
      l1ReceiptReads++
      return { status: 'success', transactionHash: l1TxHash,
        blockHash: l1ReceiptReads > 1 ? (change.l1SecondReceiptHash ?? l1Hash) : l1Hash,
        blockNumber: 100n, logs: l1ReceiptReads > 1 ?
          (change.l1SecondReceiptLogs ?? change.l1Logs ?? [nativeChild(), nativeSent()]) :
          (change.l1Logs ?? [nativeChild(), nativeSent()]) }
    },
    async getTransaction() { return { to: change.l1To ?? source,
      blockNumber: 100n, input: change.l1Input ?? l1Input() } },
    async getBytecode({ address, blockNumber }) {
      calls.push(['l1code', address, blockNumber])
      return address === source ? sourceCode : address === registry ? registryCode :
        address === l1Messenger ? (change.messengerCode ?? messengerCode) : wrapperCode
    },
    async readContract({ address, functionName, args, blockNumber }) {
      calls.push(['l1read', address, functionName, blockNumber])
      if (address === source) {
        if (functionName === 'parentNode') return parentNode
        if (functionName === 'ENS_REGISTRY') return registry
        if (functionName === 'NAME_WRAPPER') return wrapper
        if (functionName === 'destinationInbox') return change.l1Destination ?? inbox
        if (functionName === 'l1Messenger') return change.l1Messenger ?? l1Messenger
        if (functionName === 'messengerRuntimeHash') return keccak256(messengerCode)
        if (functionName === 'MESSAGE_VERSION') return change.l1Version ?? VERSION
        if (functionName === 'sentRequest') return change.sentRequest ?? true
      }
      if (address === registry) return wrapper
      if (address === wrapper) {
        if (functionName === 'ownerOf') return member
        return [member, 65537, BigInt(expiry)]
      }
      throw Error('unexpected L1 read')
    },
  }
  const op = {
    async getChainId() { return change.opChain ?? 11155420 },
    async getBlock(arg) {
      calls.push(['opblock', arg])
      if (arg.blockTag === 'finalized') {
        opHeads++
        return { number: change.opHead ?? 210n, hash: opHeads > 1 ?
          (change.opHeadChanged ?? opHeadHash) : opHeadHash,
        timestamp: change.opHeadTimestamp ?? now }
      }
      return { number: change.opNumberedBlockNumber ?? arg.blockNumber,
        hash: change.opBlockHash ?? (arg.blockNumber === (change.opHead ?? 210n) ? opHeadHash : opHash),
        transactions: change.opNumberedTransactions ?? [opTxHash] }
    },
    async getTransactionReceipt() {
      return { status: 'success', transactionHash: opTxHash,
        blockHash: opHash, blockNumber: 200n,
        logs: change.opLogs ?? [opObserved()] }
    },
    async getTransaction() {
      return { to: change.opTo ?? messenger,
        blockNumber: change.opTxBlockNumber ?? 200n }
    },
    async getBytecode({ address, blockNumber }) {
      calls.push(['opcode', address, blockNumber])
      return change.opCode ?? inboxCode
    },
    async readContract({ address, functionName, blockNumber }) {
      calls.push(['opread', address, functionName, blockNumber])
      if (functionName === 'parentNode') return parentNode
      if (functionName === 'l1ResultEmitter') return change.opEmitter ?? source
      if (functionName === 'requests') return change.opRequest ?? [
        requester, childNode, member, BigInt(expiry), 1n, 3, 100n,
      ]
      throw Error('unexpected OP read')
    },
  }
  return { l1, op, calls }
}

const query = async (change = {}, p = profile()) => {
  const {l1,op,calls} = fixture(change)
  return {result:await auditNativeMirrorRecovery({l1Client:l1,opClient:op,profile:p}),calls}
}
const pending = (status,sourceBlock = 0n) => [requester,childNode,member,BigInt(expiry),1n,status,sourceBlock]

describe('G2.4 recovery liveness is never L1 title or automatic messenger replay authority', () => {
  it('distinguishes provisional observed and pending without treating either as sovereign', async () => {
    for (const [status,expected] of [
      [1,'OP_PENDING_DELIVERY_UNKNOWN'],[2,'OP_CANCELLED'],[3,'OP_PROVISIONALLY_OBSERVED'],
    ]) {
      const {result,calls} = await query({opRequest:pending(status,status===3 ? 100n : 0n)})
      expect(result).toMatchObject({recoveryStatus:expected,requestId,sourceFinalityIndependentlyVerified:false,
        opGrantsNativeRights:false,sovereignReceipt:false,automaticReplayAuthorized:false,
        failedMessengerDeliveryProven:false,nativeRollbackProven:false})
      expect(calls.filter(x=>x[0]==='opread').every(x=>x[3]===210n)).toBe(true)
      expect(calls.filter(x=>x[0]==='l1read').every(x=>x[3]===100n)).toBe(true)
    }
  })
  it('unmatched OP queue returns missing-queue diagnosis, NOT a claim of native rollback',async()=>{
    const {result}=await query({opRequest:[
      '0x0000000000000000000000000000000000000000',toHex(0n,{size:32}),
      '0x0000000000000000000000000000000000000000',0n,0n,0,0n,
    ]})
    expect(result.recoveryStatus).toBe('OP_REQUEST_NOT_QUEUED')
    expect(result.nativeRollbackProven).toBe(false)
    expect(result.automaticReplayAuthorized).toBe(false)
  })
  it('late delivery after native expiry is HISTORICAL only, even when OP marks OBSERVED',async()=>{
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2034-01-01T00:00:00Z'))
      const a=await query({opRequest:pending(1)})
      expect(a.result.recoveryStatus).toBe('OP_PENDING_NATIVE_EXPIRED')
      expect(a.result.nativeExpiryAtOpSnapshot).toBe(true)
      const b=await query({opRequest:pending(3,100n)})
      expect(b.result.recoveryStatus).toBe('OP_PROVISIONALLY_OBSERVED')
      expect(b.result.nativeExpiryAtOpSnapshot).toBe(true)
      expect(b.result.currentNativeAuthorityVerified).toBe(false)
    } finally {vi.useRealTimers()}
  })
  it('rejects unanchored/corrupted L1 result or relay receipt instead of guessing failed delivery',async()=>{
    for(const [change,code] of [
      [{l1Logs:[nativeChild()]},'missing-or-duplicate-l1-result'],
      [{l1Logs:[nativeChild(),nativeSent(),nativeSent()]},'missing-or-duplicate-l1-result'],
      [{l1To:member},'wrong-l1-entrypoint'],
      [{l1Input:'0x1234'},'wrong-l1-entrypoint'],
      [{l1Input:encodeFunctionData({abi:ABI,functionName:'issueAndRelay',
        args:['alice',member,resolver,BigInt(expiry),member,1n,300000]})},'wrong-l1-request'],
      [{l1Logs:[nativeChild(),{...nativeSent(),topics:encodeEventTopics({abi:[SENT],
        eventName:'NativeIssueResultSent',args:{requestId:l1Hash,childNode,member}})}]},'bad-l1-result-event'],
      [{l1Destination:member},'wrong-relay-identity'],
      [{sentRequest:false},'wrong-relay-identity'],
      [{messengerCode:'0x1234'},'l1-messenger-codehash'],
      [{l1SecondReceiptHash:opHash},'l1-receipt-mismatch'],
    ]) {
      const {l1,op}=fixture(change)
      await expect(auditNativeMirrorRecovery({l1Client:l1,opClient:op,profile:profile()}))
        .rejects.toMatchObject({code})
    }
  })
  it('protects OP inbox codehash, queued request identity, source epoch and idempotent OBSERVED status',async()=>{
    for(const [change,code] of [
      [{opCode:'0x1234'},'op-inbox-codehash'],
      [{opEmitter:member},'op-identity-mismatch'],
      [{opRequest:[requester,childNode,member,BigInt(expiry),2n,1,0n]},'op-request-mismatch'],
      [{opRequest:[requester,childNode,member,BigInt(expiry),1n,3,99n]},'op-request-mismatch'],
      [{opRequest:[requester,childNode,member,BigInt(expiry),1n,1,100n]},'op-request-mismatch'],
      [{opRequest:[requester,childNode,member,BigInt(expiry),1n,4,0n]},'invalid-op-status'],
    ]) {
      const {l1,op}=fixture(change)
      await expect(auditNativeMirrorRecovery({l1Client:l1,opClient:op,profile:profile()}))
        .rejects.toMatchObject({code})
    }
  })
  it('rejects wrong chains, RPC reorg, finalized drift and unpinned OP request reads',async()=>{
    for(const [change,code] of [
      [{opChain:1},'wrong-chain'],
      [{l1Chain:1},'wrong-chain'],
      [{l1BlockHash:opHash},'l1-unanchored-transaction'],
      [{l1HeadChanged:opHash},'l1-finality-changed'],
      [{opHeadChanged:opHash},'finality-drift'],
      [{opBlockHash:opHash},'source-reorg'],
    ]) {
      const {l1,op}=fixture(change)
      await expect(auditNativeMirrorRecovery({l1Client:l1,opClient:op,profile:profile()}))
        .rejects.toMatchObject({code})
    }
    const {l1,op,calls}=fixture({opRequest:pending(1)})
    await auditNativeMirrorRecovery({l1Client:l1,opClient:op,profile:profile()})
    expect(calls.filter(c=>c[0]==='opcode').map(c=>c[2])).toEqual([210n])
    expect(calls.filter(c=>c[0]==='opread').map(c=>c[3])).toEqual([210n,210n,210n])
  })
  it('rejects finalized L1 same-height reorg only after native observer has already passed', async()=>{
    const {l1,op}=fixture()
    const original=l1.getBlock
    let finalizedCalls=0
    l1.getBlock=async options=>{
      const got=await original(options)
      if(options.blockTag==='finalized' && ++finalizedCalls >= 4) return {...got,hash:opHash}
      return got
    }
    await expect(auditNativeMirrorRecovery({l1Client:l1,opClient:op,profile:profile()}))
      .rejects.toMatchObject({code:'finality-drift'})
  })
  it('fails closed on bad profile and unproven source transaction (not safe to replay)',async()=>{
    for(const alteration of [{requestNonce:'0'},{opInboxCodeHash:'bad'},{opRequester:member},
      {opInbox:member},{l1MessengerCodeHash:toHex(0n,{size:32})}]) {
      const {l1,op}=fixture()
      await expect(auditNativeMirrorRecovery({l1Client:l1,opClient:op,profile:{...profile(),...alteration}}))
        .rejects.toBeInstanceOf(Error)
    }
    const {l1,op}=fixture({l1Logs:[nativeSent()]})
    await expect(auditNativeMirrorRecovery({l1Client:l1,opClient:op,profile:profile()}))
      .rejects.toMatchObject({code:'l1-missing-or-duplicate-issuance-event'})
  })
})
