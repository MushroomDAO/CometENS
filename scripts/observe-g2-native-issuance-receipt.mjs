/**
 * Read-only legacy ENSv1 L1 issuance receipt observation. It is neither an
 * authenticated L1→OP messenger nor a current-native-authority certificate.
 */
import {
  decodeEventLog, encodePacked, isAddress, keccak256, namehash, parseAbi, parseAbiItem, toEventSelector, toHex,
} from 'viem'

const CHAIN_ID = 11155111
const REGISTRY = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e'
const WRAPPER = '0x0635513f179D50A207757E05759CbD106d7dFcE8'
const ZERO = '0x0000000000000000000000000000000000000000'
const HASH = /^0x[0-9a-fA-F]{64}$/
const DECIMAL = /^(0|[1-9][0-9]*)$/
const EVENT = parseAbiItem('event NativeChildIssued(bytes32 indexed node, address indexed member, uint64 expiry)')
const TOPIC0 = toEventSelector(EVENT)
const ISSUER_ABI = parseAbi([
  'function parentNode() view returns (bytes32)',
  'function ENS_REGISTRY() view returns (address)',
  'function NAME_WRAPPER() view returns (address)',
])
const REGISTRY_ABI = parseAbi(['function owner(bytes32 node) view returns (address)'])
const WRAPPER_ABI = parseAbi([
  'function getData(uint256 id) view returns (address owner, uint32 fuses, uint64 expiry)',
  'function ownerOf(uint256 id) view returns (address)',
])
const CU = 1n
const PCC = 1n << 16n
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()
const pin = (v) => HASH.test(v ?? '') && !/^0x0+$/i.test(v)
const label = (v) => typeof v === 'string' && v.length >= 1 && v.length <= 63 &&
  /^[a-z0-9-]+$/.test(v) && v[0] !== '-' && !v.endsWith('-') &&
  !(v.length >= 4 && v[2] === '-' && v[3] === '-')

export class NativeReceiptFailure extends Error {
  constructor(code) { super(`Native issuance receipt observation refused: ${code}`); this.code = code }
}
const fail = (code) => { throw new NativeReceiptFailure(code) }

function validateProfile(raw) {
  const required = [
    'chainId', 'issuer', 'issuerCodeHash', 'registryCodeHash', 'wrapperCodeHash',
    'parentName', 'childLabel', 'member', 'expiry', 'transactionHash',
  ]
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      Object.keys(raw).sort().join(',') !== required.sort().join(',') ||
      Object.values(Object.getOwnPropertyDescriptors(raw)).some(d => !Object.hasOwn(d, 'value'))) fail('invalid-profile')
  const p = Object.fromEntries(required.map(k => [k, raw[k]]))
  const parts = typeof p.parentName === 'string' ? p.parentName.split('.') : []
  if (p.chainId !== CHAIN_ID || !isAddress(p.issuer, { strict: true }) ||
      same(p.issuer, ZERO) || !isAddress(p.member, { strict: true }) ||
      same(p.member, ZERO) || ![p.issuerCodeHash, p.registryCodeHash, p.wrapperCodeHash].every(pin) ||
      !HASH.test(p.transactionHash ?? '') || typeof p.expiry !== 'string' ||
      p.expiry.length > 20 || !DECIMAL.test(p.expiry) ||
      !parts.length || parts.length > 10 || p.parentName.length > 255 ||
      parts.at(-1) !== 'eth' || !parts.every(label) || !label(p.childLabel) ||
      BigInt(p.expiry) > (1n << 64n) - 1n) fail('invalid-profile')
  const parentNode = namehash(p.parentName)
  const node = keccak256(encodePacked(['bytes32', 'bytes32'], [parentNode, keccak256(toHex(p.childLabel))]))
  return { ...p, parentNode, node }
}

