import {it,expect} from 'vitest'
import {execFileSync} from 'node:child_process'
import {existsSync} from 'node:fs'
import {strict as assert} from 'node:assert'
import {validate,verify} from '../../scripts/g2-sepolia-human-7702-revoke.mjs'
const order=()=>({version:1,action:'clear-7702',wallet:'0xF7Bf79AcB7F3702b9DbD397d8140ac9DE6Ce642C',chainId:11155111,maxGas:'60000',maxFeePerGasWei:'100000000',maxPriorityFeePerGasWei:'2000000',expiresAt:new Date(Date.now()+300000).toISOString()})
it('validates fixed intent and rejects hostile inputs',()=>{
 assert.ok(validate(order()))
 for(const patch of [{chainId:1},{wallet:'0x0000000000000000000000000000000000000000'},{maxGas:'1'},{maxGas:'150001'},{maxGas:60000},{maxFeePerGasWei:'100000000001'},{maxPriorityFeePerGasWei:'100000001'},{expiresAt:'2027-02-30T00:00:00.000Z'},{expiresAt:new Date(Date.now()-3000).toISOString()},{key:'any'}])assert.throws(()=>validate({...order(),...patch}))
})
it('dual RPC rejects nonce disagreement, hostile fees and block drift',async()=>{
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

})

it('CLI refuses execution without human terminal before any RPC or key access',()=>{
 const candidate=new URL('../../scripts/g2-sepolia-human-7702-revoke.mjs',import.meta.url)
 const target=existsSync(candidate)?candidate:new URL('./current.mjs',import.meta.url)
 let output=''
 try{execFileSync(process.execPath,[target.pathname,'execute','/nonexistent','/nonexistent','/nonexistent'],{timeout:3000,encoding:'utf8',stdio:['ignore','pipe','pipe']})}
 catch(e){output=String(e.stderr);expect([1,2]).toContain(e.status)}
 expect(output).toMatch(/BLOCKED/)
 expect(output).not.toMatch(/private key|0x[a-f0-9]{64}/i)
})
import {executeVerified} from '../../scripts/g2-sepolia-human-7702-revoke.mjs'
const fixedWallet='0xF7Bf79AcB7F3702b9DbD397d8140ac9DE6Ce642C'
it('mocked positive Type-4 clears delegation and journals before send',async()=>{
 const calls=[]; const account={address:fixedWallet}; const hash='0x'+'12'.repeat(32)
 const wallet={signAuthorization:async args=>{calls.push(['auth',args]);return {address:'0x0000000000000000000000000000000000000000',nonce:8}},
 sendTransaction:async tx=>{calls.push(['send',tx]);return hash}}
 const clients=[{waitForTransactionReceipt:async()=>({status:'success'}),getBytecode:async()=> '0x'}, {getBytecode:async()=>undefined}]
 const result=await executeVerified({o:order(),clients,wallet,account,nonce:7,journalPath:'/fake',
 recheck:async()=>7,guard:async()=>{},persist:async(path,obj)=>{calls.push(['journal',path,obj.state])}})
 expect(result).toEqual({status:'DELEGATION_CLEARED',hash})
 expect(calls[0][1]).toMatchObject({contractAddress:'0x0000000000000000000000000000000000000000',executor:'self',chainId:11155111})
 expect(calls[1]).toEqual(['journal','/fake.attempt','BROADCAST_ATTEMPT_UNKNOWN_NO_RETRY'])
 expect(calls[2][1]).toMatchObject({type:'eip7702',nonce:7,to:fixedWallet,authorizationList:[{nonce:8}],gas:60000n})
 expect(calls[3]).toEqual(['journal','/fake.hash','SUBMITTED'])
})
it('timeout leaves attempt journal and never silently resends',async()=>{
 let sends=0;const journals=[]
 const wallet={signAuthorization:async()=>({address:'0x0000000000000000000000000000000000000000',nonce:8}),
 sendTransaction:async()=>{sends++;throw Error('RPC_TIMEOUT')}}
 await expect(executeVerified({o:order(),clients:[{},{}],wallet,account:{address:fixedWallet},nonce:7,journalPath:'/fake',
 recheck:async()=>7,guard:async()=>{},persist:async(path)=>journals.push(path)})).rejects.toThrow('RPC_TIMEOUT')
 expect(journals).toEqual(['/fake.attempt']);expect(sends).toBe(1)
})
