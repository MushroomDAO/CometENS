#!/usr/bin/env node
/**
 * Read-only inventory of resolver runtime bytecode by three selector probes.
 * Not acceptance. Does not load environment files, sign, or send transactions.
 *
 *   node scripts/check-sepolia-resolver-drift.mjs --fixture drift.json
 *   node scripts/check-sepolia-resolver-drift.mjs --live --address 0x…
 *   node scripts/check-sepolia-resolver-drift.mjs --live --chain op-sepolia --address 0x…
 *
 * Fixture JSON: { "entries": [ { "address"?: "0x…", "bytecode": "0x…" } ] }
 * Categories are selector shapes, not verified compiler identities:
 *   HybridResolver   gatewayUrl + verifier, no resolveWithProof(bytes,bytes)
 *   OPResolver       verifier only
 *   OffchainResolver gatewayUrl + resolveWithProof, no verifier
 *   unknown          every other shape, including empty code
 * Unknown is never healthy. Exit 0 is only "every fixture entry matched a
 * known shape". g3Unblocked and acceptance stay false.
 */
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { createPublicClient, getAddress, http, isAddress, toFunctionSelector } from 'viem'
import { optimismSepolia, sepolia } from 'viem/chains'

export const PROBES = Object.freeze({
  gatewayUrl: 'gatewayUrl()',
  verifier: 'verifier()',
  resolveWithProof: 'resolveWithProof(bytes,bytes)',
})

export const SELECTOR = Object.freeze(Object.fromEntries(
  Object.entries(PROBES).map(([name, signature]) => [name, toFunctionSelector(`function ${signature}`).slice(2)]),
))

/** Public RPCs already named in repo docs. No other endpoint is contacted. */
export const PUBLIC_CHAINS = Object.freeze({
  'ethereum-sepolia': Object.freeze({
    chainId: 11155111,
    rpc: 'https://ethereum-sepolia-rpc.publicnode.com',
    chain: sepolia,
  }),
  'op-sepolia': Object.freeze({
    chainId: 11155420,
    rpc: 'https://sepolia.optimism.io',
    chain: optimismSepolia,
  }),
})

export function bytecodeBody(bytecode) {
  if (typeof bytecode !== 'string') return null
  const hex = bytecode.trim().toLowerCase()
  const body = hex.startsWith('0x') ? hex.slice(2) : hex
  if (body.length % 2 !== 0 || !/^[0-9a-f]*$/.test(body)) return null
  return body
}

export function selectorPresence(bytecode) {
  const body = bytecodeBody(bytecode)
  if (body === null) return null
  return Object.freeze({
    gatewayUrl: body.includes(SELECTOR.gatewayUrl),
    verifier: body.includes(SELECTOR.verifier),
    resolveWithProof: body.includes(SELECTOR.resolveWithProof),
  })
}

/** Known shapes are exact. Any extra or missing probe stays unknown. */
export function categoryFor(selectors) {
  if (!selectors) return 'unknown'
  const gatewayUrl = selectors.gatewayUrl === true
  const verifier = selectors.verifier === true
  const resolveWithProof = selectors.resolveWithProof === true
  if (gatewayUrl && verifier && !resolveWithProof) return 'HybridResolver'
  if (!gatewayUrl && verifier && !resolveWithProof) return 'OPResolver'
  if (gatewayUrl && !verifier && resolveWithProof) return 'OffchainResolver'
  return 'unknown'
}

export function classifyBytecode(bytecode) {
  const body = bytecodeBody(bytecode)
  const selectors = body === null
    ? Object.freeze({ gatewayUrl: false, verifier: false, resolveWithProof: false })
    : selectorPresence(bytecode)
  const category = categoryFor(selectors)
  const reason = body === null
    ? 'invalid-bytecode'
    : body.length === 0
      ? 'empty-bytecode'
      : category === 'unknown'
        ? 'unrecognized-selector-shape'
        : 'recognized-selector-shape'
  return Object.freeze({
    category,
    healthy: category !== 'unknown',
    reason,
    selectors,
  })
}

function entryReport(address, bytecode) {
  const classified = classifyBytecode(bytecode)
  return Object.freeze({
    address,
    category: classified.category,
    healthy: classified.healthy,
    reason: classified.reason,
    selectors: classified.selectors,
  })
}

export function reportFixture(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.entries) || raw.entries.length === 0) {
    return { error: 'invalid-fixture' }
  }
  const entries = []
  for (const entry of raw.entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.bytecode !== 'string') {
      return { error: 'invalid-fixture' }
    }
    let address = null
    if (entry.address !== undefined) {
      if (typeof entry.address !== 'string' || !isAddress(entry.address)) return { error: 'invalid-fixture' }
      address = getAddress(entry.address)
    }
    entries.push(entryReport(address, entry.bytecode))
  }
  return envelope('fixture', null, null, entries, 'unrun')
}

