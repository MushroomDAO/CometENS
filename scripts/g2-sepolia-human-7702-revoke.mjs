#!/usr/bin/env node
/** Explicit human-only execution. NEVER invoke execute from automation. */
import {open, lstat, realpath} from 'node:fs/promises'
import {constants,realpathSync} from 'node:fs'
import {dirname, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createInterface} from 'node:readline/promises'
import {stdin,stdout} from 'node:process'
import {createPublicClient,createWalletClient,http,zeroAddress,keccak256} from 'viem'
import {privateKeyToAccount} from 'viem/accounts'
import {sepolia} from 'viem/chains'
import {checkRemote,WALLET,DELEGATE,DELEGATE_HASH,CHAIN} from './check-g2-sepolia-7702-revocation.mjs'
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
export async function checkPinnedCode(clients,height){
 const codes=await Promise.all(clients.map(async c=>Promise.all([
  c.getBytecode({address:WALLET,blockNumber:height}),
  c.getBytecode({address:DELEGATE,blockNumber:height})])))
 for(const [walletCode,delegateCode] of codes)
  if(!SAME(walletCode,'0xef0100'+DELEGATE.slice(2))||
   !delegateCode||keccak256(delegateCode).toLowerCase()!==DELEGATE_HASH.toLowerCase())fail('PINNED_CODE_MISMATCH')
}
export async function verify(clients,o,checker=checkRemote,pinnedCheck=checkPinnedCode){
 const results=await Promise.all(clients.map(async c=>({snapshot:await checker(c),fees:await c.estimateFeesPerGas(),height:await c.getBlockNumber()})))
 const [a,b]=results
 if(results.some(x=>x.snapshot.status!=='READY_FOR_HUMAN_REVIEW'))fail('DELEGATION_OR_NONCE_CHANGED')
 if(a.snapshot.observedTransactionNonce!==b.snapshot.observedTransactionNonce||a.snapshot.verifiedDelegateCodeHash!==b.snapshot.verifiedDelegateCodeHash)fail('RPC_DISAGREEMENT')
 if(results.some(x=>!x.fees.maxFeePerGas||!x.fees.maxPriorityFeePerGas||x.fees.maxFeePerGas>BigInt(o.maxFeePerGasWei)||x.fees.maxPriorityFeePerGas>BigInt(o.maxPriorityFeePerGasWei)))fail('FEE_EXCEEDED')
 if(a.height>b.height+2n||b.height>a.height+2n)fail('RPC_BLOCK_DRIFT')
 // Compare code at one canonical height; keep pending/latest nonce checks in checkRemote.
 const height=a.height<b.height?a.height:b.height
 const blocks=await Promise.all(clients.map(c=>c.getBlock({blockNumber:height})))
 if(blocks.some(b=>b.number!==height||!b.hash||!SAME(b.hash,blocks[0].hash)))fail('RPC_CANONICAL_BLOCK_MISMATCH')
 await pinnedCheck(clients,height)
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
const persistent=async(path,obj)=>{
 const f=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600)
 try{await f.writeFile(JSON.stringify(obj)+'\n');await f.sync()}finally{await f.close()}
 // Persist the newly created directory entry before signing or broadcasting.
 const dir=await open(dirname(path),'r')
 try{await dir.sync()}finally{await dir.close()}
}
export async function reserveNonce(nonce,persist=persistent,guard=assertPrivatePath){
 if(!Number.isSafeInteger(nonce)||nonce<0)fail('INVALID_NONCE')
 const path=PRIVATE_DIR+'/nonce-'+WALLET.toLowerCase()+'-'+nonce+'.lock'
 await guard(path)
 await persist(path,{state:'NONCE_RESERVED_NO_RETRY',wallet:WALLET,nonce})
 return path
}
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
 validate(o) // Reject orders that expired while authorization was signed or RPCs were checked.
 const serialized=await wallet.signTransaction(tx)
 const hash=keccak256(serialized)
 await guard(journalPath+'.hash')
 await persist(journalPath+'.hash',{state:'SIGNED_BEFORE_BROADCAST',hash,nonce,chainId:CHAIN,
  warning:'Single send only. On uncertain outcome inspect hash across RPCs; never automatically retry.'})
 await guard(journalPath+'.attempt')
 await persist(journalPath+'.attempt',{state:'BROADCAST_ATTEMPT_UNKNOWN_NO_RETRY',hash,nonce,chainId:CHAIN})
 validate(o) // Expiry is binding even after durable journals were synced.
 const returned=await wallet.sendRawTransaction({serializedTransaction:serialized})
 if(!SAME(returned,hash))fail('BROADCAST_HASH_MISMATCH')
 return await inspectHash(clients,hash,nonce)
}
export async function inspectHash(clients,hash,nonce){
 if(!/^0x[0-9a-fA-F]{64}$/.test(hash)||!Number.isSafeInteger(nonce)||nonce<0)fail('INVALID_JOURNAL')
 const results=await Promise.all(clients.map(async c=>{
  const receipt=await c.getTransactionReceipt({hash}).catch(e=>{if(e.name==='TransactionReceiptNotFoundError')return null;throw e})
  if(!receipt)return {tx:null,receipt:null}
  const tx=await c.getTransaction({hash}).catch(e=>{if(e.name==='TransactionNotFoundError')return null;throw e})
  return {tx,receipt}
 }))
 if(results.some(x=>!x.tx||!x.receipt)){
  const observations=await Promise.all(clients.map(async c=>({nonce:await c.getTransactionCount({address:WALLET,blockTag:'latest'}),tx:await c.getTransaction({hash}).catch(e=>{if(e.name==='TransactionNotFoundError')return null;throw e})})))
  if(observations.some(x=>BigInt(x.nonce)>BigInt(nonce)))return {status:'NONCE_CONSUMED_OR_TX_REPLACED_NO_RETRY',hash,retry:false}
  if(observations.some(x=>!x.tx))return {status:'TX_NOT_FOUND_OR_DROPPED_NO_RETRY',hash,retry:false}
  return {status:'PENDING_NO_RETRY',hash,retry:false}
 }
 for(const {tx,receipt} of results){
  if(!SAME(tx.from,WALLET)||!SAME(tx.to,WALLET)||BigInt(tx.nonce)!==BigInt(nonce)||
   BigInt(tx.chainId)!==BigInt(CHAIN)||!['eip7702','0x4','0x04',4].includes(tx.type)||
   !Array.isArray(tx.authorizationList)||tx.authorizationList.length!==1)fail('TYPE4_MISMATCH')
  const auth=tx.authorizationList[0]
  if(!SAME(auth.address,zeroAddress)||BigInt(auth.nonce)!==BigInt(nonce+1)||
   BigInt(auth.chainId)!==BigInt(CHAIN))fail('AUTHORIZATION_MISMATCH')
  if(!SAME(receipt.transactionHash,hash)||receipt.blockNumber===null)fail('RECEIPT_MISMATCH')
 }
 const receipt=results[0].receipt
 if(receipt.blockNumber!==results[1].receipt.blockNumber||
  !SAME(receipt.blockHash,results[1].receipt.blockHash))return {status:'CHAIN_DISAGREEMENT',hash,retry:false}
 const blocks=await Promise.all(clients.map(c=>c.getBlock({blockNumber:receipt.blockNumber})))
 if(blocks.some(b=>!SAME(b.hash,receipt.blockHash)))return {status:'REORG_OR_RPC_DISAGREEMENT',hash,retry:false}
 const finalized=await Promise.all(clients.map(c=>c.getBlock({blockTag:'finalized'})))
 if(finalized.some(b=>b.number===null||b.number<receipt.blockNumber))
  return {status:'AWAITING_FINALITY',hash,outerExecution:receipt.status,retry:false}
 // Independent finalized heights can differ; inspect their common canonical ancestor.
 const common=finalized[0].number<finalized[1].number?finalized[0].number:finalized[1].number
 const commonBlocks=await Promise.all(clients.map(c=>c.getBlock({blockNumber:common})))
 if(commonBlocks.some((b,i)=>b.number!==common||!b.hash||!SAME(b.hash,commonBlocks[0].hash)||
  (finalized[i].number===common&&!SAME(finalized[i].hash,b.hash))))
  return {status:'FINALIZED_CHAIN_DISAGREEMENT',hash,retry:false}
 const latestBlocks=await Promise.all(clients.map(c=>c.getBlock({blockTag:'latest'})))
 const latestCodes=await Promise.all(clients.map((c,i)=>c.getBytecode({address:WALLET,blockNumber:latestBlocks[i].number})))
 const commonCodes=await Promise.all(clients.map(c=>c.getBytecode({address:WALLET,blockNumber:common})))
 if([...latestCodes,...commonCodes].some(code=>code != null && code !== '0x'))
  return {status:'DELEGATION_RESTORED_OR_CHANGED',hash,outerExecution:receipt.status,retry:false}
 // Finality RPC calls can overlap a reorg. Verify the canonical receipt block again.
 const confirmed=await Promise.all(clients.map(async c=>({block:await c.getBlock({blockNumber:receipt.blockNumber}),receipt:await c.getTransactionReceipt({hash})})))
 if(confirmed.some(x=>!SAME(x.block.hash,receipt.blockHash)||!SAME(x.receipt.blockHash,receipt.blockHash)||x.receipt.blockNumber!==receipt.blockNumber))
  return {status:'REORG_AFTER_FINALITY_CHECK_NO_RETRY',hash,retry:false}
 const codes=await Promise.all(clients.map(c=>c.getBytecode({address:WALLET,blockNumber:receipt.blockNumber})))
 if(codes.some(code=>code != null && code !== '0x'))
  return {status:'DELEGATION_NOT_CLEARED_AT_FINALIZED_RECEIPT',hash,outerExecution:receipt.status,retry:false}
 return {status:'DELEGATION_CLEARED_FINALIZED',hash,outerExecution:receipt.status,retry:false}
}
async function recover(path,clients){
 const saved=JSON.parse(await secureRead(path+'.hash'))
 if(saved.state!=='SIGNED_BEFORE_BROADCAST'||saved.chainId!==CHAIN||
  !/^0x[0-9a-fA-F]{64}$/.test(saved.hash)||!Number.isSafeInteger(saved.nonce))fail('INVALID_JOURNAL')
 let attempt
 try{attempt=JSON.parse(await secureRead(path+'.attempt'))}
 catch(e){if(e.code==='ENOENT')return {status:'MISSING_ATTEMPT_JOURNAL_NO_RETRY',hash:saved.hash,retry:false};throw e}
 if(attempt.state!=='BROADCAST_ATTEMPT_UNKNOWN_NO_RETRY'||!SAME(attempt.hash,saved.hash)||
  attempt.nonce!==saved.nonce||attempt.chainId!==CHAIN)fail('ATTEMPT_JOURNAL_MISMATCH')
 return inspectHash(clients,saved.hash,saved.nonce)
}
async function main(){
 const [mode,orderPath,keyPath,journalPath]=process.argv.slice(2)
 if(!['check','execute','recover'].includes(mode))fail('USAGE')
 if(mode==='recover'&&(!orderPath||process.argv.length!==4))fail('USAGE')
 if(mode!=='recover'&&(!orderPath||process.argv.length!==(mode==='check'?4:6)))fail('USAGE')
 if(mode==='execute'&&(!stdin.isTTY||!stdout.isTTY))fail('HUMAN_TTY_REQUIRED')
 const clients=RPC.map(url=>createPublicClient({chain:sepolia,transport:http(url,{retryCount:0,timeout:15000}),ccipRead:false}))
 if(mode==='recover'){const result=await recover(orderPath,clients);console.log(JSON.stringify(result));if(result.status!=='DELEGATION_CLEARED_FINALIZED')process.exitCode=2;return}
 const o=validate(JSON.parse(await secureRead(orderPath)))
 const pre=await prepare(o,clients)
 console.log(JSON.stringify(pre))
 if(mode==='check')return
 await assertPrivatePath(keyPath,{mustExist:true})
 await assertPrivatePath(journalPath)
 // Exclusive journal reservation precedes access to any signing key.
 await reserveNonce(pre.nonce) // Durable wallet/nonce lock before reading signing key.
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
 const result=await executeVerified({o,clients,wallet,account,nonce:pre.nonce,journalPath})
 console.log(JSON.stringify(result))
 if(result.status!=='DELEGATION_CLEARED_FINALIZED')process.exitCode=2
 return result
}
let invoked=false
try{invoked=!!process.argv[1]&&realpathSync(process.argv[1])===realpathSync(fileURLToPath(import.meta.url))}
catch(e){console.error('BLOCKED ENTRYPOINT_PATH',e.message);process.exitCode=2}
if(invoked)main().catch(e=>{console.error('BLOCKED',e.message,'No automatic retry; inspect journal and chain.');process.exitCode=2})
