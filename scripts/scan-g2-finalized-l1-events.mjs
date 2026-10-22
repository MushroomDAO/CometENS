#!/usr/bin/env node
/**
 * Finalized-RPC ENS event trigger scanner. It does NOT authorize an ENS/OP
 * action, and cannot prove that all relevant state changes emitted events.
 */
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { createPublicClient, http, keccak256, toHex } from 'viem'
import { sepolia } from 'viem/chains'

const VERSION = 'G2_L1_FINALIZED_EVENT_CURSOR_V1'
const HASH = /^0x[0-9a-fA-F]{64}$/
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const DECIMAL = /^(0|[1-9][0-9]*)$/
const MAX_RANGE = 128n
const MAX_LOGS = 512
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()
const exact = (obj, names) => obj && typeof obj === 'object' && !Array.isArray(obj) &&
  Object.keys(obj).sort().join(',') === [...names].sort().join(',')
const digest = (object) => keccak256(toHex(JSON.stringify(object)))
export class FinalizedEventFailure extends Error {
  constructor(code) { super(`L1 finalized-event scan failed: ${code}`); this.code = code; this.name = 'FinalizedEventFailure' }
}
const fail = (code) => { throw new FinalizedEventFailure(code) }

function validateManifest(m) {
  if (!exact(m, ['chainId', 'startBlock', 'sources']) || m.chainId !== 11155111 ||
      typeof m.startBlock !== 'string' || !DECIMAL.test(m.startBlock) ||
      !Array.isArray(m.sources) || !m.sources.length || m.sources.length > 12) fail('invalid-manifest')
  const unique = new Set()
  for (const s of m.sources) {
    if (!exact(s, ['address', 'codeHash', 'topics']) || !ADDRESS.test(s.address) ||
        !HASH.test(s.codeHash) || /^0x0+$/i.test(s.codeHash) ||
        !Array.isArray(s.topics) || !s.topics.length || s.topics.length > 24 ||
        s.topics.some(t => !HASH.test(t))) fail('invalid-manifest')
    const addr = s.address.toLowerCase()
    if (unique.has(addr) || new Set(s.topics.map(t => t.toLowerCase())).size !== s.topics.length) fail('invalid-manifest')
    unique.add(addr)
  }
  return digest(m)
}

function validatePrevious(previous, manifestHash) {
  if (previous == null) return null
  if (!exact(previous, ['version', 'chainId', 'manifestHash', 'block']) ||
      previous.version !== VERSION || previous.chainId !== 11155111 ||
      !same(previous.manifestHash, manifestHash) ||
      !exact(previous.block, ['number', 'hash']) ||
      typeof previous.block.number !== 'string' || !DECIMAL.test(previous.block.number) ||
      !HASH.test(previous.block.hash)) fail('invalid-previous')
  return previous
}

const canonicalBlock = async (client, number, expectedHash = null) => {
  const block = await client.getBlock({ blockNumber: number })
  if (block?.number !== number || !HASH.test(block?.hash ?? '') ||
      (expectedHash && !same(block.hash, expectedHash))) fail('finalized-conflict')
  return block
}

