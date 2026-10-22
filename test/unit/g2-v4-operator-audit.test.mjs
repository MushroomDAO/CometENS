import { describe, it, expect } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPublicClient, custom, encodeAbiParameters, encodeEventTopics, keccak256, namehash } from 'viem'
import { AUDIT_EVENTS, auditV4OperatorEvents, parseAuditArgs, runV4OperatorAudit } from '../../scripts/audit-v4-operator-events.mjs'

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
    removedLog: false, wrongTxHash: false, wrongEventParent: false, surplusTransaction: false,
    revertedReceipt: false, duplicateReceiptLog: false, finalityChanged: false,
    oversizedBlock: false, oversizedLogs: false, oversizedReceiptLogs: false, chainChanged: false }
  let finalizedReads = 0
  let chainReads = 0
  const client = {
    async getChainId() { return props.wrongChain || (props.chainChanged && ++chainReads > 1) ? 1 : 11155420 },
    async getBlock({ blockTag, blockNumber }) {
      if (blockTag) return { number: props.finalityChanged && ++finalizedReads > 1 ? 1n : 2n, hash: h(2) }
      const n = Number(blockNumber)
      const xs = groups.get(n) ?? []
      return { number: BigInt(n), hash: h(props.wrongBlock && n === 2 ? 999 : n),
        transactions: props.oversizedBlock ? Array.from({ length: 513 }, (_, i) => h(i + 10000)) :
          [...xs.map((x) => x.transactionHash), ...(props.surplusTransaction ? [h(991)] : [])] }
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
      return props.oversizedLogs ? Array.from({ length: 513 }, () => logs[0]) : logs
    },
    async request({ method, params }) {
      if (method !== 'eth_getBlockReceipts') throw new Error('unexpected RPC method')
      const logs = groups.get(Number(BigInt(params[0]))) ?? []
      return (props.missingReceipt ? logs.slice(1) : logs).map((l) => ({ blockNumber: `0x${l.blockNumber.toString(16)}`,
        blockHash: l.blockHash, transactionHash: l.transactionHash, transactionIndex: l.transactionIndex,
        status: props.revertedReceipt ? '0x0' : '0x1', transactionIndex: `0x${l.transactionIndex.toString(16)}`,
        logs: Array.from({ length: props.oversizedReceiptLogs ? 513 : props.duplicateReceiptLog ? 2 : 1 }, () => ({ ...l, blockNumber: `0x${l.blockNumber.toString(16)}`,
          transactionIndex: `0x${l.transactionIndex.toString(16)}`,
          logIndex: `0x${l.logIndex.toString(16)}` })) }))
    },
  }
  return { client, props, groups }
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
    ['reverted transaction receipts', 'revertedReceipt'],
    ['duplicate receipt logs', 'duplicateReceiptLog'],
    ['finality decreases during scan', 'finalityChanged'],
    ['chain changes during scan', 'chainChanged'],
    ['block transaction capacity', 'oversizedBlock'],
    ['eth_getLogs response capacity', 'oversizedLogs'],
    ['receipt log capacity', 'oversizedReceiptLogs'],
  ])('fails closed on %s', async (_, change) => {
    const { client, props } = fixture()
    props[change] = true
    await expect(auditV4OperatorEvents(client, profile, 1n, 2n)).rejects.toThrow()
  })

  it('real viem public client exposes eth_getBlockReceipts via request, not getBlockReceipts', async () => {
    const { client: mock } = fixture()
    const methods = []
    const actual = createPublicClient({ transport: custom({ request: async ({ method, params }) => {
      methods.push(method)
      return mock.request({ method, params })
    } }) }).extend(() => ({
      getChainId: mock.getChainId, getBlock: mock.getBlock,
      getCode: mock.getCode, readContract: mock.readContract, getLogs: mock.getLogs,
    }))
    expect(actual.getBlockReceipts).toBeUndefined()
    const folder = await mkdtemp(join(tmpdir(), 'comet-v4-audit-'))
    try {
      const path = join(folder, 'profile.json')
      await writeFile(path, JSON.stringify(profile))
      const output = await runV4OperatorAudit(['--profile', path, '--from-block', '1', '--to-block', '2'], { client: actual })
      expect(JSON.parse(output).events).toHaveLength(6)
      expect(methods).toEqual(['eth_getBlockReceipts', 'eth_getBlockReceipts'])
    } finally { await rm(folder, { recursive: true, force: true }) }
  })

  it('rejects excessive decoded events across individually bounded blocks', async () => {
    const { client, groups } = fixture()
    groups.set(1, Array.from({ length: 300 }, (_, i) => grant(a, 1, i)))
    groups.set(2, Array.from({ length: 300 }, (_, i) => grant(b, 2, i)))
    await expect(auditV4OperatorEvents(client, profile, 1n, 2n)).rejects.toThrow('rpc-volume-limit')
  })

  it('rejects aggregate receipt-log volume even when block-local limits hold', async () => {
    const { client } = fixture()
    const getBlock = client.getBlock
    client.getBlock = async (arg) => arg.blockTag ? { number: 9n, hash: h(9) } :
      { number: arg.blockNumber, hash: h(Number(arg.blockNumber)), transactions: [h(Number(arg.blockNumber) * 100 + 1)] }
    const originalRequest = client.request
    client.request = async ({ method, params }) => {
      const n = Number(BigInt(params[0]))
      const other = Array.from({ length: 500 }, (_, i) => ({
        address: b, blockNumber: `0x${n.toString(16)}`, blockHash: h(n),
        transactionHash: h(n * 100 + 1), transactionIndex: '0x0',
        logIndex: `0x${i.toString(16)}`, topics: [h(1)], data: '0x', removed: false,
      }))
      return [{ blockNumber: `0x${n.toString(16)}`, blockHash: h(n),
        transactionHash: h(n * 100 + 1), transactionIndex: '0x0', status: '0x1', logs: other }]
    }
    client.getLogs = async () => []
    await expect(auditV4OperatorEvents(client, profile, 1n, 9n)).rejects.toThrow('rpc-volume-limit')
  })

  it('rejects a matching but malformed V4 event ABI in receipt and log', async () => {
    const { client, groups } = fixture()
    groups.get(1)[0].data = '0x12'
    await expect(auditV4OperatorEvents(client, profile, 1n, 2n)).rejects.toThrow('invalid-event-encoding')
  })

  it.each(['block-transactions', 'receipt-count', 'getLogs-count', 'receipt-logs'])('enforces independent 512 cap on %s with coherent RPC data', async (target) => {
    for (const count of [512, 513]) {
      const { client } = fixture()
      const isTx = target === 'block-transactions' || target === 'receipt-count'
      const txs = Array.from({ length: isTx ? count : 1 }, (_, i) => h(10000 + i))
      const entries = Array.from({ length: isTx ? count : count }, (_, i) => ({
        ...grant(a, 1, i), transactionHash: isTx ? txs[i] : txs[0],
        transactionIndex: isTx ? i : 0, logIndex: i,
      }))
      client.getBlock = async ({ blockTag }) => blockTag ? { number: 1n, hash: h(1) } :
        { number: 1n, hash: h(1), transactions: txs }
      client.getLogs = async () => target === 'receipt-count' ? [] : entries
      client.request = async () => (isTx ? txs : [txs[0]]).map((tx, i) => ({
        blockNumber: '0x1', blockHash: h(1), transactionHash: tx,
        transactionIndex: `0x${i.toString(16)}`, status: '0x1',
        logs: (target === 'receipt-count' ? [] : isTx ? [entries[i]] : entries).map((log) => ({
          ...log, blockNumber: '0x1', transactionIndex: `0x${log.transactionIndex.toString(16)}`,
          logIndex: `0x${log.logIndex.toString(16)}`,
        })),
      }))
      if (count === 513) {
        const kind = isTx ? 'inconsistent-block' : 'rpc-volume-limit'
        await expect(auditV4OperatorEvents(client, profile, 1n, 1n)).rejects.toThrow(kind)
      } else {
        const result = await auditV4OperatorEvents(client, profile, 1n, 1n)
        expect(result.events).toHaveLength(target === 'receipt-count' ? 0 : 512)
      }
    }
  })

  it('checks per-receipt 512 external logs without relying on V4 eth_getLogs limit', async () => {
    for (const count of [512, 513]) {
      const { client } = fixture()
      client.getBlock = async ({ blockTag }) => blockTag ? { number: 1n, hash: h(1) } :
        { number: 1n, hash: h(1), transactions: [h(101)] }
      client.getLogs = async () => []
      client.request = async () => [{ blockNumber: '0x1', blockHash: h(1),
        transactionHash: h(101), transactionIndex: '0x0', status: '0x1',
        logs: Array.from({ length: count }, (_, i) => ({ address: b, blockNumber: '0x1',
          blockHash: h(1), transactionHash: h(101), transactionIndex: '0x0',
          logIndex: `0x${i.toString(16)}`, topics: [h(1)], data: '0x', removed: false })) }]
      if (count === 513) await expect(auditV4OperatorEvents(client, profile, 1n, 1n)).rejects.toThrow('inconsistent-receipt')
      else expect((await auditV4OperatorEvents(client, profile, 1n, 1n)).events).toEqual([])
    }
  })

  it('checks receipt count cap independent of block transaction cap', async () => {
    const { client } = fixture()
    client.getBlock = async ({ blockTag }) => blockTag ? { number: 1n, hash: h(1) } :
      { number: 1n, hash: h(1), transactions: [h(101)] }
    client.getLogs = async () => []
    client.request = async () => Array.from({ length: 513 }, (_, i) => ({
      blockNumber: '0x1', blockHash: h(1), transactionHash: h(101 + i),
      transactionIndex: `0x${i.toString(16)}`, status: '0x1', logs: [],
    }))
    await expect(auditV4OperatorEvents(client, profile, 1n, 1n)).rejects.toThrow('rpc-volume-limit')
  })

  it('rejects speculative ranges, oversized block scan, malformed CLI flags and unpinned profiles', async () => {
    const { client } = fixture()
    await expect(auditV4OperatorEvents(client, profile, 1n, 3n)).rejects.toThrow('unfinalized-range')
    await expect(auditV4OperatorEvents(client, profile, 1, 2)).rejects.toThrow('invalid-block-range')
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
