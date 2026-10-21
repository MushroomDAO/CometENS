import { describe, expect, it } from 'vitest'
import { concatHex, decodeFunctionData, encodeAbiParameters, hashTypedData, keccak256, parseAbiParameters, toHex, type Address, type Hex } from 'viem'
import { SDKError } from '../../sdk/profiles'
import { createV4IssueTypedData, prepareV4IssueBySig, v4IssuePermitTypes, type V4IssueDomain, type V4IssuePermit } from '../../sdk/v4'

const verifyingContract = '0x1111111111111111111111111111111111111111' as Address
const controller = '0x2222222222222222222222222222222222222222' as Address
const operator = '0x3333333333333333333333333333333333333333' as Address
const member = '0x4444444444444444444444444444444444444444' as Address
const initialAddr = '0x5555555555555555555555555555555555555555' as Address
const ZERO = '0x0000000000000000000000000000000000000000' as Address
const domain: V4IssueDomain = { chainId: 11155420, verifyingContract }
const permit: V4IssuePermit = { label: 'alice', operator, member, initialAddr,
  controllerEpoch: 9n, operatorRevision: 3n, nonce: 7n, deadline: 2000000000n }

const manualDigest = (input: V4IssueDomain, message: V4IssuePermit) => {
  const domainHash = keccak256(encodeAbiParameters(parseAbiParameters('bytes32,bytes32,bytes32,uint256,address'), [
    keccak256(toHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')),
    keccak256(toHex('CometENS Community V4')), keccak256(toHex('1')),
    BigInt(input.chainId), input.verifyingContract,
  ]))
  const issueHash = keccak256(encodeAbiParameters(parseAbiParameters('bytes32,bytes32,address,address,address,uint64,uint256,uint256,uint256'), [
    keccak256(toHex('Issue(string label,address member,address initialAddr,address operator,uint64 controllerEpoch,uint256 operatorRevision,uint256 nonce,uint256 deadline)')),
    keccak256(toHex(message.label)), message.member, message.initialAddr, message.operator,
    message.controllerEpoch, message.operatorRevision, message.nonce, message.deadline,
  ]))
  return keccak256(concatHex(['0x1901', domainHash, issueHash]))
}

describe('G2.6 OP V4 signed issuance typed intent (no signing or broadcast)', () => {
  it('matches separately encoded EIP712 domain/typehash and all 8 field ordering', () => {
    const data = createV4IssueTypedData(domain, permit)
    expect(data).toMatchObject({ domain: { name: 'CometENS Community V4', version: '1', chainId: 11155420,
      verifyingContract }, primaryType: 'Issue', message: permit })
    expect(data.types).toBe(v4IssuePermitTypes)
    expect(hashTypedData(data)).toBe(manualDigest(domain, permit))
  })

  it('binds per-operator revision, controller epoch, contract and signed issued fields', () => {
    const original = hashTypedData(createV4IssueTypedData(domain, permit))
    for (const altered of [
      { ...permit, operator: controller }, { ...permit, member: operator },
      { ...permit, label: 'bob' }, { ...permit, initialAddr: ZERO },
      { ...permit, nonce: 8n }, { ...permit, operatorRevision: 4n },
      { ...permit, controllerEpoch: 10n }, { ...permit, deadline: 2000000001n },
    ]) expect(hashTypedData(createV4IssueTypedData(domain, altered))).not.toBe(original)
    expect(hashTypedData(createV4IssueTypedData({ ...domain, verifyingContract: controller }, permit))).not.toBe(original)
  })

  it('prepares exact calldata with a provided signature without signing or broadcasting anything', () => {
    const sig = ('0x' + 'ab'.repeat(65)) as Hex
    const prepared = prepareV4IssueBySig(domain, permit, sig)
    expect(prepared).toMatchObject({ chainId: 11155420, to: verifyingContract, from: operator,
      value: 0n, ownershipScope: 'op-application-only', controllerSignatureIncluded: true,
      transactionSigned: false, broadcast: false, l1OwnershipVerified: false })
    const independentAbi = [{ type: 'function', name: 'issueBySig', stateMutability: 'nonpayable', inputs: [
      { type: 'string' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' },
      { type: 'uint256' }, { type: 'bytes' },
    ], outputs: [{ type: 'bytes32' }] }] as const
    expect(decodeFunctionData({ abi: independentAbi, data: prepared.data })).toEqual({
      functionName: 'issueBySig', args: ['alice', member, initialAddr, 7n, 2000000000n, sig],
    })
    expect(Object.keys(prepared)).not.toContain('privateKey')
    expect(Object.keys(prepared)).not.toContain('rpcUrl')
  })

  it('permits a zero initial address and arbitrary nonempty ERC-1271 signature bytes', () => {
    const p = { ...permit, initialAddr: ZERO }
    expect(prepareV4IssueBySig(domain, p, '0xdeadbeef').data).toMatch(/^0x[0-9a-f]+$/)
    expect(hashTypedData(createV4IssueTypedData(domain, p))).toBe(manualDigest(domain, p))
  })

  it('refuses invalid V4 LDH labels (including hyphen position) and bad addresses', () => {
    const invalidLabels = ['', 'A', 'a.b', '-a', 'a-', 'ab--cd', 'a_b', 'é', 'a'.repeat(64)]
    for (const label of invalidLabels) {
      expect(() => createV4IssueTypedData(domain, { ...permit, label })).toThrow(SDKError)
    }
    for (const invalid of [{ ...permit, member: ZERO }, { ...permit, operator: ZERO },
      { ...permit, initialAddr: 'oops' as Address }]) {
      expect(() => createV4IssueTypedData(domain, invalid)).toThrow(SDKError)
    }
    expect(createV4IssueTypedData(domain, { ...permit, label: 'a'.repeat(63) }).message.label).toHaveLength(63)
  })

  it('bounds uint64 epoch, issuance nonce exhaustion and uint256 fields independently', () => {
    const uint64max = (1n << 64n) - 1n
    const maxNonce = (1n << 256n) - 1n - (1n << 128n)
    const valid = { ...permit, controllerEpoch: uint64max, nonce: maxNonce - 1n }
    expect(createV4IssueTypedData(domain, valid).message.nonce).toBe(maxNonce - 1n)
    for (const invalid of [
      { ...permit, controllerEpoch: 0n }, { ...permit, controllerEpoch: uint64max + 1n },
      { ...permit, operatorRevision: 0n }, { ...permit, nonce: maxNonce },
      { ...permit, nonce: -1n }, { ...permit, nonce: 7 as unknown as bigint },
      { ...permit, deadline: 0n }, { ...permit, deadline: (1n << 256n) },
    ]) expect(() => createV4IssueTypedData(domain, invalid)).toThrow(SDKError)
  })

  it('rejects wrong chain, zero contract, accidental secret fields and unusable signature', () => {
    expect(() => createV4IssueTypedData({ ...domain, chainId: 10 as 11155420 }, permit)).toThrow(SDKError)
    expect(() => createV4IssueTypedData({ ...domain, verifyingContract: ZERO }, permit)).toThrow(SDKError)
    expect(() => createV4IssueTypedData({ ...domain, rpcUrl: 'secret' } as V4IssueDomain, permit)).toThrow(SDKError)
    expect(() => createV4IssueTypedData(domain, { ...permit, privateKey: 'secret' } as V4IssuePermit)).toThrow(SDKError)
    for (const sig of ['0x', 'abc', '0xabc', '0x' + 'ff'.repeat(4097)]) {
      expect(() => prepareV4IssueBySig(domain, permit, sig as Hex)).toThrow(SDKError)
    }
  })
})
