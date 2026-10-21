import { describe, expect, it } from 'vitest'
import { encodeAbiParameters, encodeEventTopics, keccak256, namehash, parseAbiItem, parseAbiParameters } from 'viem'
import { ENS, observeLegacyResolver } from '../../scripts/observe-g2-legacy-resolver.mjs'

const a = '0x1111111111111111111111111111111111111111'
const b = '0x2222222222222222222222222222222222222222'
const c = '0x3333333333333333333333333333333333333333'
const d = '0x4444444444444444444444444444444444444444'
const storeCode = '0x6001600055'
const registryCode = '0x6002600055'
const wrapperCode = '0x6003600055'
const registrarCode = '0x6004600055'
const node = namehash('alice.community.eth')
const parent = namehash('community.eth')
const h = (i) => `0x${i.toString(16).padStart(64, '0')}`
const records = { addr: a, contenthash: '0xe30102', textKey: 'name', textValue: 'Alice' }
const commitment = keccak256(encodeAbiParameters(parseAbiParameters('bytes32,address,bytes,string,string'),
  [node, records.addr, records.contenthash, records.textKey, records.textValue]))
const profile = {
  chainId: 11155111, contract: d, parentName: 'community.eth', childLabel: 'alice',
  expectedHolder: b, expectedLockedBy: c, lockTransactionHash: h(1234),
  codehashes: { store: keccak256(storeCode), registry: keccak256(registryCode),
    wrapper: keccak256(wrapperCode), registrar: keccak256(registrarCode) }, records,
}
const event = parseAbiItem('event MemberRecordsLocked(bytes32 indexed node,address indexed member,bytes32 recordCommitment)')
function fixture() {
  const state = { chain: 11155111, wrongStoreCode: false, wrongRegistryCode: false,
    wrongPointer: false, wrongParent: false, wrongChild: false, wrongHolder: false,
    expired: false, badFuse: false, wrongCommit: false, wrongLockedBy: false,
    wrongRecord: false, wrongText: false, badEvent: false, missingEvent: false,
    movedBlock: false, unfinalized: false, wrongHistoricalCode: false, badReceipt: false,
    missingHistoricalTransaction: false, wrongContenthash: false }
  const block = { number: 100n, hash: h(100), timestamp: 1000000n }
  const lockBlock = { number: 95n, hash: h(95), timestamp: 999900n }
  const log = () => ({ address: d, blockHash: lockBlock.hash, blockNumber: 95n,
    transactionHash: profile.lockTransactionHash, logIndex: 0n, removed: false,
    topics: encodeEventTopics({ abi: [event], eventName: 'MemberRecordsLocked',
      args: { node, member: state.badEvent ? a : c } }),
    data: encodeAbiParameters([{ type: 'bytes32' }], [commitment]),
  })
  const client = {
    async getChainId() { return state.chain },
    async getBlock({ blockTag, blockNumber }) {
      if (blockTag) return { ...block, number: state.unfinalized ? 90n : 100n }
      if (blockNumber === 95n) return { ...lockBlock, transactions: state.missingHistoricalTransaction ? [] : [profile.lockTransactionHash] }
      return { ...block, hash: state.movedBlock ? h(333) : block.hash }
    },
    async getCode({ address, blockNumber }) {
      if (address.toLowerCase() === d.toLowerCase()) {
        if (state.wrongStoreCode || (blockNumber === 95n && state.wrongHistoricalCode)) return '0x6005'
        return storeCode
      }
      if (address.toLowerCase() === ENS.registry.toLowerCase()) return state.wrongRegistryCode ? '0x6006' : registryCode
      if (address.toLowerCase() === ENS.wrapper.toLowerCase()) return wrapperCode
      if (address.toLowerCase() === ENS.registrar.toLowerCase()) return registrarCode
      throw new Error('wrong address')
    },
    async readContract({ address, functionName, args }) {
      const who = address.toLowerCase()
      if (who === d.toLowerCase()) {
        switch (functionName) {
          case 'parentNode': return state.wrongParent ? h(7) : parent
          case 'node': return state.wrongChild ? h(7) : node
          case 'parentLabelId': return BigInt(keccak256('0x636f6d6d756e697479'))
          case 'registryCodeHash': return profile.codehashes.registry
          case 'wrapperCodeHash': return profile.codehashes.wrapper
          case 'registrarCodeHash': return profile.codehashes.registrar
          case 'locked': return true
          case 'lockedBy': return state.wrongLockedBy ? a : c
          case 'recordCommitment': return state.wrongCommit ? h(8) : commitment
          case 'addr': return state.wrongRecord ? b : records.addr
          case 'contenthash': return state.wrongContenthash ? '0xbeef' : records.contenthash
          case 'text': return state.wrongText ? 'Mallory' : records.textValue
        }
      }
      if (who === ENS.registry.toLowerCase()) {
        if (functionName === 'resolver') return state.wrongPointer ? a : d
        if (functionName === 'owner') return ENS.wrapper
      }
      if (who === ENS.wrapper.toLowerCase()) {
        if (functionName === 'ownerOf') return state.wrongHolder ? a : b
        if (functionName === 'getData') {
          if (args[0] === BigInt(parent)) return [a, 1n, block.timestamp + 30n * 86400n]
          return [state.wrongHolder ? a : b, state.badFuse ? 1n : 65537n,
            state.expired ? block.timestamp + 86400n : block.timestamp + 7n * 86400n]
        }
      }
      if (who === ENS.registrar.toLowerCase()) {
        if (functionName === 'ownerOf') return ENS.wrapper
        if (functionName === 'nameExpires') return block.timestamp + 20n * 86400n
      }
      throw new Error(`unmocked ${functionName}`)
    },
    async getTransactionReceipt() {
      return { status: state.badReceipt ? 'reverted' : 'success', transactionHash: profile.lockTransactionHash,
        blockNumber: 95n, blockHash: h(95), logs: state.missingEvent ? [] : [log()] }
    },
  }
  return { client, state }
}

