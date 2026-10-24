import { describe, expect, it } from 'vitest'
import { encodeEventTopics, encodeFunctionData, encodePacked, keccak256, parseAbi, parseAbiItem, toHex } from 'viem'
import { observeV4SignedIssuanceReceipt as audit, V4ReceiptDenied } from '../../scripts/observe-g2-v4-signed-issuance-receipt.mjs'

const contract = '0x1111111111111111111111111111111111111111'
const member = '0x2222222222222222222222222222222222222222'
const operator = '0x3333333333333333333333333333333333333333'
const parentNode = `0x${'11'.repeat(32)}`
const blockHash = `0x${'aa'.repeat(32)}`
const txHash = `0x${'bb'.repeat(32)}`
const code = '0x6001600055'
const label = 'alice'
const node = keccak256(encodePacked(['bytes32','bytes32'],[parentNode,keccak256(toHex(label))]))
const profile = { chainId: 11155420, contract, codeHash: keccak256(code), parentNode,
  label, member, operator, nonce: '7', transactionHash: txHash }
const abi = parseAbi(['function issueBySig(string,address,address,uint256,uint256,bytes) returns (bytes32)'])
const input = encodeFunctionData({ abi, functionName: 'issueBySig', args: [label, member, member, 7n, 500000n, '0x1234'] })
const events = [
  parseAbiItem('event SubnodeIssued(bytes32 indexed parent,bytes32 indexed node,address indexed holder,address issuer)'),
  parseAbiItem('event IssuanceNonceConsumed(address indexed operator,uint256 nonce,bytes32 indexed node)'),
]
function fixture() {
  const data = [
    { abi: [events[0]], eventName: 'SubnodeIssued', args: { parent: parentNode, node, holder: member, issuer: operator } },
    { abi: [events[1]], eventName: 'IssuanceNonceConsumed', args: { operator, nonce: 7n, node } },
  ]
  const logs = data.map((d, i) => ({ address: contract, topics: encodeEventTopics(d), data: i === 0 ? `0x${operator.slice(2).padStart(64,'0')}` : toHex(7n, { size: 32 }),
    transactionHash: txHash, blockHash, blockNumber: 20n, logIndex: i, removed: false }))
  const receipt = { status: 'success', transactionHash: txHash, to: contract, blockNumber: 20n, blockHash, logs }
  const tx = { hash: txHash, from: operator, to: contract, blockNumber: 20n, blockHash, input }
  const client = { getChainId: async () => 11155420, getBlock: async ({ blockTag,blockNumber }) =>
      blockTag === 'finalized' ? { number: 25n, hash: `0x${'cc'.repeat(32)}` } : { number: blockNumber, hash: blockHash, transactions: [txHash] },
    getTransactionReceipt: async () => receipt, getTransaction: async () => tx,
    getBytecode: async () => code,
    readContract: async ({ functionName }) => ({ parentNode, ownerOf: member, issuanceNonce: 8n })[functionName] }
  return { client, receipt, tx, logs }
}
const denied = async (p, code) => expect(p).rejects.toMatchObject({ code })
describe('OP V4 signed issuance receipt is historical and application-only', () => {
  it('observes exact issueBySig calldata, contract events, nonce and token historical owner', async () => {
    const f = fixture()
    expect(await audit({ client: f.client, profile })).toMatchObject({ receiptObserved: true,
      sovereignReceipt: false, nativeAuthorityVerified: false, independentConsensusVerified: false,
      scope: 'op-application-only', currentOwnerVerified: false })
  })
  it('rejects wrong chain, non-final receipt, failed receipt, altered tx sender and call input', async () => {
    for (const mutate of [
      f => { f.client.getChainId = async () => 1 },
      f => { f.client.getBlock = async () => ({ number: 19n, hash: blockHash }) },
      f => { f.receipt.status = 'reverted' },
      f => { f.tx.from = member },
      f => { f.tx.blockHash = `0x${'dd'.repeat(32)}` },
      f => { f.tx.input = '0xdeadbeef' },
    ]) { const f = fixture(); mutate(f); await expect(audit({ client: f.client, profile })).rejects.toBeInstanceOf(V4ReceiptDenied) }
  })
  it('rejects missing, duplicate, or mismatched issuance/nonce events and altered historical owner', async () => {
    for (const mutate of [
      f => f.logs.pop(),
      f => f.logs.push(f.logs[0]),
      f => { f.logs[0].blockHash = `0x${'dd'.repeat(32)}` },
      f => { f.client.readContract = async ({functionName}) => functionName === 'ownerOf' ? operator : ({parentNode,issuanceNonce:8n})[functionName] },
    ]) { const f = fixture(); mutate(f); await expect(audit({ client: f.client, profile })).rejects.toBeInstanceOf(V4ReceiptDenied) }
  })
  it('rejects wrong code pin, wrong holder, unsafe names, unsigned nonce and malformed profile', async () => {
    const f = fixture()
    for (const override of [{ codeHash: `0x${'dd'.repeat(32)}` }, { member: operator },
      { label: 'ab--cd' }, { nonce: '-1' }, { unexpected: true }]) {
      await expect(audit({ client: f.client, profile: { ...profile, ...override } })).rejects.toBeInstanceOf(V4ReceiptDenied)
    }
  })
})
