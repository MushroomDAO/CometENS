#!/usr/bin/env node
/**
 * G2 legacy ENSv1 finalized-RPC polling observer. Never grants OP/L1 rights.
 * The Sepolia active ENSv2/EAC state is deliberately NOT inferred here.
 */
import { createPublicClient, http } from 'viem'
import { sepolia } from 'viem/chains'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { auditLegacyEnsV1 } from './audit-legacy-ensv1-authority.mjs'

const HEX32 = /^0x[0-9a-fA-F]{64}$/
const DECIMAL = /^(0|[1-9][0-9]*)$/
const VERSION = 'G2_LEGACY_ENSV1_POLL_V1'
const FIELDS = [
  'parentRegistryOwner', 'childRegistryOwner', 'parentWrappedHolder',
  'childWrappedHolder', 'parentExpiry', 'childExpiry', 'parentLocked',
  'childLocked', 'childEmancipated', 'observedLegacyFuseConditions',
]
// The audit derives lock booleans from wall-clock expiry, so those may change
// without a new block or an event. Raw state must not change under one block hash.
const RAW_FIELDS = FIELDS.slice(0, 6)
const ADDR = /^0x[0-9a-fA-F]{40}$/

export class MonitorFailure extends Error {
  constructor(code) { super(`G2 L1 monitor unavailable: ${code}`); this.code = code; this.name = 'MonitorFailure' }
}
const fail = (code) => { throw new MonitorFailure(code) }
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()
const decimal = (v) => typeof v === 'string' && DECIMAL.test(v)
const pin = (v) => typeof v === 'string' && HEX32.test(v) && !/^0x0+$/i.test(v)
const addressOrNull = (v) => v === null || (typeof v === 'string' && ADDR.test(v))
const keys = (value, names) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...names].sort().join(',')

function cleanPrevious(value, identity) {
  if (value == null) return null
  if (!keys(value, ['version', 'source', 'chainId', 'parentName', 'childName', 'pins', 'block', 'observed']) ||
      value.version !== VERSION || value.source !== 'LEGACY_ENSV1_SEPOLIA_RPC' || value.chainId !== 11155111 ||
      value.parentName !== identity.parentName || value.childName !== identity.childName ||
      !keys(value.pins, ['registry', 'wrapper']) ||
      !same(value.pins.registry, identity.expectedRegistryCodeHash) ||
      !same(value.pins.wrapper, identity.expectedWrapperCodeHash) ||
      !keys(value.block, ['number', 'hash', 'timestamp']) ||
      !decimal(value.block.number) || !decimal(value.block.timestamp) || !HEX32.test(value.block.hash) ||
      !keys(value.observed, FIELDS)) fail('invalid-previous')
  for (const field of FIELDS) {
    const v = value.observed[field]
    if (field.endsWith('Expiry')) {
      if (v !== null && !decimal(v)) fail('invalid-previous')
    } else if (field.endsWith('Owner') || field.endsWith('Holder')) {
      if (!addressOrNull(v)) fail('invalid-previous')
    } else if (typeof v !== 'boolean') fail('invalid-previous')
  }
  return value
}

function expiryRisk(observed, currentTime) {
  return !observed.parentLocked || !observed.childLocked ||
    !observed.childEmancipated || observed.parentExpiry === null || observed.childExpiry === null ||
    BigInt(observed.parentExpiry ?? '0') <= currentTime ||
    BigInt(observed.childExpiry ?? '0') <= currentTime
}

/**
 * Stateless finalized block reconciliation. The caller persists only result.cursor
 * and passes it back as previous on the next invocation. No writes or secrets.
 */
