import { it,expect } from 'vitest'
import { mkdtemp,readFile,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reserveBeforeSend,recordSignedHash,corroborateReceipt,requireReady } from '../../scripts/g2-human-ensv2-register.mjs'

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
