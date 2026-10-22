#!/usr/bin/env node
// Read-only, RPC-corroborated V4 event history. Never a present-tense ACL proof.
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import {
  createPublicClient, http, decodeEventLog, isAddress, keccak256, namehash,
  parseAbiItem, toEventSelector, formatTransactionReceipt,
} from 'viem'
import { optimismSepolia } from 'viem/chains'

export const AUDIT_EVENTS = [
  'event OperatorGranted(address indexed operator,uint256 permissions,uint64 quota,uint64 expiresAt,uint64 epoch)',
  'event OperatorRevoked(address indexed operator,uint64 epoch)',
  'event ControllerAccepted(address indexed previous,address indexed current,uint64 epoch)',
  'event SubnodeIssued(bytes32 indexed parent,bytes32 indexed node,address indexed holder,address issuer)',
  'event IssuanceNonceConsumed(address indexed operator,uint256 nonce,bytes32 indexed node)',
].map((event) => parseAbiItem(event))
const EVENT_TOPICS = new Set(AUDIT_EVENTS.map((event) => toEventSelector(event).toLowerCase()))
const PARENT_ABI = [{ type: 'function', name: 'parentNode', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] }]
const LIMIT_BLOCKS = 64n
const fail = (code) => { const error = new Error(code); error.kind = code; throw error }
const lower = (value) => typeof value === 'string' ? value.toLowerCase() : fail('invalid-rpc-data')
const hex32 = (value) => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value)
const uint = (value) => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) fail('invalid-unsigned-integer')
  return BigInt(value)
}
const asBigint = (value) => {
  if (typeof value === 'bigint' && value >= 0n) return value
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value)
  if (typeof value === 'string' && /^0x[0-9a-fA-F]+$/.test(value)) return BigInt(value)
  fail('invalid-rpc-data')
}
const json = (value) => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2)

export function parseAuditArgs(argv) {
  const args = argv[0] === '--' ? argv.slice(1) : argv
  if (!args.length || args.length % 2 !== 0) fail('invalid-arguments')
  const flags = {}
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, '')
    if (!['profile', 'from-block', 'to-block', 'operator'].includes(key) || args[i] !== `--${key}` ||
        !args[i + 1] || Object.hasOwn(flags, key)) fail('invalid-arguments')
    flags[key] = args[i + 1]
  }
  if (!flags.profile || !flags['from-block'] || !flags['to-block']) fail('missing-required-arguments')
  const fromBlock = uint(flags['from-block'])
  const toBlock = uint(flags['to-block'])
  if (fromBlock < 1n || toBlock < fromBlock || toBlock - fromBlock >= LIMIT_BLOCKS) fail('invalid-block-range')
  if (flags.operator && !isAddress(flags.operator, { strict: true })) fail('invalid-operator')
  return { flags, fromBlock, toBlock }
}

function validateProfile(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) fail('invalid-v4-profile')
  const descriptors = Object.getOwnPropertyDescriptors(p)
  if (Object.keys(descriptors).sort().join(',') !== 'chainId,contract,expectedCodeHash,parentName' ||
      Object.values(descriptors).some((field) => !Object.hasOwn(field, 'value'))) fail('invalid-v4-profile')
  // No live getters or mutable caller objects may retarget an async RPC audit.
  const profile = Object.freeze(Object.fromEntries(Object.entries(descriptors).map(([k, v]) => [k, v.value])))
  if (profile.chainId !== 11155420 || !isAddress(profile.contract, { strict: true }) ||
      !hex32(profile.expectedCodeHash) || /^0x0+$/.test(profile.expectedCodeHash) ||
      typeof profile.parentName !== 'string' || profile.parentName.length > 255 || !profile.parentName.endsWith('.eth')) {
    fail('invalid-v4-profile')
  }
  try { return { profile, parentNode: namehash(profile.parentName) } } catch { fail('invalid-v4-profile') }
}

const logKey = (l) => {
  if (!hex32(l.blockHash) || !hex32(l.transactionHash) || !Array.isArray(l.topics) ||
      !l.topics.length || !l.topics.every(hex32) || typeof l.data !== 'string' ||
      !/^0x(?:[0-9a-fA-F]{2})*$/.test(l.data)) fail('invalid-rpc-log')
  return `${lower(l.blockHash)}:${asBigint(l.logIndex)}:${lower(l.transactionHash)}`
}

