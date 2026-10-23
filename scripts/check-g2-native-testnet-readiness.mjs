#!/usr/bin/env node
// G2 native-first deployment DRY RUN. No keys, signing, broadcast or green release flag.
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { isAddress, keccak256, namehash, parseAbi, toHex } from 'viem'

const L1 = 11155111
const OP = 11155420
const OP_MESSENGER = '0x4200000000000000000000000000000000000007'
const ZERO = '0x0000000000000000000000000000000000000000'
const HASH = /^0x[0-9a-fA-F]{64}$/
const VERSION = keccak256(toHex('COMETENS_G2_NATIVE_RESULT_V1'))
const ABI = parseAbi([
  'function parentNode() view returns (bytes32)',
  'function destinationInbox() view returns (address)',
  'function nativeSource() view returns (address)',
  'function sourceRuntimeHash() view returns (bytes32)',
  'function l1Messenger() view returns (address)',
  'function messengerRuntimeHash() view returns (bytes32)',
  'function registryRuntimeHash() view returns (bytes32)',
  'function wrapperRuntimeHash() view returns (bytes32)',
  'function registrarRuntimeHash() view returns (bytes32)',
  'function l1ResultEmitter() view returns (address)',
  'function currentAuthority() view returns (address,uint64)',
  'function SOURCE_CHAIN_ID() view returns (uint256)',
  'function L1_CHAIN_ID() view returns (uint256)',
  'function OP_CHAIN_ID() view returns (uint256)',
  'function MESSAGE_VERSION() view returns (bytes32)',
  'function VERSION() view returns (bytes32)',
  'function sovereignReceipt() view returns (bool)',
])
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()
const goodAddress = (value) => isAddress(value ?? '', { strict: true }) && !same(value, ZERO)
const goodHash = (v) => typeof v === 'string' && HASH.test(v) && !/^0x0+$/i.test(v)
const label = (s) => typeof s === 'string' && s.length > 0 && s.length <= 63 &&
  /^[a-z0-9-]+$/.test(s) && s[0] !== '-' && !s.endsWith('-') &&
  !(s.length >= 4 && s[2] === '-' && s[3] === '-')
const contractNames = ['source', 'relay', 'inbox', 'l1Messenger', 'opMessenger', 'registry', 'wrapper', 'registrar']
const dataObject = (raw, names) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('invalid-manifest')
  const d = Object.getOwnPropertyDescriptors(raw)
  if (Object.keys(d).sort().join(',') !== [...names].sort().join(',') ||
      Object.values(d).some(v => !Object.hasOwn(v, 'value'))) throw Error('invalid-manifest')
  return Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v.value]))
}
const canonical = { registry: '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e',
  wrapper: '0x0635513f179D50A207757E05759CbD106d7dFcE8',
  registrar: '0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85',
  opMessenger: OP_MESSENGER }
const constructors = Object.freeze({
  source: ['string','address','bytes32','bytes32','bytes32'],
  relay: ['address','bytes32','bytes32','address','bytes32','address'],
  inbox: ['bytes32','address'],
})
const artifactNames = Object.freeze({
  source: 'LegacyL1AuthorityCheckpoint', relay: 'G2LegacyL1NativeResultRelay',
  inbox: 'G2NativeIssueResultInbox',
})

function parseManifest(raw) {
  const m = dataObject(raw, ['community','contracts','deployPlan','networks','version'])
  const networks = dataObject(m.networks, ['l1ChainId','opChainId'])
  const community = dataObject(m.community, ['expectedHolder','parentName'])
  const plan = dataObject(m.deployPlan, ['addressPredictionReviewed','contractsApproved','targetDomainReviewed'])
  const pins = dataObject(m.contracts, contractNames)
  if (m.version !== 1 || networks.l1ChainId !== L1 || networks.opChainId !== OP) throw Error('invalid-manifest')
  // Reject all unknown keys, including key/signer fields; never inspect environment secrets.
  const parentName = community.parentName
  const components = typeof parentName === 'string' ? parentName.split('.') : []
  if (components.length !== 2 || components[1] !== 'eth' || !label(components[0]) ||
      !goodAddress(community.expectedHolder) ||
      Object.values(plan).some(v => typeof v !== 'boolean')) throw Error('invalid-manifest')
  const contracts = {}
  for (const kind of contractNames) {
    const item = dataObject(pins[kind], ['address','expectedRuntimeHash'])
    if (!goodAddress(item.address) || !goodHash(item.expectedRuntimeHash) ||
        (canonical[kind] && !same(item.address, canonical[kind]))) throw Error('invalid-contract-pin')
    contracts[kind] = Object.freeze({ address: item.address, expectedRuntimeHash: item.expectedRuntimeHash })
  }
  if (same(contracts.source.address,contracts.relay.address) ||
      same(contracts.relay.address,contracts.inbox.address) ||
      same(contracts.source.address,contracts.inbox.address)) throw Error('colliding-deployment-address')
  return Object.freeze({ parentName, parentNode: namehash(parentName),
    expectedHolder: community.expectedHolder, contracts: Object.freeze(contracts),
    plan: Object.freeze(plan) })
}

