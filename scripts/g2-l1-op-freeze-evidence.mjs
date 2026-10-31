/** G2.4 evidence-only L1-to-OP authority gate; no issuance or sovereignty claim. */
import {keccak256,toHex} from 'viem'
export const ETH_REGISTRY='0xd4ebcbbdf463c9c45784603db0ddd499bc44a8b4'
export const STATE_ABI=[{type:'function',name:'getState',stateMutability:'view',inputs:[{type:'uint256',name:'id'}],outputs:[{type:'tuple',components:[{type:'uint8',name:'status'},{type:'uint64',name:'expiry'},{type:'address',name:'latestOwner'},{type:'uint256',name:'a'},{type:'uint256',name:'b'}]}]}]
const ZERO='0x0000000000000000000000000000000000000000'
const HEX32=/^0x[0-9a-f]{64}$/i
const ADDR=/^0x[0-9a-f]{40}$/i
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase()
const denied=(reason)=>({decision:'FREEZE_OP_AUTHORITY',reason,nativeAuthorityVerified:false,sovereign:false})
/** Minimum same-host screening only; distinct hostnames do not prove operator independence. */
export function providerIdentity(client) {
 try {
  const raw=client?.transport?.url
  if(typeof raw!=='string')return null
  const u=new URL(raw)
  if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash)return null
  const host=u.hostname.toLowerCase().replace(/\.+$/,'')
  if(!host||u.port&&u.port!=='443')return null
  return host
 }catch{return null}
}
function withDeadline(work,ms) {
 let timer
 return Promise.race([work(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('RPC_DEADLINE')),ms)})])
  .finally(()=>clearTimeout(timer))
}
/** Snapshots are pinned per provider and always require live L1 evidence. */
export async function evaluateL1OpFreeze({clients,label,expectedOwner,priorOwner,nowSeconds,maxAgeSeconds=1800n,timeoutMs=8000}){
 if(!Array.isArray(clients)||clients.length!==2||clients[0]===clients[1]||!providerIdentity(clients[0])||!providerIdentity(clients[1])||providerIdentity(clients[0])===providerIdentity(clients[1])||!ADDR.test(expectedOwner??'')||!ADDR.test(priorOwner??'')||!Number.isSafeInteger(nowSeconds)||typeof maxAgeSeconds!=='bigint'||maxAgeSeconds<1200n||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000||typeof label!=='string'||!(/^[a-z0-9-]{1,63}$/).test(label))return denied('INVALID_EVIDENCE_INPUT')
 const id=BigInt(keccak256(toHex(label)))
 const results=await Promise.allSettled(clients.map(c=>withDeadline(async()=>{
  const chain=await c.getChainId()
  const block=await c.getBlock({blockTag:'finalized'})
  if(chain!==11155111||typeof block?.number!=='bigint'||!HEX32.test(block?.hash??'')||typeof block.timestamp!=='bigint')throw Error('INVALID_FINALIZED_BLOCK')
  const state=await c.readContract({address:ETH_REGISTRY,abi:STATE_ABI,functionName:'getState',args:[id],blockNumber:block.number})
  const again=await c.getBlock({blockNumber:block.number})
  if(!same(again?.hash,block.hash))throw Error('REORG')
  return {block,state}
 },timeoutMs)))
 if(results.some(r=>r.status!=='fulfilled'))return denied('RPC_OR_FINALITY_UNVERIFIED')
 const [a,b]=results.map(r=>r.value)
 if(a.block.number!==b.block.number||!same(a.block.hash,b.block.hash)||a.block.timestamp!==b.block.timestamp)return denied('L1_RPC_FINALITY_DISAGREEMENT')
 if(BigInt(nowSeconds)<a.block.timestamp||BigInt(nowSeconds)-a.block.timestamp>maxAgeSeconds)return denied('STALE_L1_FINALITY_EVIDENCE')
 const parse=s=>Array.isArray(s)?{status:s[0],expiry:s[1],owner:s[2]}:s&&typeof s==='object'?{status:s.status,expiry:s.expiry,owner:s.latestOwner}:null
 const x=parse(a.state),y=parse(b.state)
 if(!x||!y||typeof x.expiry!=='bigint'||typeof y.expiry!=='bigint'||x.status!==y.status||x.expiry!==y.expiry||!same(x.owner,y.owner))return denied('L1_STATE_DISAGREEMENT')
 if(typeof x.expiry!=='bigint'||!ADDR.test(x.owner??'')||x.expiry<=BigInt(nowSeconds)||same(x.owner,ZERO)||x.status!==2)return denied('L1_NATIVE_OWNERSHIP_INACTIVE')
 if(!same(x.owner,expectedOwner)||!same(x.owner,priorOwner))return denied('L1_TRANSFER_OR_OWNER_CHANGED')
 return {decision:'EVIDENCE_MATCH_ONLY_NOT_AUTHORIZATION',reason:'REQUIRES_L1_TO_OP_PROOF_AND_FRESHNESS_POLICY',nativeAuthorityVerified:false,sovereign:false,block:{number:String(a.block.number),hash:a.block.hash},owner:x.owner,expiry:String(x.expiry)}
}