function verifyLog(log, block, receipt, address) {
  if (lower(log.address) !== lower(address) || log.removed === true ||
      asBigint(log.blockNumber) !== asBigint(block.number) ||
      lower(log.blockHash) !== lower(block.hash) ||
      lower(log.blockHash) !== lower(receipt.blockHash) ||
      asBigint(receipt.blockNumber) !== asBigint(block.number) ||
      lower(log.transactionHash) !== lower(receipt.transactionHash) ||
      asBigint(log.transactionIndex) !== asBigint(receipt.transactionIndex) ||
      receipt.status !== 'success') fail('inconsistent-rpc-log')
  return logKey(log)
}

function formatEvent(log) {
  if (!EVENT_TOPICS.has(lower(log.topics[0]))) return null
  let decoded
  try { decoded = decodeEventLog({ abi: AUDIT_EVENTS, data: log.data, topics: log.topics, strict: true }) }
  catch { fail('invalid-event-encoding') }
  return { event: decoded.eventName, args: decoded.args, blockNumber: asBigint(log.blockNumber),
    blockHash: log.blockHash, transactionHash: log.transactionHash,
    transactionIndex: asBigint(log.transactionIndex), logIndex: asBigint(log.logIndex) }
}

/** An RPC audit is bounded corroboration, not a consensus proof or current operator state. */
export async function auditV4OperatorEvents(client, profile, fromBlock, toBlock, operator) {
  const verified = validateProfile(profile)
  profile = verified.profile
  const parentNode = verified.parentNode
  if (typeof fromBlock !== 'bigint' || typeof toBlock !== 'bigint' ||
      fromBlock < 1n || toBlock < fromBlock || toBlock - fromBlock >= LIMIT_BLOCKS) fail('invalid-block-range')
  if (operator && !isAddress(operator, { strict: true })) fail('invalid-operator')
  if (await client.getChainId() !== 11155420) fail('wrong-chain')
  const finalized = await client.getBlock({ blockTag: 'finalized' })
  if (toBlock > asBigint(finalized.number) || !hex32(finalized.hash)) fail('unfinalized-range')
  const events = []
  let volume = 0
  for (let number = fromBlock; number <= toBlock; number++) {
    const block = await client.getBlock({ blockNumber: number })
    if (asBigint(block.number) !== number || !hex32(block.hash) || !Array.isArray(block.transactions) ||
        block.transactions.length > 512) fail('inconsistent-block')
    const [code, parent, logs, receipts] = await Promise.all([
      client.getCode({ address: profile.contract, blockNumber: number }),
      client.readContract({ address: profile.contract, abi: PARENT_ABI, functionName: 'parentNode', blockNumber: number }),
      client.getLogs({ address: profile.contract, fromBlock: number, toBlock: number }),
      client.request({ method: 'eth_getBlockReceipts', params: [`0x${number.toString(16)}`] }).then((raw) => {
        if (!Array.isArray(raw)) fail('invalid-rpc-data')
        return raw.map((receipt) => formatTransactionReceipt(receipt))
      }),
    ])
    if (!code || code === '0x' || lower(keccak256(code)) !== lower(profile.expectedCodeHash) ||
        lower(parent) !== lower(parentNode)) fail('v4-identity-mismatch')
    if (!Array.isArray(logs) || !Array.isArray(receipts) || receipts.length > 512 || logs.length > 512) fail('rpc-volume-limit')
    if (receipts.length !== block.transactions.length) fail('incomplete-receipts')
    const txHashes = new Set(block.transactions.map((tx) => lower(typeof tx === 'string' ? tx : tx.hash)))
    const receiptHashes = new Set(receipts.map((receipt) => lower(receipt.transactionHash)))
    if (txHashes.size !== block.transactions.length || receiptHashes.size !== txHashes.size ||
        [...txHashes].some((hash) => !receiptHashes.has(hash))) fail('incomplete-receipts')
    const expected = new Map()
    for (const receipt of receipts) {
      if (!Array.isArray(receipt.logs) || receipt.logs.length > 512 ||
          asBigint(receipt.blockNumber) !== number || lower(receipt.blockHash) !== lower(block.hash)) fail('inconsistent-receipt')
      volume += receipt.logs.length
      if (volume > 4096) fail('rpc-volume-limit')
      for (const log of receipt.logs) {
        if (lower(log.address) !== lower(profile.contract)) continue
        const key = verifyLog(log, block, receipt, profile.contract)
        if (expected.has(key)) fail('duplicate-rpc-log')
        expected.set(key, log)
      }
    }
    if (expected.size !== logs.length) fail('missing-or-extra-logs')
    const seen = new Set()
    for (const log of logs) {
      const key = logKey(log)
      const canonical = expected.get(key)
      if (!canonical || seen.has(key) || lower(log.address) !== lower(canonical.address) ||
          lower(log.data) !== lower(canonical.data) ||
          log.topics.length !== canonical.topics.length ||
          log.topics.some((t, i) => lower(t) !== lower(canonical.topics[i])) ||
          asBigint(log.transactionIndex) !== asBigint(canonical.transactionIndex)) fail('missing-or-extra-logs')
      seen.add(key)
      const receipt = receipts.find((r) => lower(r.transactionHash) === lower(log.transactionHash))
      if (!receipt) fail('missing-receipt')
      verifyLog(log, block, receipt, profile.contract)
      const event = formatEvent(log)
      if (event?.event === 'SubnodeIssued' && lower(event.args.parent) !== lower(parentNode)) fail('invalid-event-parent')
      if (event && (!operator || event.event === 'ControllerAccepted' ||
          (event.event === 'SubnodeIssued' ? lower(event.args.issuer) === lower(operator) :
            lower(event.args.operator) === lower(operator)))) events.push(event)
      if (events.length > 512) fail('rpc-volume-limit')
    }
  }
  if (await client.getChainId() !== 11155420 ||
      asBigint((await client.getBlock({ blockTag: 'finalized' })).number) < toBlock) fail('finality-changed')
  events.sort((x, y) => x.blockNumber === y.blockNumber ?
    (x.transactionIndex === y.transactionIndex ? Number(x.logIndex - y.logIndex) :
      Number(x.transactionIndex - y.transactionIndex)) : Number(x.blockNumber - y.blockNumber))
  return { chainId: 11155420, contract: profile.contract, expectedCodeHash: profile.expectedCodeHash,
    parentNode, fromBlock, toBlock, operator: operator ?? null, events,
    provenance: 'OP RPC block receipts cross-checked with eth_getLogs; not independent consensus proof',
    scope: 'historical finalized-range events only; does NOT establish CURRENT operator permissions, quota, epoch, expiry or L1 ENS ownership',
    sovereignReceipt: false, signed: false, broadcast: false }
}

