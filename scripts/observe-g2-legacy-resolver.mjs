#!/usr/bin/env node
// One finalized ENSv1 L1 snapshot and lock-event provenance; no permanence claim.
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import {
  createPublicClient, http, isAddress, keccak256, namehash,
  encodeAbiParameters, parseAbiParameters, decodeEventLog, parseAbiItem,
} from 'viem'
import { sepolia } from 'viem/chains'

export const ENS = Object.freeze({
  registry: '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e',
  wrapper: '0x0635513f179D50A207757E05759CbD106d7dFcE8',
  registrar: '0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85',
})
const abi = (name, inputs = [], outputs = ['address']) => [{
  type: 'function', name, stateMutability: 'view',
  inputs: inputs.map((type) => ({ type })), outputs: outputs.map((type) => ({ type })),
}]
const lockEvent = parseAbiItem('event MemberRecordsLocked(bytes32 indexed node,address indexed member,bytes32 recordCommitment)')
const hash32 = (x) => typeof x === 'string' && /^0x[0-9a-fA-F]{64}$/.test(x)
const hexBytes = (x) => typeof x === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(x)
const low = (x) => typeof x === 'string' ? x.toLowerCase() : fail('invalid-rpc-response')
const fail = (kind) => { const error = new Error(kind); error.kind = kind; throw error }
const bigint = (x) => {
  if (typeof x === 'bigint' && x >= 0n) return x
  if (typeof x === 'number' && Number.isSafeInteger(x) && x >= 0) return BigInt(x)
  if (typeof x === 'string' && /^0x[0-9a-fA-F]+$/.test(x)) return BigInt(x)
  fail('invalid-rpc-response')
}
const same = (a, b) => low(a) === low(b)
const label = (s) => typeof s === 'string' && s.length > 0 && s.length <= 63 &&
  !s.startsWith('-') && !s.endsWith('-') && !/^(?:..)--/.test(s) && /^[a-z0-9-]+$/.test(s)
const keys = (p, expected) => p && typeof p === 'object' && !Array.isArray(p) &&
  Object.keys(p).sort().join(',') === expected.split(',').sort().join(',')
const snapshot = (p, expected) => {
  if (!keys(p, expected)) fail('invalid-profile')
  const descriptors = Object.getOwnPropertyDescriptors(p)
  if (Object.values(descriptors).some((d) => !Object.hasOwn(d, 'value'))) fail('invalid-profile')
  return Object.freeze(Object.fromEntries(Object.entries(descriptors).map(([k, d]) => [k, d.value])))
}
const json = (value) => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2)

function validateProfile(raw) {
  const p = snapshot(raw, 'chainId,contract,parentName,childLabel,expectedHolder,expectedLockedBy,lockTransactionHash,codehashes,records')
  const codehashes = snapshot(p.codehashes, 'store,registry,wrapper,registrar')
  const records = snapshot(p.records, 'addr,contenthash,textKey,textValue')
  if (p.chainId !== 11155111 || !label(p.childLabel) || typeof p.parentName !== 'string' ||
      !p.parentName.endsWith('.eth') || !label(p.parentName.slice(0, -4)) ||
      ![p.contract, p.expectedHolder, p.expectedLockedBy].every((v) => isAddress(v, { strict: true })) ||
      !hash32(p.lockTransactionHash) || !Object.values(codehashes).every((v) => hash32(v) && !/^0x0+$/.test(v)) ||
      !isAddress(records.addr, { strict: true }) || !hexBytes(records.contenthash) ||
      records.contenthash.length > 1026 || typeof records.textKey !== 'string' ||
      records.textKey.length === 0 || records.textKey.length > 256 ||
      typeof records.textValue !== 'string' || records.textValue.length > 4096) fail('invalid-profile')
  const parentNode = namehash(p.parentName)
  const childNode = namehash(`${p.childLabel}.${p.parentName}`)
  const parentLabelId = BigInt(keccak256(`0x${Buffer.from(p.parentName.slice(0, -4)).toString('hex')}`))
  const recordCommitment = keccak256(encodeAbiParameters(
    parseAbiParameters('bytes32,address,bytes,string,string'),
    [childNode, records.addr, records.contenthash, records.textKey, records.textValue],
  ))
  return Object.freeze({ ...p, codehashes, records, parentNode, childNode, parentLabelId, recordCommitment })
}

