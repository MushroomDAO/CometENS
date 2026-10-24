/** Read-only OP application NFT receipt, never ENS-native ownership evidence. */
import { decodeEventLog, decodeFunctionData, encodePacked, isAddress, keccak256, parseAbi, parseAbiItem, toEventSelector, toHex } from 'viem'

const CHAIN = 11155420
const ZERO = '0x0000000000000000000000000000000000000000'
const HASH = /^0x[0-9a-fA-F]{64}$/
const EVENT = parseAbiItem('event SubnodeIssued(bytes32 indexed parent, bytes32 indexed node, address indexed holder, address issuer)')
const NONCE_EVENT = parseAbiItem('event IssuanceNonceConsumed(address indexed operator, uint256 nonce, bytes32 indexed node)')
const ISSUE_ABI = parseAbi(['function issueBySig(string label,address member,address initialAddr,uint256 nonce,uint256 deadline,bytes signature) returns (bytes32)'])
const OWNER_ABI = parseAbi(['function ownerOf(uint256 id) view returns (address)', 'function issuanceNonce() view returns (uint256)', 'function parentNode() view returns (bytes32)'])
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()
const nonzeroHash = v => HASH.test(v ?? '') && !/^0x0+$/i.test(v)
const account = v => typeof v === 'string' && isAddress(v, { strict: true }) && !same(v, ZERO)
export class V4ReceiptDenied extends Error {
  constructor(code) { super(`OP signed issuance receipt refused: ${code}`); this.code = code }
}
const deny = code => { throw new V4ReceiptDenied(code) }

export async function observeV4SignedIssuanceReceipt({ client, profile }) {
  const fields = ['chainId', 'contract', 'codeHash', 'parentNode', 'label', 'member', 'operator', 'nonce', 'transactionHash']
  if (!profile || typeof profile !== 'object' || Array.isArray(profile) ||
      Object.keys(profile).sort().join() !== fields.sort().join() ||
      Object.values(Object.getOwnPropertyDescriptors(profile)).some(d => !Object.hasOwn(d, 'value'))) deny('invalid-profile')
  const p = Object.fromEntries(fields.map(k => [k, profile[k]]))
  if (p.chainId !== CHAIN || !account(p.contract) || !account(p.member) || !account(p.operator) ||
      !nonzeroHash(p.codeHash) || !nonzeroHash(p.parentNode) || !HASH.test(p.transactionHash ?? '') ||
      typeof p.label !== 'string' || !/^[a-z0-9-]{1,63}$/.test(p.label) ||
      p.label.startsWith('-') || p.label.endsWith('-') || (p.label.length >= 4 && p.label[2] === '-' && p.label[3] === '-') ||
      typeof p.nonce !== 'string' || !/^(0|[1-9][0-9]*)$/.test(p.nonce) ||
      BigInt(p.nonce) >= (1n << 256n)) deny('invalid-profile')
  const node = keccak256(encodePacked(['bytes32', 'bytes32'], [p.parentNode, keccak256(toHex(p.label))]))
  if (!client) deny('missing-client')
  try {
    if (await client.getChainId() !== CHAIN) deny('wrong-chain')
    const finalized = await client.getBlock({ blockTag: 'finalized' })
    if (typeof finalized?.number !== 'bigint' || !nonzeroHash(finalized.hash)) deny('bad-finality')
    const receipt = await client.getTransactionReceipt({ hash: p.transactionHash })
    if (!receipt || receipt.status !== 'success' || !same(receipt.transactionHash, p.transactionHash) ||
        !same(receipt.to, p.contract) || typeof receipt.blockNumber !== 'bigint' ||
        receipt.blockNumber > finalized.number || !nonzeroHash(receipt.blockHash) ||
        !Array.isArray(receipt.logs)) deny('invalid-receipt')
    const height = receipt.blockNumber
    const [tx, block, code, parent, owner, nextNonce] = await Promise.all([
      client.getTransaction({ hash: p.transactionHash }),
      client.getBlock({ blockNumber: height }),
      client.getBytecode({ address: p.contract, blockNumber: height }),
      client.readContract({ address: p.contract, abi: OWNER_ABI, functionName: 'parentNode', blockNumber: height }),
      client.readContract({ address: p.contract, abi: OWNER_ABI, functionName: 'ownerOf', args: [BigInt(node)], blockNumber: height }),
      client.readContract({ address: p.contract, abi: OWNER_ABI, functionName: 'issuanceNonce', blockNumber: height }),
    ])
    if (!same(tx?.hash, p.transactionHash) || !same(tx?.from, p.operator) ||
        !same(tx?.to, p.contract) || !same(tx?.blockHash, receipt.blockHash) ||
        tx?.blockNumber !== height || !same(block?.hash, receipt.blockHash) ||
        block?.number !== height || !Array.isArray(block.transactions) ||
        !block.transactions.some(t => same(typeof t === 'string' ? t : t?.hash, p.transactionHash)) || !code || !same(keccak256(code), p.codeHash) ||
        !same(parent, p.parentNode) || !same(owner, p.member) ||
        typeof nextNonce !== 'bigint' || nextNonce <= BigInt(p.nonce)) deny('historical-state-mismatch')
    let call
    try { call = decodeFunctionData({ abi: ISSUE_ABI, data: tx.input }) } catch { deny('wrong-call') }
    if (call.functionName !== 'issueBySig' || call.args[0] !== p.label ||
        !same(call.args[1], p.member) || call.args[3] !== BigInt(p.nonce)) deny('wrong-call')
    let issuance = 0; let consumed = 0
    for (const log of receipt.logs) {
      if (!same(log.address, p.contract)) continue
      if (![toEventSelector(EVENT), toEventSelector(NONCE_EVENT)].some(t => same(log.topics?.[0], t))) continue
      if (log.removed || !same(log.transactionHash, p.transactionHash) ||
          !same(log.blockHash, receipt.blockHash) || log.blockNumber !== height) deny('invalid-log')
      let decoded
      try { decoded = decodeEventLog({ abi: [EVENT, NONCE_EVENT], topics: log.topics, data: log.data, strict: true }) }
      catch { deny('invalid-log') }
      if (decoded.eventName === 'SubnodeIssued') {
        if (!same(decoded.args.parent, p.parentNode) || !same(decoded.args.node, node) ||
            !same(decoded.args.holder, p.member) || !same(decoded.args.issuer, p.operator)) deny('issuance-mismatch')
        issuance++
      } else {
        if (!same(decoded.args.operator, p.operator) || decoded.args.nonce !== BigInt(p.nonce) ||
            !same(decoded.args.node, node)) deny('nonce-mismatch')
        consumed++
      }
    }
    if (issuance !== 1 || consumed !== 1) deny('event-count')
    const after = await client.getBlock({ blockNumber: height })
    const finalAfter = await client.getBlock({ blockTag: 'finalized' })
    if (!same(after?.hash, receipt.blockHash) || finalAfter.number < finalized.number ||
        (finalAfter.number === finalized.number && !same(finalAfter.hash, finalized.hash))) deny('reorg')
    return { scope: 'op-application-only', receiptObserved: true, chainId: CHAIN,
      transactionHash: p.transactionHash, node, member: p.member, nonce: p.nonce,
      blockNumber: height.toString(), blockHash: receipt.blockHash,
      nativeAuthorityVerified: false, sovereignReceipt: false,
      independentConsensusVerified: false, currentOwnerVerified: false }
  } catch (e) {
    if (e instanceof V4ReceiptDenied) throw e
    deny('rpc-or-decode-failed')
  }
}
