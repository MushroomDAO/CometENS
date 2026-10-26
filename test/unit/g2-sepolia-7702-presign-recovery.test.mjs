import {it,expect,vi} from 'vitest'
import {parseTestWalletKey,recoverPreSign} from '../../scripts/g2-sepolia-human-7702-revoke.mjs'
import {WALLET} from '../../scripts/check-g2-sepolia-7702-revocation.mjs'
const journal='/private/mock/journal.json'
const original=JSON.stringify({state:'RESERVED_NO_RETRY',nonce:748,wallet:WALLET,createdAt:'2026-10-25T12:00:00Z'})
const order={version:1,action:'clear-7702',chainId:11155111,wallet:WALLET,maxGas:'60000',maxFeePerGasWei:'1000000000',maxPriorityFeePerGasWei:'100000000',expiresAt:new Date(Date.now()+90000).toISOString()}
const fixture=(overrides={})=>{const files=new Map([[journal,original]]),calls=[];
 const guard=async(path,{mustExist=false}={})=>{if(mustExist&&!files.has(path)){const e=Error('ENOENT');e.code='ENOENT';throw e}if(!mustExist&&files.has(path))throw Error('collision')};
 const persist=async(path,data)=>{if(files.has(path))throw Error('collision');files.set(path,JSON.stringify(data));calls.push(path)};
 return {files,calls,args:{journalPath:journal,clients:[{},{}],order,ask:async()=> 'RECOVER PRE-SIGN NONCE 748',read:async path=>files.get(path),guard,persist,check:async()=>748,...overrides}}
}
it('prelock format rejects without creating journals and accepts prefix variants',()=>{
 const derived=vi.fn(()=>({address:WALLET}));expect(parseTestWalletKey('ab'.repeat(32),derived).address).toBe(WALLET)
 expect(parseTestWalletKey('0x'+'ab'.repeat(32),derived).address).toBe(WALLET)
 expect(()=>parseTestWalletKey('0xz',derived)).toThrow('KEY_FORMAT')
 expect(()=>parseTestWalletKey('ab'.repeat(32),()=>({address:'0x0000000000000000000000000000000000000000'}))).toThrow('WRONG_SIGNER')
})
it('nonbroadcast recovery writes exclusive evidence and preserves journal',async()=>{
 const f=fixture();expect(await recoverPreSign(f.args)).toMatchObject({status:'PRE_SIGN_RECOVERY_EVIDENCE_RECORDED',retry:false})
 expect(f.files.get(journal)).toBe(original);expect(f.calls).toEqual([journal+'.pre-sign-recovery'])
 expect(JSON.parse(f.files.get(journal+'.pre-sign-recovery'))).toMatchObject({authorizationSigned:false,broadcast:false})
 await expect(recoverPreSign(f.args)).rejects.toThrow()
})
it.each(['.attempt','.hash','.pre-sign-recovery'])('rejects existing %s audit artifact',async suffix=>{
 const f=fixture();f.files.set(journal+suffix,'{}');await expect(recoverPreSign(f.args)).rejects.toThrow();expect(f.calls).toEqual([])
})
it('rejects changed nonce, decline, and races without reexecute',async()=>{
 for(const overrides of [{check:async()=>749},{ask:async()=> 'NO'},{}]){
 const f=fixture(overrides);if(!Object.keys(overrides).length){let n=0;f.args.check=async()=>++n===1?748:749}
 await expect(recoverPreSign(f.args)).rejects.toThrow()
 expect(f.files.has(journal+'.attempt')).toBe(false)
 }
})
it('concurrent claims allow at most one recovery artifact',async()=>{
 const f=fixture();const results=await Promise.allSettled([recoverPreSign(f.args),recoverPreSign(f.args)])
 expect(results.filter(x=>x.status==='fulfilled')).toHaveLength(1)
 expect(f.calls).toEqual([journal+'.pre-sign-recovery'])
})
