import {it,expect,vi} from 'vitest'
import {evaluateL1OpFreeze,providerIdentity} from '../../scripts/g2-l1-op-freeze-evidence.mjs'
const owner='0x1111111111111111111111111111111111111111',other='0x2222222222222222222222222222222222222222',hash='0x'+'ab'.repeat(32)
let identity=0
const c=({number=200n,timestamp=1000n,expiry=3000n,who=owner,status=2,delay=false}={})=>({transport:{url:`https://rpc${++identity}.example/`},getChainId:async()=>11155111,getBlock:async({blockTag})=>({number,hash:blockTag?'0x'+(delay?'cd':'ab').repeat(32):hash,timestamp}),readContract:async()=>[status,expiry,who,0n,0n]})
const run=(a,b,nowSeconds=1020,priorOwner=owner)=>evaluateL1OpFreeze({clients:[c(a),c(b)],label:'cometens-g2-20261023',expectedOwner:owner,priorOwner,nowSeconds})
it('consistent evidence still cannot authorize or promote sovereignty',async()=>{expect(await run({},{})).toMatchObject({decision:'EVIDENCE_MATCH_ONLY_NOT_AUTHORIZATION',nativeAuthorityVerified:false,sovereign:false})})
it.each([[{who:other},{}],[{}, {who:other}],[{expiry:1010n},{}],[{status:0},{}],[{number:199n},{}],[{delay:true},{}]])('delayed/stale transfer, expiry, mismatch or reorg freeze %#',async(a,b)=>{expect((await run(a,b)).decision).toBe('FREEZE_OP_AUTHORITY')})
it('stale finality freezes even with matching old owner',async()=>{expect((await run({}, {},3000)).reason).toBe('STALE_L1_FINALITY_EVIDENCE')})
it('previous owner mismatch freezes despite fresh two-provider agreement',async()=>{expect((await run({}, {},1020,other)).reason).toBe('L1_TRANSFER_OR_OWNER_CHANGED')})
it('RPC rejection fails closed',async()=>{
 const a=c(),b=c()
 const read=vi.spyOn(b,'readContract').mockRejectedValue(Error('rpc-fault'))
 const result=await evaluateL1OpFreeze({clients:[a,b],label:'x',expectedOwner:owner,priorOwner:owner,nowSeconds:1020})
 expect(read).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({blockNumber:200n}))
 expect(result).toMatchObject({decision:'FREEZE_OP_AUTHORITY',reason:'RPC_OR_FINALITY_UNVERIFIED'})
})

it('bounded hung RPC fails closed',async()=>{const a=c(),b=c();b.getBlock=()=>new Promise(()=>{});expect((await evaluateL1OpFreeze({clients:[a,b],label:'x',expectedOwner:owner,priorOwner:owner,nowSeconds:1020,timeoutMs:10})).reason).toBe('RPC_OR_FINALITY_UNVERIFIED')})
it('same client or same provider URL fails closed',async()=>{const a=c(),b=c();expect((await evaluateL1OpFreeze({clients:[a,a],label:'x',expectedOwner:owner,priorOwner:owner,nowSeconds:1020})).reason).toBe('INVALID_EVIDENCE_INPUT');b.transport.url=a.transport.url;expect((await evaluateL1OpFreeze({clients:[a,b],label:'x',expectedOwner:owner,priorOwner:owner,nowSeconds:1020})).reason).toBe('INVALID_EVIDENCE_INPUT')})
it('finalized lag 780 seconds is permitted but never authorizes',async()=>{expect((await run({},{},1780)).decision).toBe('EVIDENCE_MATCH_ONLY_NOT_AUTHORIZATION')})
it('malformed expiry, max age and missing priorOwner freeze',async()=>{for(const expiry of ['bad',null])expect((await run({expiry},{})).decision).toBe('FREEZE_OP_AUTHORITY');expect((await evaluateL1OpFreeze({clients:[c(),c()],label:'x',expectedOwner:owner,nowSeconds:1020})).decision).toBe('FREEZE_OP_AUTHORITY');expect((await evaluateL1OpFreeze({clients:[c(),c()],label:'x',expectedOwner:owner,priorOwner:owner,nowSeconds:1020,maxAgeSeconds:'bad'})).decision).toBe('FREEZE_OP_AUTHORITY')})
it('chainId, zero owner, expiry boundary, expected owner, reorg and future block freeze',async()=>{const a=c(),b=c();a.getChainId=async()=>1;expect((await evaluateL1OpFreeze({clients:[a,b],label:'x',expectedOwner:owner,priorOwner:owner,nowSeconds:1020})).decision).toBe('FREEZE_OP_AUTHORITY');for(const opts of [{who:'0x0000000000000000000000000000000000000000'},{expiry:1020n},{delay:true},{timestamp:2000n}])expect((await run(opts,{})).decision).toBe('FREEZE_OP_AUTHORITY');expect((await run({}, {},1020,other)).decision).toBe('FREEZE_OP_AUTHORITY')})