/** Recheck a successful *historical* L1 transaction at a finalized RPC block. */
export async function observeNativeIssueReceipt({ client, profile }) {
  const p = validateProfile(profile)
  if (!client) fail('invalid-client')
  try {
    if (await client.getChainId() !== CHAIN_ID) fail('wrong-chain')
    const finalized = await client.getBlock({ blockTag: 'finalized' })
    if (typeof finalized?.number !== 'bigint' || typeof finalized?.timestamp !== 'bigint' ||
        !HASH.test(finalized?.hash ?? '')) fail('invalid-finalized-block')
    const now = BigInt(Math.floor(Date.now() / 1000))
    if (finalized.timestamp > now + 120n || finalized.timestamp + 7200n < now) fail('stale-finality')

    const receipt = await client.getTransactionReceipt({ hash: p.transactionHash })
    if (!receipt || receipt.status !== 'success' || !same(receipt.transactionHash, p.transactionHash) ||
        typeof receipt.blockNumber !== 'bigint' || receipt.blockNumber > finalized.number ||
        !HASH.test(receipt.blockHash ?? '') || !Array.isArray(receipt.logs)) fail('invalid-receipt')
    const height = receipt.blockNumber
    const block = await client.getBlock({ blockNumber: height })
    if (block?.number !== height || !same(block.hash, receipt.blockHash) ||
        !Array.isArray(block.transactions) ||
        !block.transactions.some(tx => same(typeof tx === 'string' ? tx : tx?.hash, p.transactionHash))) {
      fail('unanchored-transaction')
    }
    async function codeAt(address, expectedHash) {
      const bytecode = await client.getBytecode({ address, blockNumber: height })
      if (!bytecode || bytecode === '0x' || !same(keccak256(bytecode), expectedHash)) fail('codehash-mismatch')
    }
    for (const [address, hash] of [
      [p.issuer, p.issuerCodeHash], [REGISTRY, p.registryCodeHash], [WRAPPER, p.wrapperCodeHash],
    ]) await codeAt(address, hash)
    const read = (address, abi, functionName, args = []) => client.readContract({
      address, abi, functionName, args, blockNumber: height,
    })
    const [issuerParent, issuerRegistry, issuerWrapper] = await Promise.all([
      read(p.issuer, ISSUER_ABI, 'parentNode'),
      read(p.issuer, ISSUER_ABI, 'ENS_REGISTRY'),
      read(p.issuer, ISSUER_ABI, 'NAME_WRAPPER'),
    ])
    if (!same(issuerParent, p.parentNode) || !same(issuerRegistry, REGISTRY) ||
        !same(issuerWrapper, WRAPPER)) fail('wrong-issuer-identity')

    let matches = 0
    let logIndex
    for (const log of receipt.logs) {
      if (!same(log.address, p.issuer) || !same(log.topics?.[0], TOPIC0)) continue
      if (log.removed || !same(log.blockHash, receipt.blockHash) ||
          !same(log.transactionHash, p.transactionHash) || log.blockNumber !== height ||
          !Number.isSafeInteger(log.logIndex) || log.logIndex < 0) fail('invalid-issuer-log')
      let decoded
      try {
        decoded = decodeEventLog({ abi: [EVENT], data: log.data, topics: log.topics, strict: true })
      } catch { fail('invalid-issuer-log') }
      if (!same(decoded.args.node, p.node) || !same(decoded.args.member, p.member) ||
          BigInt(decoded.args.expiry) !== BigInt(p.expiry)) fail('wrong-issued-child')
      matches++
      logIndex = log.logIndex
    }
    if (matches !== 1) fail('missing-or-duplicate-issuance-event')
    const [registryOwner, data, tokenOwner] = await Promise.all([
      read(REGISTRY, REGISTRY_ABI, 'owner', [p.node]),
      read(WRAPPER, WRAPPER_ABI, 'getData', [BigInt(p.node)]),
      read(WRAPPER, WRAPPER_ABI, 'ownerOf', [BigInt(p.node)]),
    ])
    if (!same(registryOwner, WRAPPER) || !Array.isArray(data) || data.length !== 3 ||
        !same(data[0], p.member) || !same(tokenOwner, p.member) ||
        BigInt(data[2]) !== BigInt(p.expiry) ||
        (BigInt(data[1]) & (CU | PCC)) !== (CU | PCC)) fail('historical-native-mismatch')
    const head = await client.getBlock({ blockTag: 'finalized' })
    const stable = await client.getBlock({ blockNumber: height })
    if (typeof head?.number !== 'bigint' || head.number < finalized.number ||
        (head.number === finalized.number && !same(head.hash, finalized.hash)) ||
        !same(stable?.hash, receipt.blockHash)) fail('finality-changed')

    return {
      mode: 'LEGACY_ENSV1_ISSUE_RPC_OBSERVATION_ONLY',
      chainId: CHAIN_ID, source: p.issuer, parentNode: p.parentNode, node: p.node,
      member: p.member, expiry: p.expiry, transactionHash: p.transactionHash,
      sourceBlock: { number: height.toString(), hash: receipt.blockHash, logIndex },
      finalizedBlock: { number: finalized.number.toString(), hash: finalized.hash },
      historicalIssuanceObserved: true, evidenceLevel: 'FINALIZED_RPC_OBSERVATION_ONLY',
      requestNonceVerified: false, opMirrorVerified: false,
      nativeCurrentAuthorityVerified: false, sovereignReceipt: false, enablesNativeIssuance: false,
    }
  } catch (error) {
    if (error instanceof NativeReceiptFailure) throw error
    // RPC errors may contain credential-bearing request URLs.
    fail('unverifiable-rpc')
  }
}
