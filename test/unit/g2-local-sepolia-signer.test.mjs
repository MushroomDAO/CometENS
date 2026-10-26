import { describe,it,expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { validateOrder,validateChain,assertPrivateFile,awaitSubmittedReceipt } from '../../scripts/g2-local-sepolia-signer.mjs'
const a=JSON.parse(readFileSync(new URL('../../examples/g2-sepolia/01-approve.json',import.meta.url)))
const b=JSON.parse(readFileSync(new URL('../../examples/g2-sepolia/02-commit.json',import.meta.url)))
const m={label:'cometens-g2-20261023',wallet:a.from,durationSeconds:'31536000',maxTotalCost:'9000000',expectedRegistrarCodeHash:'0xb025a7edb8e81862c2d28857211a7a91c1fb2b17c5bcf28b983987067f083c2a',expectedTokenCodeHash:'0xa9a4749f886f5035336f6e16dce5ca6f339ae73f76e94ad4b8f46a447dc335f3'}
const salt={...m,commitment:b.commitment,salt:`0x${'33'.repeat(32)}`}
describe('G2 manual only signer input gate',()=>{
 it('fails closed on absent POSIX identity or incorrect file ownership/mode',()=>{
  const file = {isFile:()=>true,mode:0o100600,uid:501}
  expect(()=>assertPrivateFile(file,null)).toThrow('posix-ownership-check-required')
  expect(()=>assertPrivateFile(file,502)).toThrow('unsafe-file')
  expect(()=>assertPrivateFile({...file,mode:0o100644},501)).toThrow('unsafe-file')
  expect(()=>assertPrivateFile(file,501)).not.toThrow()
 })
 it('accepts bounded approve and refuses incorrect chain, signer, spender and unlimited allowance',()=>{
  expect(validateOrder(a,m,salt).action).toBe('approve')
  for(const x of [{chainId:1},{from:'0x0000000000000000000000000000000000000001'},{to:b.to},{amountBaseUnits:'9000001'},{amountBaseUnits:'115792089237316195423570985008687907853269984665640564039457584007913129639935'},{extra:1}])expect(()=>validateOrder({...a,...x},m,salt)).toThrow()
 })
 it('rejects mismatched commit secret/commitment and malformed action',()=>{
  expect(()=>validateOrder(b,m,salt)).toThrow('commitment-binding')
  expect(()=>validateOrder({...b,action:'register'},m,salt)).toThrow()
 })
 it('denies expiry and obsolete application intents',()=>{
  for(const x of [{expiresAt:'2020-01-01T00:00:00Z'},{expiresAt:'2040-01-01T00:00:00Z'}])expect(()=>validateOrder({...a,...x},m,salt)).toThrow()
 })
 it('checks real chain and pin before authorization',async()=>{
  await expect(validateChain({getChainId:async()=>1},a,m)).rejects.toThrow('wrong-chain')
  await expect(validateChain({getChainId:async()=>11155111,getBytecode:async()=>undefined},a,m)).rejects.toThrow('code-identity')
 })
})

describe('actual Sepolia chain guards with deterministic fake RPC',()=>{
 const timestamp=BigInt(Math.floor(Date.now()/1000))
 const fixed = {allowance:0n,balance:9000000n,base:8000021n,premium:0n,available:true,commitmentAt:0n,MAX_COMMITMENT_AGE:86400n}
 function fake(change={}) {
  const state={...fixed,...change}
  return {
   getChainId:async()=>11155111,
   getBlock:async()=>({number:123n,timestamp:change.timestamp??timestamp}),
   getBytecode:async({address})=>address.toLowerCase()==='0xf633e7fc17e2bbe0d0965d18ec1821dcb754a3d3' ? '0x01' : '0x02',
   readContract:async({functionName})=>functionName==='getRegisterPrice' ? [state.base,state.premium] : functionName==='isAvailable'?state.available:functionName==='balanceOf'?state.balance:state[functionName]
  }
 }
 // Pins are computed locally from fake deployed bytecode; this confirms the
 // guards run beyond the code identity check.
 const pinned={...m,expectedRegistrarCodeHash:'',expectedTokenCodeHash:''}
 it('rejects all six unsafe mutations while accepting valid approve and commit',async()=>{
  const {keccak256}=await import('viem')
  pinned.expectedRegistrarCodeHash=keccak256('0x01')
  pinned.expectedTokenCodeHash=keccak256('0x02')
  await expect(validateChain(fake(),a,pinned)).resolves.toMatchObject({functionName:'approve',price:8000021n})
  await expect(validateChain(fake({allowance:1n}),a,pinned)).rejects.toThrow('existing-allowance-manual-review')
  await expect(validateChain(fake({base:8000020n}),a,pinned)).rejects.toThrow('stale-approval-price')
  await expect(validateChain(fake({base:9000001n}),a,pinned)).rejects.toThrow('price-cap')
  await expect(validateChain(fake({balance:8000020n}),a,pinned)).rejects.toThrow('insufficient-token')
  await expect(validateChain(fake({available:false}),a,pinned)).rejects.toThrow('name-unavailable')
  await expect(validateChain(fake(),b,pinned)).resolves.toMatchObject({functionName:'commit'})
  await expect(validateChain(fake({commitmentAt:timestamp-60n}),b,pinned)).rejects.toThrow('commitment-already-live')
  await expect(validateChain(fake({commitmentAt:timestamp-86400n+1n}),b,pinned)).rejects.toThrow('commitment-already-live')
  await expect(validateChain(fake({commitmentAt:timestamp-86400n}),b,pinned)).resolves.toMatchObject({functionName:'commit'})
  await expect(validateChain(fake({commitmentAt:timestamp-86401n}),b,pinned)).resolves.toMatchObject({functionName:'commit'})
  await expect(validateChain(fake({commitmentAt:timestamp-86401n,MAX_COMMITMENT_AGE:0n}),b,pinned)).rejects.toThrow('commitment-window-unverified')
  await expect(validateChain(fake({commitmentAt:timestamp-86401n,MAX_COMMITMENT_AGE:undefined}),b,pinned)).rejects.toThrow('commitment-window-unverified')
  await expect(validateChain(fake({commitmentAt:timestamp-86401n,timestamp:0n}),b,pinned)).rejects.toThrow('commitment-block-unverified')
 })
})
it('keeps submitted hash and forbids retry when receipt waiting fails',async()=>{
 const hash=`0x${'ab'.repeat(32)}`
 const lines=[]
 const client={waitForTransactionReceipt:async()=>{throw Error('RPC timeout')}}
 expect(await awaitSubmittedReceipt(client,hash,'commit',x=>lines.push(JSON.parse(x)))).toBeNull()
 expect(lines).toMatchObject([{status:'SUBMITTED_UNCONFIRMED',hash,action:'commit',message:expect.stringContaining('DO NOT RETRY')}])
 expect(await awaitSubmittedReceipt({waitForTransactionReceipt:async()=>({status:'success'})},hash,'commit')).toMatchObject({status:'success'})
})
