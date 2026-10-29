import {it,expect} from 'vitest'
import {evaluateL1OpFreeze} from '../../scripts/g2-l1-op-freeze-evidence.mjs'
const owner='0x1111111111111111111111111111111111111111',other='0x2222222222222222222222222222222222222222',hash='0x'+'ab'.repeat(32)
const c=({number=200n,timestamp=1000n,expiry=3000n,who=owner,status=2,delay=false}={})=>({getChainId:async()=>11155111,getBlock:async({blockTag})=>({number,hash:blockTag?'0x'+(delay?'cd':'ab').repeat(32):hash,timestamp}),readContract:async()=>[status,expiry,who,0n,0n]})
const run=(a,b,nowSeconds=1020,priorOwner=owner)=>evaluateL1OpFreeze({clients:[c(a),c(b)],label:'cometens-g2-20261023',expectedOwner:owner,priorOwner,nowSeconds})
it('consistent evidence still cannot authorize or promote sovereignty',async()=>{expect(await run({},{})).toMatchObject({decision:'EVIDENCE_MATCH_ONLY_NOT_AUTHORIZATION',nativeAuthorityVerified:false,sovereign:false})})
it.each([[{who:other},{}],[{}, {who:other}],[{expiry:1010n},{}],[{status:0},{}],[{number:199n},{}],[{delay:true},{}]])('delayed/stale transfer, expiry, mismatch or reorg freeze %#',async(a,b)=>{expect((await run(a,b)).decision).toBe('FREEZE_OP_AUTHORITY')})
it('stale finality freezes even with matching old owner',async()=>{expect((await run({}, {},1200)).reason).toBe('STALE_L1_FINALITY_EVIDENCE')})
it('previous owner mismatch freezes despite fresh two-provider agreement',async()=>{expect((await run({}, {},1020,other)).reason).toBe('L1_TRANSFER_OR_OWNER_CHANGED')})
it('RPC rejection fails closed',async()=>{const a=c(),b={...c(),readContract:async()=>{throw Error('rpc-fault')}};expect((await evaluateL1OpFreeze({clients:[a,b],label:'x',expectedOwner:owner,nowSeconds:1020})).decision).toBe('FREEZE_OP_AUTHORITY')})