export async function observeLegacyResolver(client, input) {
  const p = validateProfile(input) // identity snapshots happen before the first await
  if (await client.getChainId() !== 11155111) fail('wrong-chain')
  const finalized = await client.getBlock({ blockTag: 'finalized' })
  const height = bigint(finalized.number)
  if (!hash32(finalized.hash) || bigint(finalized.timestamp) === 0n) fail('invalid-finalized-block')
  const read = (address, name, types, out, args = []) => client.readContract({
    address, abi: abi(name, types, out), functionName: name, args, blockNumber: height,
  })
  const codePin = async (address, hash) => {
    const bytecode = await client.getCode({ address, blockNumber: height })
    if (!bytecode || bytecode === '0x' || !same(keccak256(bytecode), hash)) fail('codehash-mismatch')
  }
  for (const [address, hash] of [
    [p.contract, p.codehashes.store], [ENS.registry, p.codehashes.registry],
    [ENS.wrapper, p.codehashes.wrapper], [ENS.registrar, p.codehashes.registrar],
  ]) await codePin(address, hash)
  if (!same(await read(p.contract, 'parentNode', [], ['bytes32']), p.parentNode) ||
      !same(await read(p.contract, 'node', [], ['bytes32']), p.childNode) ||
      bigint(await read(p.contract, 'parentLabelId', [], ['uint256'])) !== p.parentLabelId ||
      !same(await read(p.contract, 'registryCodeHash', [], ['bytes32']), p.codehashes.registry) ||
      !same(await read(p.contract, 'wrapperCodeHash', [], ['bytes32']), p.codehashes.wrapper) ||
      !same(await read(p.contract, 'registrarCodeHash', [], ['bytes32']), p.codehashes.registrar)) fail('store-identity-mismatch')
  const registryOwner = (node) => read(ENS.registry, 'owner', ['bytes32'], ['address'], [node])
  if (!same(await read(ENS.registry, 'resolver', ['bytes32'], ['address'], [p.childNode]), p.contract)) fail('resolver-pointer-mismatch')
  if (!same(await registryOwner(p.parentNode), ENS.wrapper) ||
      !same(await registryOwner(p.childNode), ENS.wrapper) ||
      !same(await read(ENS.registrar, 'ownerOf', ['uint256'], ['address'], [p.parentLabelId]), ENS.wrapper)) fail('native-custody-mismatch')
  const getData = (node) => read(ENS.wrapper, 'getData', ['uint256'], ['address', 'uint32', 'uint64'], [BigInt(node)])
  const parent = await getData(p.parentNode)
  const child = await getData(p.childNode)
  const holder = await read(ENS.wrapper, 'ownerOf', ['uint256'], ['address'], [BigInt(p.childNode)])
  const registrarExpiry = bigint(await read(ENS.registrar, 'nameExpires', ['uint256'], ['uint256'], [p.parentLabelId]))
  const margin = bigint(finalized.timestamp) + 86400n
  if (!same(child[0], p.expectedHolder) || !same(holder, p.expectedHolder) ||
      !isAddress(parent[0]) || same(parent[0], '0x0000000000000000000000000000000000000000') ||
      (bigint(parent[1]) & 1n) === 0n || (bigint(child[1]) & 65537n) !== 65537n ||
      bigint(parent[2]) <= margin || bigint(child[2]) <= margin || registrarExpiry <= margin ||
      bigint(child[2]) > bigint(parent[2]) || bigint(child[2]) + 86400n > registrarExpiry) fail('holder-fuses-or-expiry-mismatch')
  if (await read(p.contract, 'locked', [], ['bool']) !== true ||
      !same(await read(p.contract, 'lockedBy', [], ['address']), p.expectedLockedBy) ||
      !same(await read(p.contract, 'recordCommitment', [], ['bytes32']), p.recordCommitment)) fail('lock-state-mismatch')
  const [addr, contenthash, text] = await Promise.all([
    read(p.contract, 'addr', ['bytes32'], ['address'], [p.childNode]),
    read(p.contract, 'contenthash', ['bytes32'], ['bytes'], [p.childNode]),
    read(p.contract, 'text', ['bytes32', 'string'], ['string'], [p.childNode, p.records.textKey]),
  ])
  if (!same(addr, p.records.addr) || !same(contenthash, p.records.contenthash) || text !== p.records.textValue) fail('served-record-mismatch')

  const receipt = await client.getTransactionReceipt({ hash: p.lockTransactionHash })
  if (!receipt || receipt.status !== 'success' || !same(receipt.transactionHash, p.lockTransactionHash) ||
      bigint(receipt.blockNumber) > height || !hash32(receipt.blockHash) || !Array.isArray(receipt.logs)) fail('invalid-lock-receipt')
  const lockBlock = await client.getBlock({ blockNumber: bigint(receipt.blockNumber) })
  if (!same(lockBlock.hash, receipt.blockHash) || bigint(lockBlock.number) !== bigint(receipt.blockNumber)) fail('invalid-lock-block')
  if (!Array.isArray(lockBlock.transactions) || !lockBlock.transactions.some((tx) =>
    same(typeof tx === 'string' ? tx : tx.hash, p.lockTransactionHash))) fail('lock-transaction-not-in-block')
  const historicalCode = await client.getCode({ address: p.contract, blockNumber: bigint(receipt.blockNumber) })
  if (!historicalCode || !same(keccak256(historicalCode), p.codehashes.store)) fail('historical-codehash-mismatch')
  let matches = 0
  for (const log of receipt.logs) {
    if (!same(log.address, p.contract)) continue
    if (!same(log.blockHash, receipt.blockHash) || !same(log.transactionHash, receipt.transactionHash) ||
        bigint(log.blockNumber) !== bigint(receipt.blockNumber) || log.removed === true) fail('invalid-lock-log')
    let decoded
    try { decoded = decodeEventLog({ abi: [lockEvent], data: log.data, topics: log.topics, strict: true }) }
    catch { continue }
    if (!same(decoded.args.node, p.childNode) || !same(decoded.args.member, p.expectedLockedBy) ||
        !same(decoded.args.recordCommitment, p.recordCommitment)) fail('lock-event-mismatch')
    matches++
  }
  if (matches !== 1) fail('missing-or-duplicate-lock-event')
  const again = await client.getBlock({ blockNumber: height })
  if (!same(again.hash, finalized.hash) || bigint(again.number) !== height ||
      await client.getChainId() !== 11155111 ||
      bigint((await client.getBlock({ blockTag: 'finalized' })).number) < height) fail('block-drift')
  return {
    chainId: 11155111, blockNumber: height, blockHash: finalized.hash, blockTimestamp: finalized.timestamp,
    parentNode: p.parentNode, childNode: p.childNode, contract: p.contract,
    resolverPointerMatches: true, codehashMatches: true, locked: true,
    historicalLockedBy: p.expectedLockedBy, currentWrappedHolder: p.expectedHolder,
    recordCommitment: p.recordCommitment, records: p.records,
    lockEvent: { transactionHash: p.lockTransactionHash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash },
    observedFinalizedLegacyV1Only: true, independentlyVerifiedConsensus: false,
    ensV2AuthorityVerified: false, approvalInventoryExhaustive: false,
    nativeResolverPointerLockedVerified: false, sovereignReceipt: false, lockedRecordVerified: false,
    warning: 'Single-RPC finalized-block observation; ENSv1 resolver may be repointed; no ENSv2/migration, approvals, upgrade or permanent record-lock assurance.',
  }
}

