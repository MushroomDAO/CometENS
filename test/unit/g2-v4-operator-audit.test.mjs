import { describe, it, expect } from 'vitest'
import { encodeAbiParameters, encodeEventTopics, keccak256, namehash } from 'viem'
import { AUDIT_EVENTS, auditV4OperatorEvents, parseAuditArgs } from '../../scripts/audit-v4-operator-events.mjs'

const addr = '0x1111111111111111111111111111111111111111'
const a = '0x2222222222222222222222222222222222222222'
const b = '0x3333333333333333333333333333333333333333'
const c = '0x4444444444444444444444444444444444444444'
const code = '0x6001600055'
const profile = { parentName: 'community.eth', chainId: 11155420, contract: addr, expectedCodeHash: keccak256(code) }
const h = (n) => `0x${n.toString(16).padStart(64, '0')}`
const abiParams = (types, values) => encodeAbiParameters(types.map((type) => ({ type })), values)

function event(name, args, data, block, index) {
  const signature = AUDIT_EVENTS.find((e) => e.name === name)
  const topics = encodeEventTopics({ abi: [signature], eventName: name, args })
  const transactionHash = h(block * 100 + index + 1)
  return { address: addr, topics, data, blockNumber: BigInt(block), blockHash: h(block),
    transactionHash, transactionIndex: index, logIndex: index, removed: false }
}

const grant = (operator, block, index) => event('OperatorGranted', { operator },
  abiParams(['uint256', 'uint64', 'uint64', 'uint64'], [3n, 2n, 99999n, 1n]), block, index)
const revoke = (operator, block, index) => event('OperatorRevoked', { operator },
  abiParams(['uint64'], [1n]), block, index)
const accepted = (block, index) => event('ControllerAccepted', { previous: a, current: c },
  abiParams(['uint64'], [2n]), block, index)
const issue = (operator, block, index) => event('IssuanceNonceConsumed', { operator, node: h(901) },
  abiParams(['uint256'], [0n]), block, index)
const subnode = (operator, block, index) => event('SubnodeIssued', { parent: namehash(profile.parentName), node: h(902), holder: c },
  abiParams(['address'], [operator]), block, index)

function fixture() {
  const groups = new Map([[1, [grant(a, 1, 0), revoke(a, 1, 1)]],
    [2, [grant(b, 2, 0), accepted(2, 1), issue(a, 2, 2), subnode(b, 2, 3)]]])
  const props = { wrongChain: false, wrongCode: false, wrongParent: false, extraLog: false,
    truncate: false, wrongBlock: false, missingReceipt: false, forgedTopic: false,
    removedLog: false, wrongTxHash: false, wrongEventParent: false, surplusTransaction: false }
  const client = {
    async getChainId() { return props.wrongChain ? 1 : 11155420 },
    async getBlock({ blockTag, blockNumber }) {
      if (blockTag) return { number: 2n, hash: h(2) }
      const n = Number(blockNumber)
      const xs = groups.get(n) ?? []
      return { number: BigInt(n), hash: h(props.wrongBlock && n === 2 ? 999 : n),
        transactions: [...xs.map((x) => x.transactionHash), ...(props.surplusTransaction ? [h(991)] : [])] }
    },
    async getCode() { return props.wrongCode ? '0x6002' : code },
    async readContract() { return props.wrongParent ? h(999) : namehash(profile.parentName) },
    async getLogs({ fromBlock }) {
      if (props.wrongEventParent && Number(fromBlock) === 2) groups.get(2)[3].topics[1] = h(999)
      const logs = [...(groups.get(Number(fromBlock)) ?? [])].map((l) => ({ ...l }))
      if (props.truncate) logs.pop()
      if (props.extraLog) logs.push({ ...logs[0], logIndex: 999 })
      if (props.forgedTopic && logs[0]) logs[0].topics = [h(1), ...logs[0].topics.slice(1)]
      if (props.removedLog && logs[0]) logs[0].removed = true
      if (props.wrongTxHash && logs[0]) logs[0].transactionHash = h(12345)
      return logs
    },
    async getBlockReceipts({ blockNumber }) {
      const logs = groups.get(Number(blockNumber)) ?? []
      return (props.missingReceipt ? logs.slice(1) : logs).map((l) => ({ blockNumber: l.blockNumber,
        blockHash: l.blockHash, transactionHash: l.transactionHash, transactionIndex: l.transactionIndex,
        status: 'success', logs: [{ ...l }] }))
    },
  }
  return { client, props }
}

