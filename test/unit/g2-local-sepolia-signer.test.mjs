import { describe,it,expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { validateOrder,validateChain,assertPrivateFile } from '../../scripts/g2-local-sepolia-signer.mjs'
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