export async function runLegacyResolverObservation(args, options = {}) {
  const values = args[0] === '--' ? args.slice(1) : args
  if (values.length !== 2 || values[0] !== '--profile') fail('usage')
  const raw = await readFile(values[1])
  if (raw.byteLength > 8192) fail('profile-too-large')
  let profile
  try { profile = JSON.parse(raw.toString()) } catch { fail('invalid-profile') }
  validateProfile(profile)
  const rpc = options.rpcUrl ?? process.env.COMETENS_L1_SEPOLIA_RPC_URL
  if (!options.client) {
    let url
    try { url = new URL(rpc) } catch { fail('invalid-rpc') }
    if (url.username || url.password || (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) fail('invalid-rpc')
  }
  const client = options.client ?? createPublicClient({ chain: sepolia, transport: http(rpc, { retryCount: 0, timeout: 15_000 }) })
  return json(await observeLegacyResolver(client, profile))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length <= 2 || process.argv.includes('--help')) {
    process.stdout.write('Usage: node scripts/observe-g2-legacy-resolver.mjs --profile ./legacy-observation.json\nUse COMETENS_L1_SEPOLIA_RPC_URL (HTTPS/loopback). Read-only ENSv1 observation; no SOVEREIGN/LOCKED_RECORD proof.\n')
  } else runLegacyResolverObservation(process.argv.slice(2)).then((v) => process.stdout.write(`${v}\n`)).catch((err) => {
    process.stderr.write(`Legacy resolver observation failed (${err?.kind ?? 'unavailable'}).\n`)
    process.exitCode = 1
  })
}
