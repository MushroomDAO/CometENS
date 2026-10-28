import { it,expect } from 'vitest'
import { mkdtemp,readFile,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reserveBeforeSend,recordSignedHash,corroborateReceipt,requireReady,validateFeeSafety,signThenSend,SEPOLIA_RPC_URLS,assertIndependentRpcPair,checkedPreflight } from '../../scripts/g2-human-ensv2-register.mjs'

it('fresh complete preflight retry succeeds only after both RPC gates pass',async()=>{
  let n=0
  const ok={reason:'REGISTER_EXECUTION_NOT_REVIEWED',broadcasts:false,block:{hash:'0x12'},quotedPrice:'2',allowance:'2'}
  const out=await checkedPreflight({},async()=>++n===1?
    {reason:'CHAIN_PREFLIGHT_FAILED',details:['QUOTE_HEAD_ADVANCED','EXTERNAL_WALLET_ACTION_REQUIRED']}:ok)
  expect(n).toBe(2);expect(out).toEqual(ok)
})
it('fails closed after two transient failures with structured detail',async()=>{
  let n=0
  await expect(checkedPreflight({},async()=>{n++;return {reason:'CHAIN_PREFLIGHT_FAILED',details:['QUOTE_HEAD_ADVANCED','QUOTE_HEAD_ADVANCED']}}))
    .rejects.toMatchObject({preflight:{reason:'CHAIN_PREFLIGHT_FAILED',details:['QUOTE_HEAD_ADVANCED','QUOTE_HEAD_ADVANCED'],attempts:2}})
  expect(n).toBe(2)
})
it('never retries permanent quote, allowance, order or wallet failures',async()=>{
  for(const reason of ['INVALID_REGISTER_ORDER','RPC_DISAGREEMENT_OR_CAP','WALLET_CODE_UNVERIFIED']) {
    let n=0
    await expect(checkedPreflight({},async()=>{n++;return {reason}})).rejects.toMatchObject({preflight:{reason,attempts:1}})
    expect(n).toBe(1)
  }
})
it('does not retry generic simulation failures, mixed permanent errors or thrown programmer errors',async()=>{
  for (const details of [['RPC_OR_SIMULATION_FAILED','EXTERNAL_WALLET_ACTION_REQUIRED'],['QUOTE_HEAD_ADVANCED','RPC_OR_SIMULATION_FAILED'],['CHAIN_OR_BLOCK_DRIFT','EXTERNAL_WALLET_ACTION_REQUIRED']]) {
    let n=0
    await expect(checkedPreflight({},async()=>{n++;return {reason:'CHAIN_PREFLIGHT_FAILED',details}})).rejects.toMatchObject({preflight:{attempts:1,details}})
    expect(n).toBe(1)
  }
  let n=0
  await expect(checkedPreflight({},async()=>{n++;throw new TypeError('programmer bug')})).rejects.toMatchObject({preflight:{reason:'PREFLIGHT_EXCEPTION',attempts:1}})
  expect(n).toBe(1)
})

