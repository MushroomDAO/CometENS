#!/usr/bin/env node
/** Read-only recovery for an ambiguous owner-signed ENSv2 register submission. */
import { readFile, lstat } from 'node:fs/promises'
import { createPublicClient, http } from 'viem'
import { sepolia } from 'viem/chains'
import { REGISTRAR, WALLET } from './prepare-g2-sepolia-ensv2-registration.mjs'
const URLS=['https://sepolia.drpc.org','https://ethereum-sepolia.publicnode.com']
const HEX32=/^0x[0-9a-f]{64}$/i
const eq=(a,b)=>String(a).toLowerCase()===String(b).toLowerCase()
export function validateJournal(j){
 if(j?.state!=='SIGNED_NO_RETRY'||!HEX32.test(j.hash??'')||
  !HEX32.test(j.commitment??'')||!HEX32.test(j.calldataHash??'')||
  j.chainId!==11155111||!Number.isSafeInteger(j.nonce)||j.nonce<0)
  throw Error('INVALID_SIGNED_JOURNAL')
 return j
}
export async function inspectRegister(clients,j){
 validateJournal(j)
 if(clients.length!==2)throw Error('DUAL_RPC_REQUIRED')
 const observations=await Promise.all(clients.map(async c=>{
  const [chain,tx,receipt]=await Promise.all([
   c.getChainId(),c.getTransaction({hash:j.hash}).catch(()=>null),
   c.getTransactionReceipt({hash:j.hash}).catch(()=>null)])
  return {chain,tx,receipt}
 }))
 if(observations.some(x=>x.chain!==11155111))return {status:'WRONG_CHAIN_NO_RETRY',hash:j.hash}
 if(observations.some(x=>!x.tx||!x.receipt))return {status:'UNKNOWN_DO_NOT_RETRY',hash:j.hash}
 for(const {tx,receipt} of observations){
  if(!eq(tx.from,WALLET)||!eq(tx.to,REGISTRAR)||tx.nonce!==j.nonce||
   !eq(receipt.transactionHash,j.hash)||!eq(tx.hash,j.hash)||
   !eq((await import('viem')).keccak256(tx.input??tx.data),j.calldataHash))
   return {status:'TX_MISMATCH_NO_RETRY',hash:j.hash}
 }
 const [a,b]=observations.map(x=>x.receipt)
 if(!eq(a.blockHash,b.blockHash)||a.blockNumber!==b.blockNumber||a.status!==b.status)
  return {status:'RPC_DISAGREEMENT_NO_RETRY',hash:j.hash}
 const canonical=await Promise.all(clients.map(c=>c.getBlock({blockNumber:a.blockNumber})))
 if(canonical.some(b=>!eq(b.hash,a.blockHash)))return {status:'REORG_OR_RPC_DISAGREEMENT_NO_RETRY',hash:j.hash}
 const finalized=await Promise.all(clients.map(c=>c.getBlock({blockTag:'finalized'})))
 if(finalized.some(b=>b.number<a.blockNumber))return {status:'AWAITING_FINALITY_NO_RETRY',hash:j.hash}
 return {status:a.status==='success'?'REGISTER_TX_FINALIZED':'REGISTER_TX_REVERTED_NO_RETRY',hash:j.hash,block:String(a.blockNumber)}
}
async function main(){
 if(process.argv.length!==3)throw Error('USAGE')
 const path=process.argv[2]
 const st=await lstat(path)
 if(!st.isFile()||st.isSymbolicLink()||st.size>4096)throw Error('UNSAFE_JOURNAL')
 const j=validateJournal(JSON.parse(await readFile(path,'utf8')))
 const clients=URLS.map(url=>createPublicClient({chain:sepolia,transport:http(url,{retryCount:0,timeout:12000})}))
 const result=await inspectRegister(clients,j)
 console.log(JSON.stringify(result))
 if(result.status!=='REGISTER_TX_FINALIZED')process.exitCode=2
}
if(process.argv[1]?.endsWith('g2-ensv2-register-recover.mjs')) main().catch(e=>{console.error('RECOVER_BLOCKED',e.message);process.exitCode=2})