export async function checkG2NativeReadiness(raw, options = {}) {
  const blockers = []
  const result = { status:'BLOCKED', dryRunOnly:true, broadcasts:false, signatures:false,
    liveSignerUsed:false, nativeAuthorityVerified:false, ensV2AuthorityVerified:false,
    opGrantsNativeRights:false, sovereignReceipt:false, readyToBroadcast:false, blockers }
  let p
  try { p = parseManifest(raw) } catch (err) {
    blockers.push(err.message === 'invalid-contract-pin' || err.message === 'colliding-deployment-address' ? err.message : 'invalid-manifest')
    return result
  }
  result.parentNode = p.parentNode
  result.chainIds = { l1:L1, op:OP }
  for (const [field, allowed] of Object.entries({targetDomainReviewed:p.plan.targetDomainReviewed,
    contractsApproved:p.plan.contractsApproved,addressPredictionReviewed:p.plan.addressPredictionReviewed})) {
    if (!allowed) blockers.push(`${field}-not-approved`)
  }
  // Local fixture bytecode is NOT a deployed immutable runtime hash. Constructor
  // wiring is checked independently of Forge `out/` and signer configuration.
  for (const [kind, types] of Object.entries(constructors)) {
    const a = options.artifacts?.[kind]
    const ctor = a?.abi?.find(x => x.type === 'constructor')
    if (!ctor || !Array.isArray(ctor.inputs) || ctor.inputs.map(x => x.type).join(',') !== types.join(',') ||
        typeof a.bytecode?.object !== 'string' || !/^0x[0-9a-fA-F]+$/.test(a.bytecode.object)) {
      blockers.push(`missing-or-drifted-${kind}-creation-artifact`)
    }
  }
  // RPC inspection is opt-in, strictly public-client reads, and never enough
  // to lift the overall BLOCKED result or prove native ENSv2/EAC authority.
  const {l1Client,opClient} = options
  if (!l1Client || !opClient || l1Client === opClient) {
    blockers.push('missing-independent-read-only-l1-op-observations')
    return result
  }
  try {
    if (await l1Client.getChainId() !== L1 || await opClient.getChainId() !== OP) throw Error('wrong-chain')
    const [l1Head,opHead] = await Promise.all([
      l1Client.getBlock({blockTag:'finalized'}),opClient.getBlock({blockTag:'finalized'}),
    ])
    for (const head of [l1Head,opHead]) if (typeof head?.number !== 'bigint' ||
        typeof head.timestamp !== 'bigint' || !goodHash(head.hash)) throw Error('invalid-finalized-head')
    const getCode = async (client,kind,height) => {
      const entry = p.contracts[kind]
      const code = await client.getBytecode({address:entry.address,blockNumber:height})
      if (!code || code === '0x' || !same(keccak256(code),entry.expectedRuntimeHash)) throw Error('codehash-mismatch')
    }
    for (const kind of ['source','relay','l1Messenger','registry','wrapper','registrar']) await getCode(l1Client,kind,l1Head.number)
    for (const kind of ['inbox','opMessenger']) await getCode(opClient,kind,opHead.number)
    const read = (client,kind,fn,height) => client.readContract({
      address:p.contracts[kind].address,abi:ABI,functionName:fn,blockNumber:height,
    })
    const compare = async (client,kind,fn,height,expected) => {
      const actual = await read(client,kind,fn,height)
      if (typeof expected === 'bigint' ? BigInt(actual) !== expected :
          typeof expected === 'boolean' ? actual !== expected : !same(actual,expected)) throw Error('immutable-wiring-mismatch')
    }
    const A=p.contracts
    await compare(l1Client,'source','parentNode',l1Head.number,p.parentNode)
    await compare(l1Client,'source','destinationInbox',l1Head.number,A.inbox.address)
    await compare(l1Client,'source','SOURCE_CHAIN_ID',l1Head.number,BigInt(L1))
    for (const [fn,kind] of [['registryRuntimeHash','registry'],['wrapperRuntimeHash','wrapper'],['registrarRuntimeHash','registrar']]) {
      await compare(l1Client,'source',fn,l1Head.number,A[kind].expectedRuntimeHash)
    }
    await compare(l1Client,'relay','parentNode',l1Head.number,p.parentNode)
    await compare(l1Client,'relay','nativeSource',l1Head.number,A.source.address)
    await compare(l1Client,'relay','sourceRuntimeHash',l1Head.number,A.source.expectedRuntimeHash)
    await compare(l1Client,'relay','destinationInbox',l1Head.number,A.inbox.address)
    await compare(l1Client,'relay','l1Messenger',l1Head.number,A.l1Messenger.address)
    await compare(l1Client,'relay','messengerRuntimeHash',l1Head.number,A.l1Messenger.expectedRuntimeHash)
    await compare(l1Client,'relay','MESSAGE_VERSION',l1Head.number,VERSION)
    await compare(l1Client,'relay','L1_CHAIN_ID',l1Head.number,BigInt(L1))
    await compare(l1Client,'relay','OP_CHAIN_ID',l1Head.number,BigInt(OP))
    await compare(opClient,'inbox','parentNode',opHead.number,p.parentNode)
    await compare(opClient,'inbox','l1ResultEmitter',opHead.number,A.relay.address)
    await compare(opClient,'inbox','VERSION',opHead.number,VERSION)
    await compare(opClient,'inbox','sovereignReceipt',opHead.number,false)
    const [holder,expires]=await l1Client.readContract({address:A.source.address,
      abi:ABI,functionName:'currentAuthority',blockNumber:l1Head.number})
    if (!same(holder,p.expectedHolder) || BigInt(expires) <= l1Head.timestamp + 86400n) throw Error('native-holder-or-expiry-unverified')
    if (await l1Client.getChainId() !== L1 || await opClient.getChainId() !== OP) throw Error('chain-drift')
    for (const [client,old] of [[l1Client,l1Head],[opClient,opHead]]) {
      const newer = await client.getBlock({blockTag:'finalized'})
      const original = await client.getBlock({blockNumber:old.number})
      if (newer.number < old.number || (newer.number === old.number && !same(newer.hash,old.hash)) ||
          original.number !== old.number || !same(original.hash,old.hash)) throw Error('finality-drift')
    }
    result.historicalLegacyPinsMatched = true
    blockers.push('rpc-snapshot-not-current-execution-time-authority')
  } catch {
    blockers.push('unverified-read-only-chain-wiring-or-authority')
  }
  blockers.push('live-contract-review-and-community-native-ensv2-signoff-required')
  return result
}

