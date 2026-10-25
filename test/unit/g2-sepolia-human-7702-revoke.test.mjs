import {it,expect} from 'vitest'
import {execFileSync} from 'node:child_process'
import {existsSync,mkdtempSync,symlinkSync,rmSync,writeFileSync,readFileSync,chmodSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,dirname} from 'node:path'
import {strict as assert} from 'node:assert'
import {keccak256,zeroAddress} from 'viem'
import {validate,verify} from '../../scripts/g2-sepolia-human-7702-revoke.mjs'
const order=()=>({version:1,action:'clear-7702',wallet:'0xF7Bf79AcB7F3702b9DbD397d8140ac9DE6Ce642C',chainId:11155111,maxGas:'60000',maxFeePerGasWei:'100000000',maxPriorityFeePerGasWei:'2000000',expiresAt:new Date(Date.now()+300000).toISOString()})
it('validates fixed intent and rejects hostile inputs',()=>{
 assert.ok(validate(order()))
 for(const patch of [{chainId:1},{wallet:'0x0000000000000000000000000000000000000000'},{maxGas:'1'},{maxGas:'150001'},{maxGas:60000},{maxFeePerGasWei:'100000000001'},{maxPriorityFeePerGasWei:'100000001'},{expiresAt:'2027-02-30T00:00:00.000Z'},{expiresAt:new Date(Date.now()-3000).toISOString()},{key:'any'}])assert.throws(()=>validate({...order(),...patch}))
})
it('dual RPC rejects nonce disagreement, hostile fees and block drift',async()=>{
 const base={status:'READY_FOR_HUMAN_REVIEW',observedTransactionNonce:7,verifiedDelegateCodeHash:'0x1234'}
 const rpc=(fee=100n,height=100n,hash='0xabc')=>({getBlockNumber:async()=>height,getBlock:async({blockNumber})=>({number:blockNumber,hash}),estimateFeesPerGas:async()=>({maxFeePerGas:fee,maxPriorityFeePerGas:1n})})
 const checker=async()=>base
 const pinned=async()=>{}
 assert.equal(await verify([rpc(),rpc()],order(),checker,pinned),7)
 await assert.rejects(()=>verify([rpc(),rpc(100n,100n,'0xdef')],order(),checker,pinned),/RPC_CANONICAL_BLOCK_MISMATCH/)
 let n=0
 await assert.rejects(()=>verify([rpc(),rpc()],order(),async()=>({...base,observedTransactionNonce:++n}),pinned),/RPC_DISAGREEMENT/)
 await assert.rejects(()=>verify([rpc(100000001n),rpc()],order(),checker,pinned),/FEE_EXCEEDED/)
 await assert.rejects(()=>verify([rpc(),rpc(100000001n)],order(),checker,pinned),/FEE_EXCEEDED/)
 await assert.rejects(()=>verify([rpc(100n,100n),rpc(100n,110n)],order(),checker,pinned),/RPC_BLOCK_DRIFT/)
 await assert.rejects(()=>verify([rpc(),rpc()],order(),async()=>({...base,status:'BLOCKED'}),pinned),/DELEGATION_OR_NONCE_CHANGED/)

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
import {executeVerified,inspectHash,reserveNonce,persistent,confirmAndReserve} from '../../scripts/g2-sepolia-human-7702-revoke.mjs'
const fixedWallet='0xF7Bf79AcB7F3702b9DbD397d8140ac9DE6Ce642C'
const signed='0x04'+'ab'.repeat(90)
const hash=keccak256(signed)
const finalizedClients=()=>[0,1].map((i)=>({
 getTransaction:async()=>({from:fixedWallet,to:fixedWallet,nonce:7,chainId:11155111,type:'eip7702',authorizationList:[{address:zeroAddress,nonce:8,chainId:11155111}]}),
 getTransactionReceipt:async()=>({transactionHash:hash,blockNumber:11n,blockHash:'0x'+'aa'.repeat(32),status:'success'}),
 getBlock:async({blockNumber,blockTag})=>({number:blockNumber??12n,hash:'0x'+'aa'.repeat(32)}),
 getBytecode:async()=> i===0?'0x':undefined
}))
it('mocked positive Type-4 clears delegation and journals before send',async()=>{
 const calls=[]; const account={address:fixedWallet}
 const wallet={signAuthorization:async args=>{calls.push(['auth',args]);return {address:'0x0000000000000000000000000000000000000000',nonce:8}},
 signTransaction:async tx=>{calls.push(['sign',tx]);return signed},
 sendRawTransaction:async tx=>{calls.push(['send',tx]);return hash}}
 const clients=finalizedClients()
 const result=await executeVerified({o:order(),clients,wallet,account,nonce:7,journalPath:'/fake',
 recheck:async()=>7,guard:async()=>{},persist:async(path,obj)=>{calls.push(['journal',path,obj.state])}})
 expect(result).toEqual({status:'DELEGATION_CLEARED_FINALIZED',hash,outerExecution:'success',retry:false})
 expect(calls[0][1]).toMatchObject({contractAddress:'0x0000000000000000000000000000000000000000',executor:'self',chainId:11155111})
 expect(calls[1][1]).toMatchObject({type:'eip7702',nonce:7,to:fixedWallet,authorizationList:[{nonce:8}],gas:60000n})
 expect(calls[2]).toEqual(['journal','/fake.hash','SIGNED_BEFORE_BROADCAST'])
 expect(calls[3]).toEqual(['journal','/fake.attempt','BROADCAST_ATTEMPT_UNKNOWN_NO_RETRY'])
 expect(calls[4]).toEqual(['send',{serializedTransaction:signed}])
})
it('ambiguous send preserves offline hash before first send and can recover after finality without resending',async()=>{
 let sends=0;const journals=[]
 const wallet={signAuthorization:async()=>({address:'0x0000000000000000000000000000000000000000',nonce:8}),
 signTransaction:async()=>signed,
 sendRawTransaction:async()=>{sends++;expect(journals.map(x=>x.path)).toEqual(['/fake.hash','/fake.attempt']);throw Error('RPC_TIMEOUT')}}
 await expect(executeVerified({o:order(),clients:[{},{}],wallet,account:{address:fixedWallet},nonce:7,journalPath:'/fake',
 recheck:async()=>7,guard:async()=>{},persist:async(path,obj)=>journals.push({path,obj})})).rejects.toThrow('RPC_TIMEOUT')
 expect(journals[0].obj.hash).toBe(hash)
 expect(journals[0].obj.state).toBe('SIGNED_BEFORE_BROADCAST')
 expect(sends).toBe(1)
 expect(await inspectHash(finalizedClients(),journals[0].obj.hash,7)).toEqual({status:'DELEGATION_CLEARED_FINALIZED',hash,outerExecution:'success',retry:false})
 expect(sends).toBe(1)
})

it('finalized receipt clearing cannot hide restored delegation',async()=>{
 const clients=finalizedClients()
 clients[1].getBytecode=async({blockNumber})=>blockNumber===12n?'0xef01001234':undefined
 expect(await inspectHash(clients,hash,7)).toMatchObject({status:'DELEGATION_RESTORED_OR_CHANGED',retry:false})
})
it('common finalized hash disagreement blocks success',async()=>{
 const clients=finalizedClients()
 clients[1].getBlock=async({blockNumber,blockTag})=>({number:blockNumber??12n,hash:blockNumber===12n?'0xbbbb':'0x'+'aa'.repeat(32)})
 expect(await inspectHash(clients,hash,7)).toMatchObject({status:'FINALIZED_CHAIN_DISAGREEMENT',retry:false})
})

it('finalized marker hash must agree with canonical block at its height',async()=>{
 const clients=finalizedClients()
 clients[0].getBlock=async({blockNumber,blockTag})=>({number:blockNumber??12n,hash:blockTag==='finalized'?'0x'+'bb'.repeat(32):'0x'+'aa'.repeat(32)})
 expect(await inspectHash(clients,hash,7)).toMatchObject({status:'FINALIZED_CHAIN_DISAGREEMENT',retry:false})
})

it('symlinked CLI invocation fails closed for absent arguments',()=>{
 const target=new URL('../../scripts/g2-sepolia-human-7702-revoke.mjs',import.meta.url)
 const dir=mkdtempSync(join(tmpdir(),'g2-cli-link-'))
 try{
  symlinkSync(dirname(target.pathname),join(dir,'scripts'),'dir')
  const linked=join(dir,'scripts','g2-sepolia-human-7702-revoke.mjs')
  for(const args of [[],['check'],['recover']]){
   let error
   try{execFileSync(process.execPath,[linked,...args],{timeout:3000,encoding:'utf8',stdio:['ignore','pipe','pipe']})}
   catch(e){error=e}
   expect(error?.status).toBe(2)
   expect(String(error?.stderr)).toMatch(/BLOCKED/)
  }
 }finally{rmSync(dir,{recursive:true,force:true})}
})

it('expiry mutation between authorization, transaction signing and broadcast fails closed',async()=>{
 const expired=()=>new Date(Date.now()-10000).toISOString()
 for(const stage of ['authorization','transaction','persist']){
  const o=order();let sends=0;let signs=0
  const wallet={
   signAuthorization:async()=>{if(stage==='authorization')o.expiresAt=expired();return {address:zeroAddress,nonce:8}},
   signTransaction:async()=>{signs++;if(stage==='transaction')o.expiresAt=expired();return signed},
   sendRawTransaction:async()=>{sends++;return hash}}
  await expect(executeVerified({o,clients:finalizedClients(),wallet,account:{address:fixedWallet},nonce:7,journalPath:'/fake',recheck:async()=>7,guard:async()=>{},persist:async()=>{if(stage==='persist')o.expiresAt=expired()}})).rejects.toThrow('EXPIRED')
  expect(sends).toBe(0)
  if(stage==='authorization')expect(signs).toBe(0)
 }
})
it('nonce lock uses wallet and nonce independent of journal filename, rejects collision',async()=>{
 const locks=new Set(),writes=[]
 const persist=async(path,obj)=>{if(locks.has(path)){const e=Error('EEXIST');e.code='EEXIST';throw e}locks.add(path);writes.push(obj)}
 const guard=async()=>{}
 const first=await reserveNonce(7,persist,guard)
 expect(first).toContain('nonce-'+fixedWallet.toLowerCase()+'-7.lock')
 await expect(reserveNonce(7,persist,guard)).rejects.toThrow('EEXIST')
 expect((await reserveNonce(8,persist,guard))).not.toBe(first)
 expect(writes.every(x=>x.state==='NONCE_RESERVED_NO_RETRY')).toBe(true)
})
it('reorg after finality lookup never reports cleared',async()=>{
 let reads=0
 const clients=finalizedClients().map(c=>({...c,getBlock:async args=>{
  if(args.blockTag==='finalized'||args.blockTag==='latest')return {number:12n,hash:'0x'+'aa'.repeat(32)}
  if(args.blockNumber===12n)return {number:12n,hash:'0x'+'aa'.repeat(32)}
  reads++;return {number:11n,hash: reads>2?'0x'+'cc'.repeat(32):'0x'+'aa'.repeat(32)}
 }}))
 expect((await inspectHash(clients,hash,7)).status).toBe('REORG_AFTER_FINALITY_CHECK_NO_RETRY')
})
it('missing receipt distinguishes replaced nonce from dropped hash without automatic retry',async()=>{
 const noReceipt=nonce=>[0,1].map(()=>({
  getTransactionReceipt:async()=>{const e=Error('missing');e.name='TransactionReceiptNotFoundError';throw e},
  getTransaction:async()=>{const e=Error('missing');e.name='TransactionNotFoundError';throw e},
  getTransactionCount:async()=>nonce}))
 expect((await inspectHash(noReceipt(8),hash,7)).status).toBe('NONCE_CONSUMED_OR_TX_REPLACED_NO_RETRY')
 expect((await inspectHash(noReceipt(7),hash,7)).status).toBe('TX_NOT_FOUND_OR_DROPPED_NO_RETRY')
})

it('reverted outer transaction cannot be accepted as successful even if account code is already empty',async()=>{
 const clients=finalizedClients()
 clients[0].getTransactionReceipt=async()=>({transactionHash:hash,blockNumber:11n,blockHash:'0x'+'aa'.repeat(32),status:'reverted'})
 expect(await inspectHash(clients,hash,7)).toMatchObject({status:'OUTER_EXECUTION_FAILED_NO_RETRY',retry:false})
 const both=finalizedClients()
 for(const c of both)c.getTransactionReceipt=async()=>({transactionHash:hash,blockNumber:11n,blockHash:'0x'+'aa'.repeat(32),status:'reverted'})
 expect(await inspectHash(both,hash,7)).toMatchObject({status:'OUTER_EXECUTION_FAILED_NO_RETRY',retry:false})
})
it('real exclusive durable journals refuse pre-existing hash/attempt without mutation',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'g2-journal-real-'))
 try{
  chmodSync(dir,0o700)
  for(const suffix of ['.hash','.attempt']){
   const file=join(dir,'execute'+suffix)
   const original='DO_NOT_OVERWRITE\n'
   writeFileSync(file,original,{mode:0o600})
   await expect(persistent(file,{state:'ATTEMPT'})).rejects.toMatchObject({code:'EEXIST'})
   expect(readFileSync(file,'utf8')).toBe(original)
  }
  const fresh=join(dir,'new.hash')
  await persistent(fresh,{state:'SIGNED_BEFORE_BROADCAST'})
  expect(JSON.parse(readFileSync(fresh,'utf8')).state).toBe('SIGNED_BEFORE_BROADCAST')
 }finally{rmSync(dir,{recursive:true,force:true})}
})
it('concurrent distinct journal attempts share real per-wallet nonce exclusive lock',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'g2-lock-real-'))
 try{
  chmodSync(dir,0o700)
  const guard=async()=>{}
  const disk=async(path,obj)=>persistent(join(dir,path.split('/').pop()),obj)
  const results=await Promise.allSettled([reserveNonce(123,disk,guard),reserveNonce(123,disk,guard)])
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1)
  expect(results.filter(r=>r.status==='rejected')).toHaveLength(1)
  expect(results.find(r=>r.status==='rejected').reason.code).toBe('EEXIST')
 }finally{rmSync(dir,{recursive:true,force:true})}
})

it('DECLINED exact phrase creates neither lock nor journal',async()=>{
 const writes=[]
 await expect(confirmAndReserve({ask:async()=> 'WRONG',o:order(),clients:[{},{}],nonce:7,journalPath:'/fake',check:async()=>{throw Error('SHOULD_NOT_VERIFY')},lock:async()=>writes.push('lock'),persist:async()=>writes.push('journal')})).rejects.toThrow('DECLINED')
 expect(writes).toEqual([])
})
