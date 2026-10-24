import {it,expect} from 'vitest'
import {inspectRevokeReceipt} from '../../scripts/check-g2-sepolia-7702-human-execution.mjs'
const wallet='0xF7Bf79AcB7F3702b9DbD397d8140ac9DE6Ce642C'
const hash='0x'+'ab'.repeat(32)
const client=(change={})=>({getChainId:async()=>11155111,getTransactionReceipt:async()=>({status:'success',transactionHash:hash,blockHash:'0x'+'ef'.repeat(32),blockNumber:123n}),getTransaction:async()=>({from:wallet,type:'eip7702'}),getBytecode:async()=> '0x',...change})
it('only recognizes successful matching type4 receipt and empty post-revocation code',async()=>{
 expect((await inspectRevokeReceipt(hash,[client(),client()])).status).toBe('POSTCONDITION_OBSERVED')
 for(const mutate of [{getChainId:async()=>1},{getBytecode:async()=> '0xef0100'},{getTransaction:async()=>({from:wallet,type:'eip1559'})},{getTransaction:async()=>({from:'0x0000000000000000000000000000000000000001',type:'eip7702'})},{getTransactionReceipt:async()=>({status:'reverted',transactionHash:hash})},{getTransactionReceipt:async()=>{throw Error('timeout')}}]) expect((await inspectRevokeReceipt(hash,[client(mutate),client()])).status).toBe('BLOCKED')
 expect((await inspectRevokeReceipt('0xdead',[client(),client()])).status).toBe('BLOCKED')
})
