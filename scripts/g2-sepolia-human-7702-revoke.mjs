#!/usr/bin/env node
/** Explicit human-only execution. NEVER invoke execute from automation. */
import {open, lstat, realpath} from 'node:fs/promises'
import {constants} from 'node:fs'
import {dirname, resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {createInterface} from 'node:readline/promises'
import {stdin,stdout} from 'node:process'
import {createPublicClient,createWalletClient,http,zeroAddress,keccak256} from 'viem'
import {privateKeyToAccount} from 'viem/accounts'
import {sepolia} from 'viem/chains'
import {checkRemote,WALLET,DELEGATE,CHAIN} from './check-g2-sepolia-7702-revocation.mjs'
const SAME=(a,b)=>String(a).toLowerCase()===String(b).toLowerCase()
const fail=s=>{throw Error(s)}
const PRIVATE_DIR=resolve(process.env.HOME ?? '/nonexistent','/.config/cometens-g2-sepolia'.slice(1))
const RPC=['https://sepolia.drpc.org','https://ethereum-sepolia-rpc.publicnode.com']
export function validate(o){
 if(!o||Object.keys(o).sort().join()!==['action','chainId','expiresAt','maxFeePerGasWei','maxGas','maxPriorityFeePerGasWei','version','wallet'].sort().join()||o.action!=='clear-7702'||o.version!==1||o.chainId!==CHAIN||!SAME(o.wallet,WALLET))fail('INVALID_ORDER')
 for(const k of ['maxGas','maxFeePerGasWei','maxPriorityFeePerGasWei'])if(typeof o[k]!=='string'||!/^[1-9]\d*$/.test(o[k]))fail('INVALID_AMOUNT')
 if(BigInt(o.maxGas)<46000n||BigInt(o.maxGas)>150000n||BigInt(o.maxFeePerGasWei)>100000000000n||BigInt(o.maxPriorityFeePerGasWei)>BigInt(o.maxFeePerGasWei)||BigInt(o.maxGas)*BigInt(o.maxFeePerGasWei)>1000000000000000n)fail('FEE_CAP')
 if(typeof o.expiresAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(o.expiresAt)||new Date(o.expiresAt).toISOString()!==o.expiresAt||Date.parse(o.expiresAt)<=Date.now()||Date.parse(o.expiresAt)>Date.now()+3600000)fail('EXPIRED')
 return o
}
export async function verify(clients,o,checker=checkRemote){
 const results=await Promise.all(clients.map(async c=>({snapshot:await checker(c),fees:await c.estimateFeesPerGas(),height:await c.getBlockNumber()})))
 const [a,b]=results
 if(results.some(x=>x.snapshot.status!=='READY_FOR_HUMAN_REVIEW'))fail('DELEGATION_OR_NONCE_CHANGED')
 if(a.snapshot.observedTransactionNonce!==b.snapshot.observedTransactionNonce||a.snapshot.verifiedDelegateCodeHash!==b.snapshot.verifiedDelegateCodeHash)fail('RPC_DISAGREEMENT')
 if(results.some(x=>!x.fees.maxFeePerGas||!x.fees.maxPriorityFeePerGas||x.fees.maxFeePerGas>BigInt(o.maxFeePerGasWei)||x.fees.maxPriorityFeePerGas>BigInt(o.maxPriorityFeePerGasWei)))fail('FEE_EXCEEDED')
 if(a.height>b.height+2n||b.height>a.height+2n)fail('RPC_BLOCK_DRIFT')
 return a.snapshot.observedTransactionNonce
}
export async function prepare(o,clients){return {status:'UNSIGNED_ONLY',nonce:await verify(clients,o),target:zeroAddress,chainId:CHAIN,wallet:WALLET,delegate:DELEGATE}}
export async function assertPrivatePath(path,{mustExist=false}={}){
 if(typeof path!=='string'||!path.startsWith(PRIVATE_DIR+'/')||dirname(path)!==PRIVATE_DIR)fail('PATH_OUTSIDE_PRIVATE_DIR')
 const dir=await lstat(PRIVATE_DIR)
 if(!dir.isDirectory()||(dir.mode&0o077)!==0||dir.uid!==process.getuid()||await realpath(PRIVATE_DIR)!==PRIVATE_DIR)fail('UNSAFE_PRIVATE_DIR')
 try{const st=await lstat(path);if(st.isSymbolicLink()||!st.isFile()||(st.mode&0o777)!==0o600||st.uid!==process.getuid())fail('UNSAFE_FILE');return st}catch(e){if(mustExist||e.code!=='ENOENT')throw e}
}
async function secureRead(path){
 await assertPrivatePath(path,{mustExist:true})
 const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW)
 try{
  const st=await f.stat()
  if(!st.isFile()||(st.mode&0o777)!==0o600||st.uid!==process.getuid())fail('UNSAFE_FILE_DESCRIPTOR')
  return await f.readFile('utf8')
 }finally{await f.close()}
}
const persistent=async(path,obj)=>{const f=await open(path,'wx',0o600);try{await f.writeFile(JSON.stringify(obj)+'\n');await f.sync()}finally{await f.close()}}
export async function executeVerified({o,clients,wallet,account,nonce,journalPath,
 recheck=verify,guard=assertPrivatePath,persist=persistent}){
 validate(o)
 if(!SAME(account?.address,WALLET))fail('WRONG_SIGNER')
 const authorization=await wallet.signAuthorization({contractAddress:zeroAddress,executor:'self',chainId:CHAIN})
 if(!SAME(authorization.address,zeroAddress)||BigInt(authorization.nonce)!==BigInt(nonce+1))fail('AUTH_NONCE_MISMATCH')
 if(await recheck(clients,o)!==nonce)fail('NONCE_RACE_AFTER_AUTHORIZATION')
 const tx={account,chain:sepolia,chainId:CHAIN,type:'eip7702',to:WALLET,
  data:'0x',value:0n,nonce,gas:BigInt(o.maxGas),maxFeePerGas:BigInt(o.maxFeePerGasWei),
  maxPriorityFeePerGas:BigInt(o.maxPriorityFeePerGasWei),authorizationList:[authorization]}
 // signTransaction never broadcasts. Durable hash must exist before the first send.
 const serialized=await wallet.signTransaction(tx)
 const hash=keccak256(serialized)
 await guard(journalPath+'.hash')
 await persist(journalPath+'.hash',{state:'SIGNED_BEFORE_BROADCAST',hash,nonce,chainId:CHAIN,
  warning:'Single send only. On uncertain outcome inspect hash across RPCs; never automatically retry.'})
 await guard(journalPath+'.attempt')
 await persist(journalPath+'.attempt',{state:'BROADCAST_ATTEMPT_UNKNOWN_NO_RETRY',hash,nonce,chainId:CHAIN})
 const returned=await wallet.sendRawTransaction({serializedTransaction:serialized})
 if(!SAME(returned,hash))fail('BROADCAST_HASH_MISMATCH')
 const receipt=await clients[0].waitForTransactionReceipt({hash,confirmations:2,timeout:120000})
 if(receipt.status!=='success')fail('REVERTED')
 const transactions=await Promise.all(clients.map(c=>c.getTransaction({hash})))
 for(const observed of transactions){
  if(!observed||!SAME(observed.from,WALLET)||!SAME(observed.to,WALLET)||
   BigInt(observed.nonce)!==BigInt(nonce)||BigInt(observed.chainId)!==BigInt(CHAIN)||!['eip7702','0x4','0x04',4].includes(observed.type)||
   !Array.isArray(observed.authorizationList)||observed.authorizationList.length!==1)fail('TYPE4_MISMATCH')
  const a=observed.authorizationList[0]
  if(!SAME(a.address,zeroAddress)||BigInt(a.nonce)!==BigInt(nonce+1)||
   BigInt(a.chainId)!==BigInt(CHAIN))fail('AUTHORIZATION_MISMATCH')
 }
 // Two confirmations are not finality. Require finalized block on both RPC providers.
 const finalized=await Promise.all(clients.map(c=>c.getBlock({blockTag:'finalized'})))
 if(finalized.some(b=>b.number===null||b.number<receipt.blockNumber)||
  !SAME(finalized[0].hash,finalized[1].hash))fail('FINALITY_PENDING')
 const codes=await Promise.all(clients.map(c=>c.getBytecode({address:WALLET,blockNumber:receipt.blockNumber})))
 if(codes.some(x=>x&&x!=='0x'))fail('POSTCONDITION_PENDING')
 return {status:'DELEGATION_CLEARED_FINALIZED',hash}
}
async function main(){
 const [mode,orderPath,keyPath,journalPath]=process.argv.slice(2)
 if(!['check','execute'].includes(mode)||!orderPath||process.argv.length!==(mode==='check'?4:6))fail('USAGE')
 await assertPrivatePath(orderPath,{mustExist:true})
 const o=validate(JSON.parse(await secureRead(orderPath)))
 if(mode==='execute'&&(!stdin.isTTY||!stdout.isTTY))fail('HUMAN_TTY_REQUIRED')
 const clients=RPC.map(url=>createPublicClient({chain:sepolia,transport:http(url,{retryCount:0,timeout:15000}),ccipRead:false}))
 const pre=await prepare(o,clients)
 console.log(JSON.stringify(pre))
 if(mode==='check')return
 await assertPrivatePath(keyPath,{mustExist:true})
 await assertPrivatePath(journalPath)
 // Exclusive journal reservation precedes access to any signing key.
 await persistent(journalPath,{state:'RESERVED_NO_RETRY',wallet:WALLET,nonce:pre.nonce,createdAt:new Date().toISOString()})
 const ui=createInterface({input:stdin,output:stdout})
 try{if(await ui.question('This removes delegated smart-account capabilities. Type CLEAR SEPOLIA DELEGATION: ')!=='CLEAR SEPOLIA DELEGATION')fail('DECLINED')}
 finally{ui.close()}
 validate(o)
 if(await verify(clients,o)!==pre.nonce)fail('NONCE_RACE')
 const st=await assertPrivatePath(keyPath,{mustExist:true})
 if((st.mode&0o777)!==0o600||!st.isFile()||st.uid!==process.getuid())fail('UNSAFE_KEY_FILE')
 const secret=(await secureRead(keyPath)).trim()
 if(!/^0x[0-9a-fA-F]{64}$/.test(secret))fail('KEY_FORMAT')
 const account=privateKeyToAccount(secret)
 if(!SAME(account.address,WALLET))fail('WRONG_SIGNER')
 const wallet=createWalletClient({account,chain:sepolia,transport:http(RPC[0],{retryCount:0,timeout:15000})})
 return await executeVerified({o,clients,wallet,account,nonce:pre.nonce,journalPath})
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(e=>{console.error('BLOCKED',e.message,'No automatic retry; inspect journal and chain.');process.exitCode=2})
