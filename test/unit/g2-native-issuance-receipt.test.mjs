import { describe, expect, it } from 'vitest'
import {
  encodeAbiParameters, encodeEventTopics, encodePacked, keccak256, namehash,
  parseAbiItem, parseAbiParameters, toHex,
} from 'viem'
import {
  observeNativeIssueReceipt, NativeReceiptFailure,
} from '../../scripts/observe-g2-native-issuance-receipt.mjs'

const ISSUER = '0x1111111111111111111111111111111111111111'
const MEMBER = '0x2222222222222222222222222222222222222222'
const REGISTRY = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e'
const WRAPPER = '0x0635513f179D50A207757E05759CbD106d7dFcE8'
const ZERO = '0x0000000000000000000000000000000000000000'
const TX = `0x${'34'.repeat(32)}`
const BLOCK_HASH = `0x${'56'.repeat(32)}`
const HEAD_HASH = `0x${'78'.repeat(32)}`
const SOURCE_CODE = '0x6001600055'
const REGISTRY_CODE = '0x6002600055'
const WRAPPER_CODE = '0x6003600055'
const expiry = String(Math.floor(Date.now() / 1000) + 3600)
const parentNode = namehash('community.eth')
const childNode = keccak256(encodePacked([
  'bytes32', 'bytes32',
], [parentNode, keccak256(toHex('alice'))]))
const EVENT = parseAbiItem('event NativeChildIssued(bytes32 indexed node, address indexed member, uint64 expiry)')
const profile = () => ({
  chainId: 11155111, issuer: ISSUER, issuerCodeHash: keccak256(SOURCE_CODE),
  registryCodeHash: keccak256(REGISTRY_CODE), wrapperCodeHash: keccak256(WRAPPER_CODE),
  parentName: 'community.eth', childLabel: 'alice',
  member: MEMBER, expiry, transactionHash: TX,
})
function encodedLog(options = {}) {
  return {
    address: options.logAddress ?? ISSUER,
    topics: encodeEventTopics({
      abi: [EVENT], eventName: 'NativeChildIssued',
      args: { node: options.node ?? childNode, member: options.member ?? MEMBER },
    }),
    data: encodeAbiParameters(parseAbiParameters('uint64'), [BigInt(options.expiry ?? expiry)]),
    transactionHash: options.tx ?? TX, blockHash: options.blockHash ?? BLOCK_HASH,
    blockNumber: 100n, logIndex: options.logIndex ?? 1, removed: options.removed ?? false,
  }
}
function fake(options = {}) {
  const calls = []
  let headReads = 0
  const client = {
    async getChainId() { calls.push(['chain']); return options.chain ?? 11155111 },
    async getBlock(arg) {
      calls.push(['block', arg])
      if (arg.blockTag === 'finalized') {
        headReads++
        return { number: options.finalizedHeight ?? 110n,
          hash: headReads > 1 ? (options.secondHeadHash ?? HEAD_HASH) : HEAD_HASH,
          timestamp: options.oldFinality ? 1n : BigInt(Math.floor(Date.now() / 1000) - 60) }
      }
      expect(arg).toEqual({ blockNumber: 100n })
      return { number: 100n, hash: options.canonicalHash ?? BLOCK_HASH,
        transactions: options.missingTx ? [`0x${'aa'.repeat(32)}`] : [TX] }
    },
    async getTransactionReceipt({ hash }) {
      expect(hash).toBe(TX)
      calls.push(['receipt'])
      return {
        status: options.status ?? 'success', transactionHash: options.receiptTx ?? TX,
        blockNumber: 100n, blockHash: BLOCK_HASH,
        logs: options.logs ?? [encodedLog()],
      }
    },
    async getBytecode({ address, blockNumber }) {
      expect(blockNumber).toBe(100n)
      calls.push(['code', address])
      if (options.rpcError) throw new Error('https://secrets.example?apiKey=SECRET_PRIVATE_TOKEN')
      if (options.badCode === address) return '0x6000'
      return address === ISSUER ? SOURCE_CODE : address === REGISTRY ? REGISTRY_CODE : WRAPPER_CODE
    },
    async readContract({ address, functionName, args, blockNumber }) {
      expect(blockNumber).toBe(100n)
      calls.push(['read', address, functionName])
      if (options.rpcError) throw new Error('https://secrets.example?apiKey=SECRET_PRIVATE_TOKEN')
      if (address === ISSUER) {
        if (functionName === 'parentNode') return options.sourceParent ?? parentNode
        if (functionName === 'ENS_REGISTRY') return options.sourceRegistry ?? REGISTRY
        if (functionName === 'NAME_WRAPPER') return options.sourceWrapper ?? WRAPPER
      }
      if (address === REGISTRY) {
        expect(functionName).toBe('owner')
        expect(args).toEqual([childNode])
        return options.registryOwner ?? WRAPPER
      }
      if (address === WRAPPER) {
        expect(args).toEqual([BigInt(childNode)])
        if (functionName === 'ownerOf') return options.tokenOwner ?? MEMBER
        return [options.childOwner ?? MEMBER,
          options.childFuses ?? 65537,
          BigInt(options.childExpiry ?? expiry)]
      }
      throw new Error('unexpected read')
    },
  }
  return { client, calls }
}

