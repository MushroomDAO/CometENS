import {it,expect} from 'vitest'
import {validateDraftOrder,draftRevocation} from '../../scripts/draft-g2-sepolia-7702-revoke.mjs'
const order={version:1,action:'revoke-7702',chainId:11155111,wallet:'0xF7Bf79AcB7F3702b9DbD397d8140ac9DE6Ce642C',maxFeeWei:'1000000000000000',maxGas:'150000',expiresAt:new Date(Date.now()+1800000).toISOString()}
it('strict order rejects replay, wrong chain, signer, excess fee and extra fields',()=>{
 expect(validateDraftOrder(order)).toBe(order)
 for(const mutation of [{chainId:1},{wallet:'0x0000000000000000000000000000000000000000'},{expiresAt:new Date(Date.now()-1000).toISOString()},{maxFeeWei:'1000000000000001'},{maxGas:'150001'},{authorizationList:[]}]) expect(()=>validateDraftOrder({...order,...mutation})).toThrow()
})
it('fails closed on wrong chain, pending nonce race and old delegate',async()=>{
 const fake=(change={})=>({getChainId:async()=>11155111,getBytecode:async({address})=>address.toLowerCase()==='0x5804b6119d12ad403a430fd3cff12a8ff6e4064b'?'0x1234':'0xef01005804b6119d12ad403a430fd3cff12a8ff6e4064b',getTransactionCount:async({blockTag})=>blockTag==='pending'?2:1,estimateFeesPerGas:async()=>({maxFeePerGas:1n,maxPriorityFeePerGas:1n}),...change})
 expect((await draftRevocation(order,[fake(),fake()])).reason).toBe('UNSAFE_CHAIN_STATE')
 expect((await draftRevocation(order,[fake({getChainId:async()=>1}),fake()])).reason).toBe('UNSAFE_CHAIN_STATE')
 expect((await draftRevocation(order,[fake({getBytecode:async()=> '0x'}),fake()])).reason).toBe('UNSAFE_CHAIN_STATE')
})