function envelope(mode, chainId, blockNumber, entries, liveReconciliation) {
  return Object.freeze({
    mode,
    inventoryOnly: true,
    g3Unblocked: false,
    acceptance: false,
    deploymentHealthy: false,
    liveReconciliation,
    chainId,
    blockNumber,
    entries,
  })
}

export function parseArgs(argv) {
  const out = { live: false, fixture: null, chain: 'ethereum-sepolia', addresses: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--live') out.live = true
    else if (arg === '--fixture') out.fixture = argv[++i]
    else if (arg === '--chain') out.chain = argv[++i]
    else if (arg === '--address') out.addresses.push(argv[++i])
    else return { error: 'unknown-arg' }
  }
  if (out.fixture === undefined || out.chain === undefined || out.addresses.includes(undefined)) {
    return { error: 'missing-value' }
  }
  if (out.live && out.fixture !== null) return { error: 'choose-fixture-or-live' }
  if (!out.live && out.fixture === null) return { error: 'missing-mode' }
  if (!out.live && out.addresses.length > 0) return { error: 'address-requires-live' }
  if (out.live && out.addresses.length === 0) return { error: 'live-requires-address' }
  if (out.live && !Object.hasOwn(PUBLIC_CHAINS, out.chain)) return { error: 'unknown-chain' }
  if (!out.live && out.chain !== 'ethereum-sepolia') return { error: 'chain-requires-live' }
  const addresses = []
  for (const address of out.addresses) {
    if (typeof address !== 'string' || !isAddress(address)) return { error: 'invalid-address' }
    addresses.push(getAddress(address))
  }
  return { ...out, addresses }
}

export async function defaultLiveReader(chainKey, addresses) {
  const spec = PUBLIC_CHAINS[chainKey]
  if (!spec) throw new Error('unknown-chain')
  const client = createPublicClient({
    chain: spec.chain,
    transport: http(spec.rpc, { timeout: 20_000 }),
  })
  const chainId = await client.getChainId()
  if (chainId !== spec.chainId) throw new Error('wrong-chain')
  const block = await client.getBlock({ blockTag: 'finalized' })
  if (typeof block?.number !== 'bigint') throw new Error('missing-block')
  const entries = []
  for (const address of addresses) {
    const bytecode = await client.getCode({ address, blockNumber: block.number })
    entries.push({ address, bytecode: typeof bytecode === 'string' ? bytecode : '0x' })
  }
  return { chainId, blockNumber: block.number.toString(), entries }
}

export async function main(argv, deps = {}) {
  const writeOut = deps.writeOut ?? ((text) => console.log(text))
  const writeErr = deps.writeErr ?? ((text) => console.error(text))
  const parsed = parseArgs(argv)
  if (parsed.error) {
    writeErr(`invalid arguments: ${parsed.error}`)
    return 2
  }
  if (!parsed.live) {
    let raw
    try {
      raw = JSON.parse(readFileSync(parsed.fixture, 'utf8'))
    } catch {
      writeErr('invalid fixture')
      return 2
    }
    const report = reportFixture(raw)
    if (report.error) {
      writeErr('invalid fixture')
      return 2
    }
    writeOut(JSON.stringify(report, null, 2))
    return report.entries.every((entry) => entry.healthy) ? 0 : 1
  }
  const liveReader = deps.liveReader ?? defaultLiveReader
  let observed
  try {
    observed = await liveReader(parsed.chain, parsed.addresses)
  } catch {
    writeErr('live read failed')
    return 2
  }
  const spec = PUBLIC_CHAINS[parsed.chain]
  if (!observed || observed.chainId !== spec.chainId || typeof observed.blockNumber !== 'string' ||
      !/^[0-9]+$/.test(observed.blockNumber) || !Array.isArray(observed.entries) ||
      observed.entries.length !== parsed.addresses.length) {
    writeErr('live read failed')
    return 2
  }
  const entries = []
  for (let i = 0; i < parsed.addresses.length; i++) {
    const row = observed.entries[i]
    if (!row || row.address !== parsed.addresses[i] || typeof row.bytecode !== 'string') {
      writeErr('live read failed')
      return 2
    }
    entries.push(entryReport(parsed.addresses[i], row.bytecode))
  }
  const report = envelope('live', observed.chainId, observed.blockNumber, entries, 'read')
  writeOut(JSON.stringify(report, null, 2))
  return entries.every((entry) => entry.healthy) ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