export async function runV4OperatorAudit(argv, options = {}) {
  const { flags, fromBlock, toBlock } = parseAuditArgs(argv)
  const raw = await readFile(flags.profile)
  if (raw.byteLength > 8192) fail('profile-too-large')
  let profile
  try { profile = JSON.parse(raw.toString()) } catch { fail('invalid-v4-profile') }
  validateProfile(profile)
  const rpc = options.rpcUrl ?? process.env.COMETENS_OP_RPC_URL
  if (!options.client) {
    if (!rpc) fail('missing-rpc')
    let url
    try { url = new URL(rpc) } catch { fail('invalid-rpc') }
    if (url.username || url.password || (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) fail('invalid-rpc')
  }
  const client = options.client ?? createPublicClient({ chain: optimismSepolia, transport: http(rpc, { retryCount: 0, timeout: 15_000 }) })
  return json(await auditV4OperatorEvents(client, profile, fromBlock, toBlock, flags.operator))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--help') || process.argv.length < 3) {
    process.stdout.write('Usage: node scripts/audit-v4-operator-events.mjs --profile v4-profile.json --from-block N --to-block N [--operator 0xADDRESS]\nRPC: COMETENS_OP_RPC_URL (HTTPS or local loopback). Max 64 finalized blocks per call. Historical OP events, not current ACL or L1 ownership.\n')
  } else {
    runV4OperatorAudit(process.argv.slice(2)).then((v) => process.stdout.write(v + '\n')).catch((err) => {
      process.stderr.write(`V4 event audit failed (${err?.kind ?? 'invalid-or-unavailable'}).\n`)
      process.exitCode = 1
    })
  }
}
