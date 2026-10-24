import { describe, expect, it, vi, beforeEach } from 'vitest'
import { auditG2Ensv2Parent } from '../../scripts/audit-g2-ensv2-parent-registration.mjs'
import { inspectEnsv2 } from '../../scripts/inspect-ensv2-risk.mjs'
import { encodeEventTopics, encodeAbiParameters, parseAbiItem } from 'viem'

vi.mock('../../scripts/inspect-ensv2-risk.mjs', () => ({ inspectEnsv2: vi.fn() }))
const owner = '0xF7Bf79AcB7F3702b9DbD397d8140ac9DE6Ce642C'
const manifest = { name: 'cometens-g2-20261023.eth' }
const receipt = { status: 'success', transactionHash: `0x${'ab'.repeat(32)}`,
  blockNumber: 50n, to: '0xf633e7fc17e2bbe0d0965d18ec1821dcb754a3d3' }
const event = parseAbiItem('event NameRegistered(uint256 indexed tokenId, string label, address owner, address subregistry, address resolver, uint64 duration, address paymentToken, bytes32 indexed referrer, uint256 base, uint256 premium)')
const log = {
  address: receipt.to,
  topics: encodeEventTopics({ abi: [event], eventName: 'NameRegistered', args: { tokenId: 1n, referrer: `0x${'0'.repeat(64)}` } }),
  data: encodeAbiParameters([{type:'string'},{type:'address'},{type:'address'},{type:'address'},{type:'uint64'},{type:'address'},{type:'uint256'},{type:'uint256'}],
    ['cometens-g2-20261023', owner, '0x0000000000000000000000000000000000000000',
      '0x0000000000000000000000000000000000000000', 31536000n,
      '0x240b0316df57887dbbe58b586508b19e633a14aa', 8000021n, 0n]),
}
const client = { getTransactionReceipt: vi.fn(async () => ({ ...receipt, blockHash: `0x${'cd'.repeat(32)}`, logs: [log] })) }
const evidence = { checkedAllAncestry: true, finalized: { number: '60', hash: `0x${'bc'.repeat(32)}` },
  findings: [{ code: 'APPROVAL_ENUMERATION_INCOMPLETE' }],
  visited: [{ label: 'eth' }, { label: 'cometens-g2-20261023', owner, status: 2, expiry: '9999999999' }] }
describe('G2 Sepolia ENSv2 post-registration authority remains bounded', () => {
  beforeEach(() => { vi.mocked(inspectEnsv2).mockResolvedValue(structuredClone(evidence)); client.getTransactionReceipt.mockResolvedValue({ ...receipt, blockHash: `0x${'cd'.repeat(32)}`, logs: [log] }) })
  it('observes current owner without sovereignty or exclusive EAC claims', async () => {
    const r = await auditG2Ensv2Parent({ client, manifest, expectedOwner: owner, registrationReceipt: receipt })
    expect(r).toMatchObject({ verdict: 'REGISTERED_OWNER_RPC_OBSERVED_ONLY', nativeOwnershipObserved: true,
      eacExclusiveControlVerified: false, independentlyFinalized: false, sovereignReceipt: false })
  })
  it('rejects fake failed receipt', async () => {
    const r = await auditG2Ensv2Parent({ client, manifest, expectedOwner: owner,
      registrationReceipt: { ...receipt, status: 'reverted' } })
    expect(r.reason).toBe('INVALID_REGISTRATION_RECEIPT')
  })
  it('rejects successful unrelated contract receipt', async () => {
    const r = await auditG2Ensv2Parent({ client, manifest, expectedOwner: owner,
      registrationReceipt: { ...receipt, to: '0x1111111111111111111111111111111111111111' } })
    expect(r.reason).toBe('INVALID_REGISTRATION_RECEIPT')
  })
  it('rejects a not-yet-finalized registration', async () => {
    vi.mocked(inspectEnsv2).mockResolvedValue({ ...evidence, finalized: { number: '49' } })
    expect((await auditG2Ensv2Parent({ client, manifest, expectedOwner: owner, registrationReceipt: receipt })).reason)
      .toBe('REGISTRATION_NOT_FINALIZED')
  })
  it.each(['wrong-owner', 'expired', 'wrong-label', 'unregistered'])('fails closed: %s', async kind => {
    const x = structuredClone(evidence)
    const child = x.visited.at(-1)
    if (kind === 'wrong-owner') child.owner = '0x2222222222222222222222222222222222222222'
    if (kind === 'expired') child.expiry = '1'
    if (kind === 'wrong-label') child.label = 'other'
    if (kind === 'unregistered') child.status = 0
    vi.mocked(inspectEnsv2).mockResolvedValue(x)
    expect((await auditG2Ensv2Parent({ client, manifest, expectedOwner: owner, registrationReceipt: receipt })).reason)
      .toBe('NOT_CURRENT_OWNER')
  })
  it('rejects missing NameRegistered event', async () => {
    client.getTransactionReceipt.mockResolvedValue({ ...receipt, blockHash: `0x${'cd'.repeat(32)}`, logs: [] })
    expect((await auditG2Ensv2Parent({ client, manifest, expectedOwner: owner, registrationReceipt: receipt })).reason)
      .toBe('REGISTRATION_EVENT_NOT_VERIFIED')
  })
  it('rejects invalid sender or receipt fork mismatch', async () => {
    client.getTransactionReceipt.mockResolvedValue({ ...receipt, to: '0x1111111111111111111111111111111111111111', blockHash: `0x${'cd'.repeat(32)}`, logs: [log] })
    expect((await auditG2Ensv2Parent({ client, manifest, expectedOwner: owner, registrationReceipt: receipt })).reason)
      .toBe('RECEIPT_INCONSISTENT')
  })
})
