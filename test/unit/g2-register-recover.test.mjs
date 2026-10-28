import {it,expect} from 'vitest'
import {validateJournal,recoverStatus} from '../../scripts/g2-register-recover.mjs'
const hash='0x'+'ab'.repeat(32),commitment='0x'+'cd'.repeat(32)
const j={state:'SIGNED_NO_RETRY',hash,commitment,nonce:752,chainId:11155111,calldataHash:hash,preflightBlock:hash}
const path=`/tmp/ensv2-register-${commitment.slice(2)}.journal.json`
const client=({pending=752,latest=752,tx=null,receipt=null}={})=>({getChainId:async()=>11155111,getTransaction:async()=>tx,getTransactionReceipt:async()=>receipt,getTransactionCount:async({blockTag})=>blockTag==='pending'?pending:latest})
it('strict journal metadata and path validation',()=>{expect(validateJournal(j,path).nonce).toBe(752);for(const bad of [{...j,state:'RESERVED_NO_RETRY'},{...j,hash:'0x01'},{...j,nonce:-1},{...j,chainId:1}])expect(()=>validateJournal(bad,path)).toThrow();expect(()=>validateJournal(j,'/tmp/other')).toThrow()})
it('no visibility and nonce 752 => UNKNOWN not retry permission',async()=>{expect(await recoverStatus(j,[client(),client()])).toMatchObject({status:'UNKNOWN_DO_NOT_RETRY',pendingNonce:752,lockedNonce:752})})
it('disagreement and RPC failures remain blocked',async()=>{expect((await recoverStatus(j,[client(),client({pending:753})])).status).toBe('RPC_DISAGREEMENT_DO_NOT_RETRY');expect((await recoverStatus(j,[client(),{...client(),getChainId:async()=>{throw Error('down')}}])).status).toBe('RPC_UNVERIFIABLE_DO_NOT_RETRY')})
it('mined receipt still requires owner verification',async()=>{const receipt={blockHash:hash,blockNumber:20n,status:'success'};expect((await recoverStatus(j,[client({receipt}),client({receipt})])).status).toBe('MINED_SUCCESS_VERIFY_NATIVE_OWNERSHIP')})