it('normalizes provider identity and rejects two URLs on same host',async()=>{
 const a=c(),b=c();a.transport.url='https://RPC.EXAMPLE:443/a';b.transport.url='https://rpc.example/b'
 expect(providerIdentity(a)).toBe('rpc.example')
 expect((await evaluateL1OpFreeze({clients:[a,b],label:'x',expectedOwner:owner,priorOwner:owner,nowSeconds:1020})).reason).toBe('INVALID_EVIDENCE_INPUT')
})
it('correct prior owner and pinned block pass only as non-authorization; block mismatches fail',async()=>{
 const a=c(),b=c();let pinned=0
 a.readContract=async args=>{expect(args.blockNumber).toBe(200n);pinned++;return [2,3000n,owner,0n,0n]}
 b.readContract=a.readContract
 expect((await evaluateL1OpFreeze({clients:[a,b],label:'x',expectedOwner:owner,priorOwner:owner,nowSeconds:1020})).decision).toBe('EVIDENCE_MATCH_ONLY_NOT_AUTHORIZATION')
 expect(pinned).toBe(2)
 a.getBlock=async ({blockTag})=>({number:200n,hash:'0x'+(blockTag?'ab':'cd').repeat(32),timestamp:1000n})
 expect((await evaluateL1OpFreeze({clients:[a,b],label:'x',expectedOwner:owner,priorOwner:owner,nowSeconds:1020})).decision).toBe('FREEZE_OP_AUTHORITY')
})
it.each([
 ['status 1',{status:1}],
 ['status 0',{status:0}],
 ['zero owner',{who:'0x0000000000000000000000000000000000000000'}],
 ['expiry boundary',{expiry:1020n}],
])('matching inactive states freeze for the native ownership reason: %s',async(_reason,v)=>{
 expect(await run(v,v)).toMatchObject({decision:'FREEZE_OP_AUTHORITY',reason:'L1_NATIVE_OWNERSHIP_INACTIVE'})
})

it.each([
 ['https://rpc.example/a','https://RPC.EXAMPLE.:443/b'],
 ['https://RPC.EXAMPLE.:443/b','https://rpc.example/a'],
])('minimum same-host screening rejects trailing-dot aliases: %s, %s',async(first,second)=>{
 const a=c(),b=c()
 a.transport.url=first;b.transport.url=second
 expect((await evaluateL1OpFreeze({clients:[a,b],label:'x',expectedOwner:owner,priorOwner:owner,nowSeconds:1020})).reason).toBe('INVALID_EVIDENCE_INPUT')
 expect(providerIdentity(a)).toBe('rpc.example')
 expect(providerIdentity(b)).toBe('rpc.example')
})

it.each([
 ['http','http://rpc.example/'],
 ['userinfo username','https://user@rpc.example/'],
 ['userinfo password','https://:password@rpc.example/'],
 ['query','https://rpc.example/?network=sepolia'],
 ['hash','https://rpc.example/#sepolia'],
 ['port 8443','https://rpc.example:8443/'],
])('rejects provider URL with %s before RPC',async(_reason,url)=>{
 const a=c(),b=c()
 a.transport.url=url
 const rpc=vi.spyOn(a,'getChainId')
 expect(providerIdentity(a)).toBeNull()
 expect(await evaluateL1OpFreeze({clients:[a,b],label:'x',expectedOwner:owner,priorOwner:owner,nowSeconds:1020})).toMatchObject({decision:'FREEZE_OP_AUTHORITY',reason:'INVALID_EVIDENCE_INPUT'})
 expect(rpc).not.toHaveBeenCalled()
})

it.each(['success','rejection'])('clears deadline timers after RPC %s',async outcome=>{
 vi.useFakeTimers()
 try {
  expect(vi.getTimerCount()).toBe(0)
  const a=c(),b=c()
  const read=vi.spyOn(b,'readContract')
  if(outcome==='rejection')read.mockRejectedValue(Error('rpc-fault'))
  const result=await evaluateL1OpFreeze({clients:[a,b],label:'x',expectedOwner:owner,priorOwner:owner,nowSeconds:1020})
  expect(read).toHaveBeenCalledOnce()
  expect(result).toMatchObject(outcome==='success'
   ?{decision:'EVIDENCE_MATCH_ONLY_NOT_AUTHORIZATION',reason:'REQUIRES_L1_TO_OP_PROOF_AND_FRESHNESS_POLICY'}
   :{decision:'FREEZE_OP_AUTHORITY',reason:'RPC_OR_FINALITY_UNVERIFIED'})
  expect(vi.getTimerCount()).toBe(0)
 }finally{
  vi.clearAllTimers()
  vi.useRealTimers()
 }
})

it.each([[1000n,1001n],[1001n,1000n]])('different finalized timestamps freeze in either provider order: %s, %s',async(first,second)=>{
 expect(await run({timestamp:first},{timestamp:second})).toMatchObject({decision:'FREEZE_OP_AUTHORITY',reason:'L1_RPC_FINALITY_DISAGREEMENT'})
})
