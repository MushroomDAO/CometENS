import {test} from 'node:test'
import {strict as assert} from 'node:assert'
import {validate,verify,assertRaw} from './revoke-human.mjs'
const order=()=>({version:1,action:'clear-7702',wallet:'0xF7Bf79AcB7F3702b9DbD397d8140ac9DE6Ce642C',chainId:11155111,maxGas:'60000',maxFeePerGasWei:'100000000',maxPriorityFeePerGasWei:'2000000',expiresAt:new Date(Date.now()+300000).toISOString()})
test('validates fixed intent and rejects hostile inputs',()=>{
 assert.ok(validate(order()))
 for(const patch of [{chainId:1},{wallet:'0x0000000000000000000000000000000000000000'},{maxGas:'1'},{maxGas:'150001'},{maxGas:60000},{maxFeePerGasWei:'100000000001'},{maxPriorityFeePerGasWei:'100000001'},{expiresAt:'2027-02-30T00:00:00.000Z'},{expiresAt:new Date(Date.now()-3000).toISOString()},{key:'any'}])assert.throws(()=>validate({...order(),...patch}))
})
test('dual RPC rejects nonce disagreement, hostile fees and block drift',async()=>{
 const base={status:'READY_FOR_HUMAN_REVIEW',observedTransactionNonce:7,verifiedDelegateCodeHash:'0x1234'}
 const rpc=(fee=100n,height=100n)=>({getBlockNumber:async()=>height,estimateFeesPerGas:async()=>({maxFeePerGas:fee,maxPriorityFeePerGas:1n})})
 const checker=async()=>base
 assert.equal(await verify([rpc(),rpc()],order(),checker),7)
 let n=0
 await assert.rejects(()=>verify([rpc(),rpc()],order(),async()=>({...base,observedTransactionNonce:++n})),/RPC_DISAGREEMENT/)
 await assert.rejects(()=>verify([rpc(100000001n),rpc()],order(),checker),/FEE_EXCEEDED/)
 await assert.rejects(()=>verify([rpc(),rpc(100000001n)],order(),checker),/FEE_EXCEEDED/)
 await assert.rejects(()=>verify([rpc(100n,100n),rpc(100n,110n)],order(),checker),/RPC_BLOCK_DRIFT/)
 await assert.rejects(()=>verify([rpc(),rpc()],order(),async()=>({...base,status:'BLOCKED'})),/DELEGATION_OR_NONCE_CHANGED/)
 assert.throws(()=>assertRaw('0x',order(),7))
})
