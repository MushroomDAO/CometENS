#!/usr/bin/env node
// ENSv2 Sepolia finalized-RPC comparison; does not grant any chain authority.
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { createPublicClient, http, keccak256, toHex } from 'viem'
import { sepolia } from 'viem/chains'
import { inspectEnsv2 } from './inspect-ensv2-risk.mjs'

const VERSION = 'G2_ENSV2_FINALIZED_POLL_V1'
const SOURCE = 'ENSV2_SEPOLIA_RPC_OBSERVATION_ONLY'
const HEX32 = /^0x[0-9a-fA-F]{64}$/
const DECIMAL = /^(0|[1-9][0-9]*)$/
const BASE_FINDINGS = new Set([
  'APPROVAL_ENUMERATION_INCOMPLETE',
  'L1_RPC_NOT_CONSENSUS_PROOF',
  'UPGRADE_GOVERNANCE_NOT_EXHAUSTIVE',
])
const OBSERVED_FIELDS = [
  'registry', 'label', 'owner', 'status', 'expiry', 'resource',
  'rootRoles', 'scopedRoles', 'approvals', 'emancipated',
]
export class Ensv2MonitorFailure extends Error {
  constructor(code) { super(`ENSv2 Monitor unavailable: ${code}`); this.code = code; this.name = 'Ensv2MonitorFailure' }
}
const fail = (code) => { throw new Ensv2MonitorFailure(code) }
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()
const keys = (obj, names) => obj && typeof obj === 'object' && !Array.isArray(obj) &&
  Object.keys(obj).sort().join(',') === [...names].sort().join(',')
const isNumber = (v) => typeof v === 'string' && DECIMAL.test(v)
const digest = (data) => keccak256(toHex(JSON.stringify(data)))

function validatePrevious(previous, { name, manifestHash }) {
  if (previous == null) return null
  if (!keys(previous, ['version', 'source', 'chainId', 'name', 'manifestHash', 'block', 'visited', 'findings']) ||
      previous.version !== VERSION || previous.source !== SOURCE || previous.chainId !== 11155111 ||
      previous.name !== name || !same(previous.manifestHash, manifestHash) ||
      !keys(previous.block, ['number', 'hash', 'timestamp']) ||
      !isNumber(previous.block.number) || !isNumber(previous.block.timestamp) ||
      !HEX32.test(previous.block.hash) || !Array.isArray(previous.visited) ||
      previous.visited.length < 1 || previous.visited.length > 32 ||
      !Array.isArray(previous.findings) || previous.findings.length > 512 ||
      previous.findings.some((f) => !keys(f, ['code', 'context']) ||
        typeof f.code !== 'string' || f.code.length < 1 || f.code.length > 128 ||
        typeof f.context !== 'string' || f.context.length > 256)) fail('invalid-previous')
  for (const item of previous.visited) {
    if (!keys(item, OBSERVED_FIELDS) ||
        !/^0x[0-9a-fA-F]{40}$/.test(item.registry) ||
        !/^0x[0-9a-fA-F]{40}$/.test(item.owner) ||
        typeof item.label !== 'string' || item.label.length < 1 || item.label.length > 63 ||
        !Number.isInteger(item.status) || item.status < 0 || item.status > 2 ||
        !isNumber(item.expiry) || !isNumber(item.resource) ||
        typeof item.emancipated !== 'boolean' ||
        !item.rootRoles || typeof item.rootRoles !== 'object' ||
        !item.scopedRoles || typeof item.scopedRoles !== 'object' ||
        !Array.isArray(item.approvals)) fail('invalid-previous')
  }
  return previous
}

function changedPaths(before, after) {
  if (!before) return []
  const changes = []
  if (before.visited.length !== after.visited.length) changes.push('visited.length')
  for (let i = 0; i < Math.max(before.visited.length, after.visited.length); i++) {
    const left = before.visited[i]
    const right = after.visited[i]
    if (!left || !right) continue
    for (const field of OBSERVED_FIELDS) {
      const a = left[field]
      const b = right[field]
      if (typeof a === 'string' && typeof b === 'string' ? !same(a, b)
        : JSON.stringify(a) !== JSON.stringify(b)) changes.push(`visited[${i}].${field}`)
    }
  }
  if (digest(before.findings) !== digest(after.findings)) changes.push('findings')
  return changes
}