it('rejects anything except dual RPC ready preflight',()=>{
  expect(()=>requireReady({reason:'CHAIN_PREFLIGHT_FAILED'})).toThrow()
  expect(()=>requireReady({reason:'REGISTER_EXECUTION_NOT_REVIEWED',broadcasts:true})).toThrow()
  expect(requireReady({reason:'REGISTER_EXECUTION_NOT_REVIEWED',broadcasts:false,block:{hash:'0x01'},quotedPrice:'2',allowance:'2'}).quotedPrice).toBe('2')
})
it('fsyncs durable exclusive no-retry reservation before signed hash, forbids collision',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'g2-register-lock-'))
  const file=join(dir,'journal.json')
  try {
    const fd=await reserveBeforeSend(file,{commitment:'0xabc'})
    expect(JSON.parse(await readFile(file,'utf8')).state).toBe('RESERVED_NO_RETRY')
    await expect(reserveBeforeSend(file,{commitment:'0xabc'})).rejects.toMatchObject({code:'EEXIST'})
    await recordSignedHash(fd,{hash:'0x123',nonce:42})
    await fd.close()
    expect(JSON.parse(await readFile(file,'utf8'))).toMatchObject({state:'SIGNED_NO_RETRY',hash:'0x123',nonce:42})
    await expect(reserveBeforeSend(file,{})).rejects.toMatchObject({code:'EEXIST'})
  } finally {await rm(dir,{recursive:true,force:true})}
})
it('requires two matching transaction receipts and refuses missing or conflicting RPC',async()=>{
  const hash='0x'+'ab'.repeat(32), blockHash='0x'+'cd'.repeat(32)
  const good={transactionHash:hash,blockHash,blockNumber:123n,status:'success'}
  const client=x=>({getTransactionReceipt:async()=>x})
  expect((await corroborateReceipt(client(good),client(good),hash)).status).toBe('CONFIRMED')
  expect((await corroborateReceipt(client(good),client({...good,blockHash:'0x01'}),hash)).status).toBe('RPC_DISAGREEMENT_DO_NOT_RETRY')
  expect((await corroborateReceipt(client(good),{getTransactionReceipt:async()=>{throw Error('offline')}},hash)).status).toBe('UNKNOWN_DO_NOT_RETRY')
})
it('rejects huge fees, RPC disagreement, excessive gas, and inadequate ETH',()=>{
 const ok={gasA:100000n,gasB:101000n,feeA:{maxFeePerGas:2_000_000_000n,maxPriorityFeePerGas:1_000_000_000n},feeB:{maxFeePerGas:2_100_000_000n,maxPriorityFeePerGas:1_000_000_000n},balanceA:10n**18n,balanceB:10n**18n}
 expect(validateFeeSafety(ok).gas).toBe(121200n)
 for(const changes of [{feeA:{...ok.feeA,maxFeePerGas:10n**15n}},{feeB:{...ok.feeB,maxFeePerGas:10n**15n}},{gasB:200000n},{balanceA:1n},{balanceB:1n}])
  expect(()=>validateFeeSafety({...ok,...changes})).toThrow('unsafe-fee-or-gas')
})
it('enforces durable journal before signing and hash before a single send; ambiguity retains lock',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'g2-register-flow-'))
 const journal=join(dir,'journal.json'),raw='0x02abcd',hash=(await import('viem')).keccak256(raw)
 let sends=0
 try {
  await expect(signThenSend({journal,commitment:'0xabc',orderExpiresAt:new Date(Date.now()+3600000).toISOString(),
   sign:async()=>{expect(JSON.parse(await readFile(journal,'utf8')).state).toBe('RESERVED_NO_RETRY');return {raw,nonce:1,calldataHash:hash,preflightBlock:hash}},
   send:async()=>{sends++;const disk=JSON.parse(await readFile(journal,'utf8'));expect(disk).toMatchObject({state:'SIGNED_NO_RETRY',hash});throw Error('network-uncertain')}})).rejects.toThrow('network-uncertain')
  expect(sends).toBe(1)
  expect(JSON.parse(await readFile(journal,'utf8')).hash).toBe(hash)
  await expect(signThenSend({journal,commitment:'0xabc',orderExpiresAt:new Date(Date.now()+3600000).toISOString(),sign:async()=>{throw Error('must never sign')},send:async()=>{sends++}})).rejects.toMatchObject({code:'EEXIST'})
  expect(sends).toBe(1)
 } finally {await rm(dir,{recursive:true,force:true})}
})

it('pins two independently served Sepolia RPC hosts and rejects the DNS-broken old alias',()=>{
 const urls=SEPOLIA_RPC_URLS.map(x=>new URL(x))
 expect(urls.map(x=>x.protocol)).toEqual(['https:','https:'])
 expect(urls.map(x=>x.hostname)).toEqual(['sepolia.rpc.thirdweb.com','ethereum-sepolia.publicnode.com'])
 expect(new Set(urls.map(x=>x.hostname)).size).toBe(2)
 expect(assertIndependentRpcPair(SEPOLIA_RPC_URLS)).toEqual(SEPOLIA_RPC_URLS)
 for (const pair of [[SEPOLIA_RPC_URLS[0],SEPOLIA_RPC_URLS[0]],['https://sepolia.gateway.tenderly.co',SEPOLIA_RPC_URLS[1]],['http://sepolia.rpc.thirdweb.com',SEPOLIA_RPC_URLS[1]],['https://user:pass@sepolia.rpc.thirdweb.com',SEPOLIA_RPC_URLS[1]]])
  expect(()=>assertIndependentRpcPair(pair)).toThrow()
})