/** Trigger-only; a periodic authoritative ENSv1/v2 state reader is mandatory. */
export async function scanFinalizedL1Events({ client, manifest, previous = null }) {
  const manifestHash = validateManifest(manifest)
  const prior = validatePrevious(previous, manifestHash)
  if (!client) fail('invalid-input')
  try {
    if (await client.getChainId() !== 11155111) fail('wrong-chain')
    const finalized = await client.getBlock({ blockTag: 'finalized' })
    if (typeof finalized?.number !== 'bigint' || typeof finalized.timestamp !== 'bigint' ||
        !HASH.test(finalized.hash ?? '')) fail('invalid-finalized-block')
    const now = BigInt(Math.floor(Date.now() / 1000))
    if (finalized.timestamp > now + 120n || finalized.timestamp + 7200n < now) fail('stale-finality')
    const start = BigInt(manifest.startBlock)
    const from = prior ? BigInt(prior.block.number) + 1n : start
    if (prior) {
      if (BigInt(prior.block.number) < start || BigInt(prior.block.number) > finalized.number) fail('finalized-conflict')
      await canonicalBlock(client, BigInt(prior.block.number), prior.block.hash)
    }
    if (from > finalized.number) {
      if (!prior) fail('start-not-finalized')
      return {
        status: 'UNCHANGED', events: [], cursor: prior, caughtUp: true,
        mustReconcileNativeState: true, reason: 'PERIODIC_STATE_CHECK',
        evidenceLevel: 'FINALIZED_RPC_TRIGGER_ONLY', enablesNativeIssuance: false, sovereignReceipt: false,
      }
    }
    const to = from + MAX_RANGE - 1n < finalized.number ? from + MAX_RANGE - 1n : finalized.number
    const logs = []
    for (const source of manifest.sources) {
      for (const height of [from, to]) {
        const bytecode = await client.getBytecode({ address: source.address, blockNumber: height })
        if (!bytecode || bytecode === '0x' || !same(keccak256(bytecode), source.codeHash)) fail('untrusted-source-code')
      }
      // viem publicClient.getLogs ignores a caller-supplied `topics` field and
      // derives topics only from `event(s)`. Use explicit JSON-RPC to filter a
      // version-pinned OR-list of topic0 hashes (no unfiltered fallback).
      const found = await client.request({
        method: 'eth_getLogs',
        params: [{
          address: source.address, topics: [source.topics],
          fromBlock: toHex(from), toBlock: toHex(to),
        }],
      })
      if (!Array.isArray(found) || found.length > MAX_LOGS - logs.length) fail('invalid-log-batch')
      for (const log of found) {
        if (typeof log.blockNumber !== 'string' || !/^0x[0-9a-fA-F]+$/.test(log.blockNumber) ||
            typeof log.logIndex !== 'string' || !/^0x[0-9a-fA-F]+$/.test(log.logIndex)) fail('invalid-log-batch')
        const blockNumber = BigInt(log.blockNumber)
        const logIndex = Number(BigInt(log.logIndex))
        if (!same(log.address, source.address) ||
            !Array.isArray(log.topics) || !source.topics.some(t => same(t, log.topics[0])) ||
            blockNumber < from || blockNumber > to ||
            !HASH.test(log.blockHash ?? '') || !HASH.test(log.transactionHash ?? '') ||
            !Number.isSafeInteger(logIndex) || logIndex < 0 || log.removed === true) fail('invalid-log-batch')
        logs.push({ blockNumber, blockHash: log.blockHash,
          transactionHash: log.transactionHash, logIndex,
          address: log.address, topic0: log.topics[0] })
      }
    }
    const hashes = new Map()
    const seen = new Set()
    for (const log of logs) {
      const key = `${log.blockNumber}:${log.transactionHash.toLowerCase()}:${log.logIndex}`
      if (seen.has(key)) fail('duplicate-log')
      seen.add(key)
      const at = log.blockNumber.toString()
      if (hashes.has(at) && !same(hashes.get(at), log.blockHash)) fail('conflicting-log-block')
      hashes.set(at, log.blockHash)
    }
    for (const [height, hash] of hashes) await canonicalBlock(client, BigInt(height), hash)
    const tip = await canonicalBlock(client, to, to === finalized.number ? finalized.hash : null)
    const again = await client.getBlock({ blockTag: 'finalized' })
    if (typeof again?.number !== 'bigint' || again.number < finalized.number ||
        (again.number === finalized.number && !same(again.hash, finalized.hash))) fail('finalized-conflict')
    logs.sort((a, b) => a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber
      ? 1 : a.logIndex - b.logIndex)
    return {
      status: logs.length ? 'EVENTS_OBSERVED' : 'NO_EVENTS',
      fromBlock: from.toString(), toBlock: to.toString(),
      events: logs.map(l => ({ ...l, blockNumber: l.blockNumber.toString() })),
      cursor: { version: VERSION, chainId: 11155111, manifestHash,
        block: { number: to.toString(), hash: tip.hash } },
      caughtUp: to === finalized.number,
      mustReconcileNativeState: true,
      reason: logs.length ? 'EVENT_AND_PERIODIC_STATE_CHECK' : 'PERIODIC_STATE_CHECK',
      evidenceLevel: 'FINALIZED_RPC_TRIGGER_ONLY', enablesNativeIssuance: false, sovereignReceipt: false,
    }
  } catch (error) {
    if (error instanceof FinalizedEventFailure) throw error
    fail('unverifiable-rpc')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2)
    if ((args.length !== 2 && args.length !== 4) || args[0] !== '--manifest' ||
        (args.length === 4 && (args[2] !== '--previous' || !args[3])) || !args[1]) fail('invalid-arguments')
    const rawUrl = process.env.COMETENS_PUBLIC_SEPOLIA_RPC
    let url
    try { url = new URL(rawUrl) } catch { fail('public-rpc-required') }
    if (url.protocol !== 'https:' || url.username || url.password || url.search ||
        url.hash || url.pathname !== '/') fail('public-rpc-required')
    const load = async (file, limit) => {
      const data = await readFile(file)
      if (!data.length || data.length > limit) fail('invalid-input-file')
      return JSON.parse(data.toString())
    }
    const manifest = await load(args[1], 16384)
    const previous = args.length === 4 ? await load(args[3], 4096) : null
    if (args.length === 4 && previous == null) fail('invalid-previous')
    const result = await scanFinalizedL1Events({
      client: createPublicClient({ chain: sepolia, transport: http(rawUrl) }), manifest, previous,
    })
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  } catch (error) {
    const code = error instanceof FinalizedEventFailure ? error.code : 'invalid-input-or-rpc'
    process.stderr.write(`G2 finalized-event scanner unavailable (${code}); no ENS/OP authorization.\n`)
    process.exitCode = 2
  }
}