describe('G2.5 independent bounded V4 operator event audit', () => {
  it('orders grants, rotates and revokes, captures signed and regular issuance with correct operator filter', async () => {
    const { client } = fixture()
    const all = await auditV4OperatorEvents(client, profile, 1n, 2n)
    expect(all.events.map((x) => x.event)).toEqual([
      'OperatorGranted', 'OperatorRevoked', 'OperatorGranted', 'ControllerAccepted',
      'IssuanceNonceConsumed', 'SubnodeIssued',
    ])
    const forA = await auditV4OperatorEvents(client, profile, 1n, 2n, a)
    expect(forA.events.map((x) => x.event)).toEqual([
      'OperatorGranted', 'OperatorRevoked', 'ControllerAccepted', 'IssuanceNonceConsumed',
    ])
    const forB = await auditV4OperatorEvents(client, profile, 1n, 2n, b)
    expect(forB.events.map((x) => x.event)).toEqual(['OperatorGranted', 'ControllerAccepted', 'SubnodeIssued'])
    expect(all.sovereignReceipt).toBe(false)
    expect(all.scope).toContain('does NOT establish CURRENT operator permissions')
  })

  it.each([
    ['wrong chain', 'wrongChain'], ['runtime hash', 'wrongCode'], ['parent', 'wrongParent'],
    ['RPC injection', 'extraLog'], ['truncated RPC log page', 'truncate'],
    ['forged event topic', 'forgedTopic'], ['incorrect blockHash', 'wrongBlock'],
    ['omitted block receipt', 'missingReceipt'], ['removed log', 'removedLog'],
    ['wrong transaction hash', 'wrongTxHash'], ['truncated receipt list against block txs', 'surplusTransaction'],
    ['event parent mismatch', 'wrongEventParent'],
  ])('fails closed on %s', async (_, change) => {
    const { client, props } = fixture()
    props[change] = true
    await expect(auditV4OperatorEvents(client, profile, 1n, 2n)).rejects.toThrow()
  })

  it('rejects speculative ranges, oversized block scan, malformed CLI flags and unpinned profiles', async () => {
    const { client } = fixture()
    await expect(auditV4OperatorEvents(client, profile, 1n, 3n)).rejects.toThrow('unfinalized-range')
    await expect(auditV4OperatorEvents(client, profile, 1n, 65n)).rejects.toThrow('invalid-block-range')
    await expect(auditV4OperatorEvents(client, { ...profile, expectedCodeHash: h(0) }, 1n, 2n)).rejects.toThrow()
    await expect(auditV4OperatorEvents(client, { ...profile, chainId: 10 }, 1n, 2n)).rejects.toThrow()
    expect(() => parseAuditArgs(['--profile', 'x', '--from-block', '0', '--to-block', '1'])).toThrow()
    expect(() => parseAuditArgs(['--profile', 'x', '--from-block', '1', '--to-block', '1', '--operator', 'bad'])).toThrow()
    expect(() => parseAuditArgs(['--profile', 'x', '--profile', 'y', '--from-block', '1', '--to-block', '1'])).toThrow()
  })

  it('snapshots the pinned identity before awaits and rejects alternating profile getters', async () => {
    const { client } = fixture()
    const mutable = { ...profile }
    const getBlock = client.getBlock
    client.getBlock = async (request) => {
      mutable.contract = b
      mutable.expectedCodeHash = h(444)
      mutable.parentName = 'injected.eth'
      return getBlock(request)
    }
    const actual = await auditV4OperatorEvents(client, mutable, 1n, 2n)
    expect(actual.contract).toBe(profile.contract)
    expect(actual.expectedCodeHash).toBe(profile.expectedCodeHash)
    expect(actual.parentNode).toBe(namehash(profile.parentName))

    const alternating = { ...profile }
    let reads = 0
    Object.defineProperty(alternating, 'contract', { enumerable: true, get: () => (++reads % 2 ? addr : b) })
    await expect(auditV4OperatorEvents(client, alternating, 1n, 2n)).rejects.toThrow('invalid-v4-profile')
    expect(reads).toBe(0)
  })
})