describe('G2.9 finalized legacy ENSv1 resolver bundle observation', () => {
  it('observes matching finalized Registry pointer, immutable bundle, historical locker and current holder separately', async () => {
    const { client } = fixture()
    const result = await observeLegacyResolver(client, profile)
    expect(result.resolverPointerMatches).toBe(true)
    expect(result.historicalLockedBy).toBe(c)
    expect(result.currentWrappedHolder).toBe(b)
    expect(result.recordCommitment).toBe(commitment)
    expect(result.records).toEqual(records)
    expect(result.blockHash).toBe(h(100))
    expect(result.lockEvent.blockHash).toBe(h(95))
    expect(result.sovereignReceipt).toBe(false)
    expect(result.lockedRecordVerified).toBe(false)
    expect(result.nativeResolverPointerLockedVerified).toBe(false)
    expect(result.approvalInventoryExhaustive).toBe(false)
    expect(result.ensV2AuthorityVerified).toBe(false)
  })

  it.each([
    ['chain', 'chain'], ['runtime hash', 'wrongStoreCode'], ['registry runtime hash', 'wrongRegistryCode'],
    ['resolver repointing', 'wrongPointer'], ['parent node', 'wrongParent'], ['child node', 'wrongChild'],
    ['native holder', 'wrongHolder'], ['expiry/grace', 'expired'], ['fuse', 'badFuse'],
    ['commitment', 'wrongCommit'], ['historical locker', 'wrongLockedBy'],
    ['served addr', 'wrongRecord'], ['served text', 'wrongText'],
    ['signed event member', 'badEvent'], ['missing event receipt log', 'missingEvent'],
    ['finalized block hash drift', 'movedBlock'], ['unfinalized range', 'unfinalized'],
    ['historical runtime codehash', 'wrongHistoricalCode'], ['reverted lock receipt', 'badReceipt'],
    ['historical tx not in block', 'missingHistoricalTransaction'], ['served contenthash', 'wrongContenthash'],
  ])('fails closed on %s mutation', async (_, key) => {
    const { client, state } = fixture()
    state[key] = key === 'chain' ? 1 : true
    await expect(observeLegacyResolver(client, profile)).rejects.toThrow()
  })

  it('rejects getter based profile injection and snapshots nested records before asynchronous reads', async () => {
    const alternating = { ...profile }
    let reads = 0
    Object.defineProperty(alternating, 'contract', { enumerable: true, get: () => (++reads ? d : a) })
    const { client } = fixture()
    await expect(observeLegacyResolver(client, alternating)).rejects.toThrow('invalid-profile')
    expect(reads).toBe(0)
    const mutable = structuredClone(profile)
    const getBlock = client.getBlock
    client.getBlock = async (...args) => {
      mutable.contract = a
      mutable.records.addr = b
      return getBlock(...args)
    }
    const result = await observeLegacyResolver(client, mutable)
    expect(result.contract).toBe(d)
    expect(result.records.addr).toBe(a)
  })
})
