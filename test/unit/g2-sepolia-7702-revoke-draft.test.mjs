import { it, expect, vi, beforeEach } from 'vitest'
vi.mock('../../scripts/check-g2-sepolia-7702-revocation.mjs', async importOriginal => ({
  ...(await importOriginal()), checkRemote: vi.fn(),
}))
import { checkRemote } from '../../scripts/check-g2-sepolia-7702-revocation.mjs'
import { validateDraftOrder, draftRevocation } from '../../scripts/draft-g2-sepolia-7702-revoke.mjs'
const order = () => ({ version:1, action:'revoke-7702', chainId:11155111,
  wallet:'0xF7Bf79AcB7F3702b9DbD397d8140ac9DE6Ce642C',
  maxFeeWei:'1000000000000000', maxGas:'150000', expiresAt:new Date(Date.now()+1800000).toISOString() })
const snapshot = (mutation={}) => ({status:'READY_FOR_HUMAN_REVIEW', observedTransactionNonce:7,
  expectedSelfAuthorizationNonce:8, verifiedDelegateCodeHash:'0xabc', ...mutation})
const rpc = (maxFeePerGas=1n) => ({estimateFeesPerGas:async()=>({maxFeePerGas,maxPriorityFeePerGas:1n})})
beforeEach(()=>vi.mocked(checkRemote).mockReset())
it('validates types, expiry, gas min/max and fee bounds',()=>{
  expect(validateDraftOrder(order())).toBeTruthy()
  for (const patch of [{chainId:1},{wallet:'0x0000000000000000000000000000000000000000'},
    {expiresAt:new Date(Date.now()-1000).toISOString()}, {expiresAt:'Sat Oct 24 2026 15:00:16 GMT+0700'},
    {expiresAt:new Date(Date.now()+3700000).toISOString()}, {expiresAt:5},
    {maxFeeWei:'1000000000000001'}, {maxFeeWei:5}, {maxGas:5}, {maxGas:'1'},
    {maxGas:'45999'}, {maxGas:'150001'}, {authorizationList:[]}])
    expect(()=>validateDraftOrder({...order(),...patch})).toThrow('INVALID_REVOKE_ORDER')
  expect(validateDraftOrder({...order(),maxGas:'46000'})).toBeTruthy()
})
it('returns strict unsigned self-revocation with transaction nonce + 1 and zero address',async()=>{
  vi.mocked(checkRemote).mockResolvedValue(snapshot())
  const result=await draftRevocation(order(),[rpc(),rpc()])
  expect(result).toMatchObject({status:'UNSIGNED_HUMAN_REVIEW_ONLY',safeToSign:false,broadcast:false,
    authorization:{contractAddress:'0x0000000000000000000000000000000000000000',executor:'self',nonce:8,chainId:11155111},
    transaction:{nonce:7,to:order().wallet,type:'eip7702'}})
})
it.each([
  [snapshot({observedTransactionNonce:9}),snapshot(),'RPC_DISAGREEMENT'],
  [snapshot({verifiedDelegateCodeHash:'0xdef'}),snapshot(),'RPC_DISAGREEMENT'],
  [snapshot({status:'BLOCKED'}),snapshot(),'UNSAFE_CHAIN_STATE'],
])('rejects untrusted or disagreed RPC snapshot',async(a,b,reason)=>{
  vi.mocked(checkRemote).mockResolvedValueOnce(a).mockResolvedValueOnce(b)
  expect((await draftRevocation(order(),[rpc(),rpc()])).reason).toBe(reason)
})
it.each([[6666666667n,1n],[1n,6666666667n]])('rejects fee cap exceeded at either RPC',async(a,b)=>{
  vi.mocked(checkRemote).mockResolvedValue(snapshot())
  expect((await draftRevocation(order(),[rpc(a),rpc(b)])).reason).toBe('GAS_FEE_CAP')
})
it('accepts exactly matching gas fee budget limit',async()=>{
  vi.mocked(checkRemote).mockResolvedValue(snapshot())
  const o={...order(), maxGas:'50000', maxFeeWei:'100000'}
  expect((await draftRevocation(o,[rpc(2n),rpc(2n)])).status).toBe('UNSIGNED_HUMAN_REVIEW_ONLY')
})
it('refuses if RPC resolves after order expiration',async()=>{
  vi.useFakeTimers()
  try {
    vi.setSystemTime(new Date('2026-10-24T08:00:00Z'))
    const o={...order(),expiresAt:'2026-10-24T08:00:01Z'}
    vi.mocked(checkRemote).mockImplementation(async()=>{vi.setSystemTime(new Date('2026-10-24T08:00:02Z'));return snapshot()})
    expect((await draftRevocation(o,[rpc(),rpc()])).reason).toBe('INVALID_REVOKE_ORDER')
  } finally {vi.useRealTimers()}
})