export async function monitorLegacyL1({
  client, parentName, childName, expectedRegistryCodeHash, expectedWrapperCodeHash,
  previous = null, now = () => BigInt(Math.floor(Date.now() / 1000)),
}) {
  if (!client || !pin(expectedRegistryCodeHash) || !pin(expectedWrapperCodeHash)) fail('invalid-input')
  const identity = { parentName, childName, expectedRegistryCodeHash, expectedWrapperCodeHash }
  const prior = cleanPrevious(previous, identity)
  try {
    const evidence = await auditLegacyEnsV1({ client, ...identity })
    const height = BigInt(evidence.blockNumber)
    const block = await client.getBlock({ blockNumber: height })
    if (!HEX32.test(block?.hash ?? '') || block.number !== height ||
        block.timestamp?.toString() !== evidence.blockTimestamp) fail('unstable-finalized-block')
    // Guard an RPC changing a once-finalized block or returning a rollback.
    if (prior && (height < BigInt(prior.block.number) ||
        (height === BigInt(prior.block.number) && !same(block.hash, prior.block.hash)))) {
      fail('finalized-conflict')
    }
    if (prior && height > BigInt(prior.block.number)) {
      // Check the previously claimed finalized ancestor before advancing the cursor.
      // A single RPC is still an observation, not an independent consensus proof.
      const ancestor = await client.getBlock({ blockNumber: BigInt(prior.block.number) })
      if (ancestor?.number !== BigInt(prior.block.number) ||
          !same(ancestor.hash, prior.block.hash) ||
          ancestor.timestamp?.toString() !== prior.block.timestamp) fail('finalized-conflict')
    }
    const finalizedAgain = await client.getBlock({ blockTag: 'finalized' })
    if (typeof finalizedAgain.number !== 'bigint' || finalizedAgain.number < height ||
        (finalizedAgain.number === height && !same(finalizedAgain.hash, block.hash))) {
      fail('unstable-finalized-block')
    }
    const observed = Object.fromEntries(FIELDS.map((key) => [key, evidence[key]]))
    const changedFields = prior ? FIELDS.filter((key) =>
      typeof observed[key] === 'string' && typeof prior.observed[key] === 'string'
        ? !same(observed[key], prior.observed[key])
        : observed[key] !== prior.observed[key]) : []
    if (prior && height === BigInt(prior.block.number) &&
        (prior.block.timestamp !== evidence.blockTimestamp ||
          changedFields.some((field) => RAW_FIELDS.includes(field)))) fail('finalized-conflict')
    const unsafe = expiryRisk(observed, now())
    const cursor = {
      version: VERSION, source: 'LEGACY_ENSV1_SEPOLIA_RPC', chainId: 11155111,
      parentName, childName,
      pins: { registry: expectedRegistryCodeHash.toLowerCase(), wrapper: expectedWrapperCodeHash.toLowerCase() },
      block: { number: evidence.blockNumber, hash: block.hash, timestamp: evidence.blockTimestamp },
      observed,
    }
    return {
      status: unsafe ? 'AT_RISK' : !prior ? 'BASELINE' : changedFields.length ? 'CHANGED' : 'UNCHANGED',
      changedFields, cursor,
      evidenceLevel: 'FINALIZED_RPC_OBSERVATION_ONLY',
      ensV2AuthorityVerified: false, opControllerAuthorityVerified: false, sovereignReceipt: false,
      // Sampling can miss A->B->A or changes after the block; no instant revocation.
      enablesNativeIssuance: false, monitorCompleteness: 'POLLING_ONLY',
    }
  } catch (error) {
    if (error instanceof MonitorFailure) throw error
    // No upstream/RPC text, URL, credentials or provider bodies leave this boundary.
    fail('unverifiable-source')
  }
}

/**
 * The executable CLI uses exactly this runner. Injectable read/client allow an
 * offline CLI-to-BASELINE test without a live RPC or additional test-only flags.
 */
export async function runLegacyMonitorCommand({
  args, rpc, loadPrevious = readFile,
  makeClient = (url) => createPublicClient({ chain: sepolia, transport: http(url) }),
}) {
  const mandatory = ['--mode', '--parent', '--child', '--registry-codehash', '--wrapper-codehash']
  if (!Array.isArray(args) || (args.length !== 10 && args.length !== 12)) fail('invalid-arguments')
  const parsed = new Map()
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]
    const value = args[i + 1]
    if (![...mandatory, '--previous'].includes(flag) || parsed.has(flag) ||
        typeof value !== 'string' || !value || value.startsWith('--')) fail('invalid-arguments')
    parsed.set(flag, value)
  }
  if (!mandatory.every(flag => parsed.has(flag)) ||
      parsed.size !== mandatory.length + Number(parsed.has('--previous'))) fail('invalid-arguments')
  if (parsed.get('--mode') !== 'legacy-ensv1-sepolia') fail('invalid-mode')
  let url
  try { url = new URL(rpc) } catch { fail('public-rpc-required') }
  if (url.protocol !== 'https:' || url.username || url.password ||
      url.search || url.hash || url.pathname !== '/') fail('public-rpc-required')
  let previous = null
  if (parsed.has('--previous')) {
    let raw
    try { raw = await loadPrevious(parsed.get('--previous')) } catch { fail('invalid-previous') }
    if (!raw || raw.length === 0 || raw.length > 8192) fail('invalid-previous')
    try { previous = JSON.parse(raw.toString()) } catch { fail('invalid-previous') }
    if (previous == null) fail('invalid-previous')
  }
  return monitorLegacyL1({
    client: makeClient(rpc), parentName: parsed.get('--parent'), childName: parsed.get('--child'),
    expectedRegistryCodeHash: parsed.get('--registry-codehash'),
    expectedWrapperCodeHash: parsed.get('--wrapper-codehash'), previous,
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await runLegacyMonitorCommand({
      args: process.argv.slice(2), rpc: process.env.COMETENS_PUBLIC_SEPOLIA_RPC,
    })
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  } catch (error) {
    const code = error instanceof MonitorFailure ? error.code : 'invalid-input-or-rpc'
    process.stderr.write(`G2 legacy L1 monitor unavailable (${code}); no OP/L1 authorization claim.\n`)
    process.exitCode = 2
  }
}