describe('G2 L1 native issuer finalized-RPC receipt observation (read only)', () => {
  it('observes one real-format event, issuer identities and historical native child state', async () => {
    const { client, calls } = fake()
    const result = await observeNativeIssueReceipt({ client, profile: profile() })
    expect(result).toMatchObject({
      mode: 'LEGACY_ENSV1_ISSUE_RPC_OBSERVATION_ONLY', chainId: 11155111,
      source: ISSUER, parentNode, node: childNode, member: MEMBER,
      sourceBlock: { number: '100', hash: BLOCK_HASH, logIndex: 1 },
      finalizedBlock: { number: '110', hash: HEAD_HASH },
      historicalIssuanceObserved: true, evidenceLevel: 'FINALIZED_RPC_OBSERVATION_ONLY',
      requestNonceVerified: false, opMirrorVerified: false,
      nativeCurrentAuthorityVerified: false, sovereignReceipt: false, enablesNativeIssuance: false,
    })
    expect(calls.filter(x => x[0] === 'code')).toHaveLength(3)
    expect(calls.filter(x => x[0] === 'read')).toHaveLength(6)
    expect(calls.filter(x => x[0] === 'block' && x[1].blockTag === 'finalized')).toHaveLength(2)
    expect(calls.some(x => /send|write|sign/i.test(x[0]))).toBe(false)
  })

  it('rejects incorrect or duplicated NativeChildIssued events and bad receipt status', async () => {
    for (const options of [
      { logs: [] }, { logs: [encodedLog(), encodedLog({ logIndex: 2 })] },
      { logs: [encodedLog({ member: ISSUER })] },
      { logs: [encodedLog({ expiry: BigInt(expiry) - 1n })] },
      { logs: [encodedLog({ node: HEAD_HASH })] },
      { logs: [encodedLog({ removed: true })] },
      { logs: [encodedLog({ tx: HEAD_HASH })] },
      { status: 'reverted' },
    ]) await expect(observeNativeIssueReceipt({
      client: fake(options).client, profile: profile(),
    })).rejects.toBeInstanceOf(NativeReceiptFailure)
  })

  it('rejects wrong L1 chain, missing canonical transaction, changed finalized head and stale RPC', async () => {
    for (const options of [
      { chain: 1 }, { finalizedHeight: 99n }, { missingTx: true },
      { canonicalHash: HEAD_HASH }, { secondHeadHash: BLOCK_HASH }, { oldFinality: true },
      { receiptTx: HEAD_HASH },
    ]) await expect(observeNativeIssueReceipt({
      client: fake(options).client, profile: profile(),
    })).rejects.toBeInstanceOf(NativeReceiptFailure)
  })

  it('pins issuer/registry/wrapper code and verifies independent issuer identity fields', async () => {
    for (const options of [
      { badCode: ISSUER }, { badCode: REGISTRY }, { badCode: WRAPPER },
      { sourceParent: HEAD_HASH }, { sourceRegistry: MEMBER }, { sourceWrapper: MEMBER },
    ]) await expect(observeNativeIssueReceipt({
      client: fake(options).client, profile: profile(),
    })).rejects.toBeInstanceOf(NativeReceiptFailure)
  })

  it('rejects each altered historical child ownership, expiry and CU/PCC invariant', async () => {
    for (const options of [
      { registryOwner: MEMBER }, { childOwner: ISSUER }, { tokenOwner: ISSUER },
      { childExpiry: BigInt(expiry) - 1n }, { childFuses: 1 }, { childFuses: 65536 },
    ]) await expect(observeNativeIssueReceipt({
      client: fake(options).client, profile: profile(),
    })).rejects.toMatchObject({ code: 'historical-native-mismatch' })
  })

  it('rejects malformed or cross-parent profiles before a chain read', async () => {
    const { client, calls } = fake()
    for (const invalid of [
      { chainId: 10 }, { issuer: ZERO }, { member: ZERO },
      { parentName: 'other..eth' }, { childLabel: 'X' }, { childLabel: 'xn--bad' },
      { childLabel: '' }, { childLabel: 'a'.repeat(64) },
      { parentName: `${'a.'.repeat(11)}eth` }, { parentName: `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}.eth` },
      { issuerCodeHash: '0x1234' }, { registryCodeHash: `0x${'00'.repeat(32)}` },
      { wrapperCodeHash: 'invalid' }, { expiry: '-1' }, { expiry: '9'.repeat(100) },
      { expiry: (1n << 64n).toString() },
      { transactionHash: 'not-a-hash' }, { unexpectedField: 'secret' },
    ]) {
      await expect(observeNativeIssueReceipt({
        client, profile: { ...profile(), ...invalid },
      })).rejects.toMatchObject({ code: 'invalid-profile' })
    }
    expect(calls).toEqual([])
  })

  it('does not leak credential-bearing RPC exception text', async () => {
    try {
      await observeNativeIssueReceipt({ client: fake({ rpcError: true }).client, profile: profile() })
      throw new Error('expected failure')
    } catch (e) {
      expect(e.code).toBe('unverifiable-rpc')
      expect(e.message).not.toContain('SECRET')
    }
  })
})
