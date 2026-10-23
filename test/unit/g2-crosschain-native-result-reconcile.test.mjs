import { describe, expect, it } from 'vitest'
import {
  encodeAbiParameters, encodeEventTopics, encodeFunctionData, encodePacked,
  keccak256, namehash, parseAbi, parseAbiItem, parseAbiParameters, toHex,
} from 'viem'
import { reconcileNativeIssueResult } from '../../scripts/reconcile-g2-native-result.mjs'

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
  opTransactionHash: opTxHash, opRequester: requester, requestNonce: '1',
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
      return { status: 'success', transactionHash: l1TxHash,
        blockHash: l1Hash, blockNumber: 100n,
        logs: change.l1Logs ?? [nativeChild(), nativeSent()] }
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
          (change.opHeadChanged ?? opHeadHash) : opHeadHash, timestamp: now }
      }
      return { number: arg.blockNumber, hash: change.opBlockHash ?? opHash,
        transactions: [opTxHash] }
    },
    async getTransactionReceipt() {
      return { status: 'success', transactionHash: opTxHash,
        blockHash: opHash, blockNumber: 200n,
        logs: change.opLogs ?? [opObserved()] }
    },
    async getTransaction() {
      return { to: change.opTo ?? messenger, blockNumber: 200n }
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

async function check(config = {}, p = profile()) {
  const { l1, op } = fixture(config)
  return reconcileNativeIssueResult({ l1Client: l1, opClient: op, profile: p })
}

describe('G2 native issuance ↔ OP provisional result finalized-RPC comparison', () => {
  it('correlates same canonical intent, L1 tx and OP observation without granting title', async () => {
    const { l1, op, calls } = fixture()
    const out = await reconcileNativeIssueResult({ l1Client: l1, opClient: op, profile: profile() })
    expect(out).toMatchObject({
      status: 'DUAL_RPC_OBSERVED', requestId, node: childNode,
      sourceBlock: { number: '100', hash: l1Hash },
      opBlock: { number: '200', hash: opHash },
      evidenceLevel: 'TWO_FINALIZED_RPC_OBSERVATIONS_ONLY',
      historicalIssuanceObserved: true, opHistoricalResultObserved: true,
      ethereumConsensusIndependentlyVerified: false, finalizedL1IssuanceVerifiedOnOP: false,
      opGrantsNativeRights: false, sovereignReceipt: false, nativeCurrentAuthorityVerified: false,
    })
    expect(calls.filter(c => c[0] === 'opread').every(c => c[3] === 200n)).toBe(true)
    expect(calls.filter(c => c[0] === 'l1read').every(c => c[3] === 100n)).toBe(true)
  })

  it('executes simultaneous read-only RPC calls, all pinned to each chain source block', async () => {
    const { l1, op } = fixture()
    let l1Concurrent = 0
    let l1Peak = 0
    let opConcurrent = 0
    let opPeak = 0
    const l1Pins = []
    const opPins = []
    const l1Original = l1.readContract
    const opOriginal = op.readContract
    l1.readContract = async args => {
      l1Concurrent++
      l1Peak = Math.max(l1Peak, l1Concurrent)
      l1Pins.push(args.blockNumber)
      await Promise.resolve()
      try { return await l1Original(args) } finally { l1Concurrent-- }
    }
    op.readContract = async args => {
      opConcurrent++
      opPeak = Math.max(opPeak, opConcurrent)
      opPins.push(args.blockNumber)
      await Promise.resolve()
      try { return await opOriginal(args) } finally { opConcurrent-- }
    }
    const out = await reconcileNativeIssueResult({ l1Client: l1, opClient: op, profile: profile() })
    expect(out.status).toBe('DUAL_RPC_OBSERVED')
    expect(l1Peak).toBeGreaterThanOrEqual(3)
    expect(opPeak).toBeGreaterThanOrEqual(3)
    expect(l1Pins.every(n => n === 100n)).toBe(true)
    expect(opPins.every(n => n === 200n)).toBe(true)
  })

  it('rejects a different destination, requester, nonce or transaction input before a positive result', async () => {
    for (const p of [
      { ...profile(), opInbox: member },
      { ...profile(), opRequester: member },
      { ...profile(), requestNonce: '2' },
      { ...profile(), requestNonce: '0' },
      { ...profile(), opTransactionHash: 'bad' },
      { ...profile(), opInboxCodeHash: '0x123' },
      { ...profile(), l1MessengerCodeHash: 'bad' },
    ]) await expect(check({}, p)).rejects.toBeTruthy()
    await expect(check({ l1To: member })).rejects.toMatchObject({ code: 'wrong-l1-entrypoint' })
    await expect(check({ l1Input: '0x1234' })).rejects.toMatchObject({ code: 'wrong-l1-entrypoint' })
  })

  it('refuses forged L1 result event, missing original event or mismatched source block', async () => {
    for (const logs of [
      [nativeChild()], [nativeChild(), nativeSent(), nativeSent()],
      [nativeChild(), { ...nativeSent(), address: member }],
      [nativeChild(), { ...nativeSent(), data: encodeAbiParameters(
        parseAbiParameters('uint64'), [101n]) }],
      [nativeChild(), { ...nativeSent(), topics: encodeEventTopics({
        abi: [SENT], eventName: 'NativeIssueResultSent',
        args: { requestId: `0x${'ff'.repeat(32)}`, childNode, member },
      }) }],
    ]) await expect(check({ l1Logs: logs })).rejects.toBeTruthy()
  })

  it('requires pinned L1 relay destination, messenger code and committed request state', async () => {
    for (const config of [
      { l1Destination: member }, { l1Messenger: member },
      { l1Version: l1Hash }, { sentRequest: false },
      { messengerCode: '0x6000' },
    ]) await expect(check(config)).rejects.toBeTruthy()
  })

  it('rejects OP receipt, observed event or historical queue state mismatches', async () => {
    for (const config of [
      { opLogs: [] },
      { opLogs: [opObserved(), opObserved()] },
      { opLogs: [{ ...opObserved(), address: member }] },
      { opLogs: [{ ...opObserved(), blockHash: l1Hash }] },
      { opLogs: [{ ...opObserved(), data: encodeAbiParameters(
        parseAbiParameters('uint64'), [99n]) }] },
      { opRequest: [requester, childNode, member, BigInt(expiry), 1n, 1, 100n] },
      { opRequest: [requester, childNode, member, BigInt(expiry), 1n, 3, 99n] },
      { opEmitter: member }, { opCode: sourceCode }, { opTo: inbox },
    ]) await expect(check(config)).rejects.toBeTruthy()
  })

  it('rejects wrong chains, reorged finalized block hashes or unfinalized OP results', async () => {
    for (const config of [
      { l1Chain: 1 }, { opChain: 10 },
      { l1Head: 99n }, { opHead: 199n },
      { l1BlockHash: opHash }, { opBlockHash: l1Hash },
      { l1HeadChanged: opHash }, { opHeadChanged: l1Hash },
    ]) await expect(check(config)).rejects.toBeTruthy()
  })
})