export async function runG2Readiness(argv) {
  if (argv.length !== 2 || argv[0] !== '--manifest') throw Error('usage')
  const raw = await readFile(argv[1])
  if (raw.byteLength > 16384) throw Error('oversize-manifest')
  const manifest = JSON.parse(raw.toString('utf8'))
  const artifactRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'contracts', 'out')
  const artifacts = {}
  for (const [kind, name] of Object.entries(artifactNames)) {
    try { artifacts[kind] = JSON.parse(await readFile(join(artifactRoot, `${name}.sol`, `${name}.json`), 'utf8')) }
    catch { /* Missing/invalid pinned local creation artifact fails closed below. */ }
  }
  // Never source .env.local, parse private key values, create a wallet client,
  // derive an EOA address, call `forge script`, or accept a broadcast option.
  return checkG2NativeReadiness(manifest, { artifacts })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--help') || process.argv.length === 2) {
    process.stdout.write('Usage: node scripts/check-g2-native-testnet-readiness.mjs --manifest ./g2-local-readiness.json\nOffline only, always BLOCKED. No keys, RPC requests, signing or broadcast.\n')
  } else runG2Readiness(process.argv.slice(2)).then(x => {
    process.stdout.write(`${JSON.stringify(x,null,2)}\n`)
    process.exitCode = 1 // readiness is deliberately NOT an execution approval
  }).catch(() => {
    process.stderr.write('G2 readiness denied (invalid-input-or-unavailable).\n')
    process.exitCode = 1
  })
}
