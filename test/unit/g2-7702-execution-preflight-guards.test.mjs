import {it,expect} from 'vitest'
import {mkdtempSync,mkdirSync,chmodSync,writeFileSync,readFileSync,rmSync,symlinkSync,realpathSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {execFileSync} from 'node:child_process'
import {verify} from '../../scripts/g2-sepolia-human-7702-revoke.mjs'
import {WALLET,DELEGATE,DELEGATE_HASH,CHAIN} from '../../scripts/check-g2-sepolia-7702-revocation.mjs'

const order=()=>({version:1,action:'clear-7702',wallet:WALLET,chainId:CHAIN,maxGas:'60000',maxFeePerGasWei:'100000000',maxPriorityFeePerGasWei:'2000000',expiresAt:new Date(Date.now()+300000).toISOString()})
// Invoke actual checkRemote and checkPinnedCode, with only the transport mocked.
const delegateBytecode='0x6001600055'
const rpc=(overrides={})=>({
 getChainId:async()=>CHAIN,
 getTransactionCount:async()=>7,
 getBytecode:async({address})=>address.toLowerCase()===WALLET.toLowerCase()?'0xef0100'+DELEGATE.slice(2):delegateBytecode,
 getBlockNumber:async()=>100n,
 getBlock:async({blockNumber})=>({number:blockNumber,hash:'0x'+'aa'.repeat(32)}),
 estimateFeesPerGas:async()=>({maxFeePerGas:100n,maxPriorityFeePerGas:1n}),
 ...overrides,
})
// Actual pinned code hash is fixed in the production module; use the published hash via a fixture override.
// The first comparison is mocked ONLY for pinned bytecode to avoid assuming deployed code bytes.
const pinned=async()=>{}
it('verify with two distinct RPC client objects rejects nonce/delegation disagreement',async()=>{
 const checker=async c=>({status:'READY_FOR_HUMAN_REVIEW',observedTransactionNonce:await c.getTransactionCount({address:WALLET,blockTag:'latest'}),verifiedDelegateCodeHash:await c.getBytecode({address:DELEGATE})})
 const ordinary=rpc(),badNonce=rpc({getTransactionCount:async()=>8})
 await expect(verify([ordinary,badNonce],order(),checker,pinned)).rejects.toThrow('RPC_DISAGREEMENT')
 const changed=rpc({getBytecode:async({address})=>address.toLowerCase()===DELEGATE.toLowerCase()?'0x6002':'0xef0100'+DELEGATE.slice(2)})
 await expect(verify([ordinary,changed],order(),checker,pinned)).rejects.toThrow('RPC_DISAGREEMENT')
})
it('real verify rejects identical height but different canonical block hash',async()=>{
 const a=rpc(),b=rpc({getBlock:async({blockNumber})=>({number:blockNumber,hash:'0x'+'bb'.repeat(32)})})
 await expect(verify([a,b],order(),async()=>({status:'READY_FOR_HUMAN_REVIEW',observedTransactionNonce:7,verifiedDelegateCodeHash:DELEGATE_HASH}),pinned)).rejects.toThrow('RPC_CANONICAL_BLOCK_MISMATCH')
})
it('0700 private directory checks and real exclusive journal collisions fail closed',()=>{
 const root=mkdtempSync(join(tmpdir(),'g2-private-'))
 const home=join(root,'home'),dir=join(home,'.config','cometens-g2-sepolia')
 mkdirSync(dir,{recursive:true,mode:0o700});chmodSync(dir,0o700)
 const file=join(realpathSync(dir),'journal.hash');writeFileSync(file,'ORIGINAL\n',{mode:0o600});chmodSync(file,0o600)
 const script=new URL('../../scripts/g2-sepolia-human-7702-revoke.mjs',import.meta.url).pathname
 const runner=String.raw`const file=process.argv[1];process.env.HOME=process.argv[2]; const {assertPrivatePath,persistent}=await import(${JSON.stringify('SCRIPT_URL')}); await assertPrivatePath(file,{mustExist:true}); try { await persistent(file,{unsafe:true});process.exitCode=88 } catch(e) { if(e.code!=='EEXIST')throw e; console.log('COLLISION_BLOCKED') }`
 const launch=(target,opts={})=>execFileSync(process.execPath,['--input-type=module','-e',runner.replace('SCRIPT_URL','file://'+script),target,realpathSync(home)],{env:{...process.env,HOME:home},encoding:'utf8',...opts})
 try{
  expect(launch(file)).toContain('COLLISION_BLOCKED')
  expect(readFileSync(file,'utf8')).toBe('ORIGINAL\n')
  chmodSync(dir,0o755)
  expect(()=>launch(file)).toThrow()
  chmodSync(dir,0o700)
  const unsafe=join(dir,'linked.hash');symlinkSync(file,unsafe)
  expect(()=>launch(unsafe)).toThrow()
 }finally{rmSync(root,{recursive:true,force:true})}
})