/** Fails on incomplete lineage/code verification, even when the inspector returned a finding. */
export async function monitorEnsv2L1({ client, manifest, previous = null }) {
  try {
    if (!client || !manifest || typeof manifest.name !== 'string') fail('invalid-input')
    const manifestHash = digest(manifest)
    const prior = validatePrevious(previous, { name: manifest.name, manifestHash })
    const evidence = await inspectEnsv2({ client, manifest })
    if (evidence.checkedAllAncestry !== true || evidence.name !== manifest.name ||
        evidence.chainId !== 11155111 || !Array.isArray(evidence.visited) ||
        evidence.visited.length < 1 || !Array.isArray(evidence.findings) ||
        !HEX32.test(evidence.finalized?.hash ?? '') ||
        !isNumber(evidence.finalized?.number) || !isNumber(evidence.finalized?.timestamp)) {
      fail('incomplete-finalized-source')
    }
    const height = BigInt(evidence.finalized.number)
    const block = await client.getBlock({ blockNumber: height })
    if (block.number !== height || !same(block.hash, evidence.finalized.hash) ||
        block.timestamp?.toString() !== evidence.finalized.timestamp) fail('unstable-finalized-block')
    const head = await client.getBlock({ blockTag: 'finalized' })
    if (typeof head.number !== 'bigint' || head.number < height ||
        (head.number === height && !same(head.hash, block.hash))) fail('unstable-finalized-block')
    if (prior && (height < BigInt(prior.block.number) ||
        (height === BigInt(prior.block.number) && !same(prior.block.hash, block.hash)))) {
      fail('finalized-conflict')
    }
    const now = {
      visited: evidence.visited,
      findings: evidence.findings,
    }
    const changes = changedPaths(prior, now)
    // Roles, owner, registries and approvals cannot change at one pinned block.
    // NAME_NOT_ACTIVE can appear when expiry crosses time with no new block.
    const staticFindings = (fs) => fs.filter(f => f.code !== 'NAME_NOT_ACTIVE')
    if (prior && height === BigInt(prior.block.number) &&
        (prior.block.timestamp !== evidence.finalized.timestamp ||
          changes.some((p) => p !== 'findings') ||
          digest(staticFindings(prior.findings)) !== digest(staticFindings(evidence.findings)))) {
      fail('finalized-conflict')
    }
    const atRisk = evidence.findings.some((f) => !BASE_FINDINGS.has(f.code))
    return {
      status: atRisk ? 'AT_RISK' : !prior ? 'BASELINE' : changes.length ? 'CHANGED' : 'UNCHANGED',
      changes, verdict: 'NEEDS_REVIEW', sovereignReceipt: false,
      opControllerAuthorityVerified: false, evidenceLevel: 'FINALIZED_RPC_OBSERVATION_ONLY',
      monitorCompleteness: 'POLLING_ONLY',
      cursor: { version: VERSION, source: SOURCE, chainId: 11155111,
        name: manifest.name, manifestHash, block: evidence.finalized,
        visited: evidence.visited, findings: evidence.findings },
    }
  } catch (error) {
    if (error instanceof Ensv2MonitorFailure) throw error
    // RPC/provider failures may embed access credentials.
    fail('unverifiable-source')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2)
    if (args.length !== 2 && args.length !== 4) fail('invalid-arguments')
    if (args[0] !== '--manifest' || (args.length === 4 && args[2] !== '--previous')) fail('invalid-arguments')
    const rpc = process.env.COMETENS_SEPOLIA_RPC_URL
    const url = rpc && new URL(rpc)
    if (!url || url.protocol !== 'https:' || url.username || url.password ||
        url.search || url.hash || url.pathname !== '/') fail('public-rpc-required')
    async function loadJson(path, maxBytes) {
      const raw = await readFile(path)
      if (raw.length > maxBytes) fail('oversized-input')
      return JSON.parse(raw.toString())
    }
    const manifest = await loadJson(args[1], 16384)
    const previous = args.length === 4 ? await loadJson(args[3], 131072) : null
    const result = await monitorEnsv2L1({
      client: createPublicClient({ chain: sepolia, transport: http(rpc) }), manifest, previous,
    })
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  } catch (error) {
    const code = error instanceof Ensv2MonitorFailure ? error.code : 'invalid-input-or-rpc'
    process.stderr.write(`G2 ENSv2 monitor unavailable (${code}); no L1/OP authority claim.\n`)
    process.exitCode = 2
  }
}
