#!/usr/bin/env node
/** Read-only recovery for an ambiguous owner-signed ENSv2 register submission. */
import { readFile, lstat } from 'node:fs/promises'
import { createPublicClient, http, keccak256 } from 'viem'
import { sepolia } from 'viem/chains'
import { REGISTRAR, WALLET } from './prepare-g2-sepolia-ensv2-registration.mjs'
const URLS=['https://sepolia.drpc.org','https://ethereum-sepolia.publicnode.com']
const HEX32=/^0x[0-9a-f]{64}$/i
const eq=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase()
const validBlock=b=>typeof b?.number==='bigint'&&b.number>=0n&&HEX32.test(b.hash??'')
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
  if(typeof receipt.blockNumber!=='bigint'||receipt.blockNumber<0n||
   !HEX32.test(receipt.blockHash??'')||!['success','reverted'].includes(receipt.status))
   return {status:'INVALID_RECEIPT_NO_RETRY',hash:j.hash}
  if(!eq(tx.from,WALLET)||!eq(tx.to,REGISTRAR)||tx.nonce!==j.nonce||
   tx.chainId!==11155111||tx.type!=='eip1559'||tx.value!==0n||
   tx.blockNumber!==receipt.blockNumber||!eq(tx.blockHash,receipt.blockHash)||
   !eq(receipt.transactionHash,j.hash)||!eq(tx.hash,j.hash)||
   typeof tx.input!=='string'||!/^0x(?:[0-9a-f]{2})*$/i.test(tx.input)||
   !eq(keccak256(tx.input),j.calldataHash))
   return {status:'TX_MISMATCH_NO_RETRY',hash:j.hash}
 }
 const [a,b]=observations.map(x=>x.receipt)
 if(!eq(a.blockHash,b.blockHash)||a.blockNumber!==b.blockNumber||a.status!==b.status)
  return {status:'RPC_DISAGREEMENT_NO_RETRY',hash:j.hash}
 const finalized=await Promise.all(clients.map(c=>c.getBlock({blockTag:'finalized'})))
 if(finalized.some(b=>!validBlock(b)))return {status:'INVALID_FINALITY_NO_RETRY',hash:j.hash}
 if(finalized[0].number===finalized[1].number&&!eq(finalized[0].hash,finalized[1].hash))
  return {status:'RPC_DISAGREEMENT_NO_RETRY',hash:j.hash}
 if(finalized.some(b=>b.number<a.blockNumber))return {status:'AWAITING_FINALITY_NO_RETRY',hash:j.hash}
 if(finalized.some(b=>b.number===a.blockNumber&&!eq(b.hash,a.blockHash)))
  return {status:'REORG_OR_RPC_DISAGREEMENT_NO_RETRY',hash:j.hash}
 const canonical=await Promise.all(clients.map(c=>c.getBlock({blockNumber:a.blockNumber})))
 if(canonical.some(b=>!validBlock(b)||b.number!==a.blockNumber||!eq(b.hash,a.blockHash)))
  return {status:'REORG_OR_RPC_DISAGREEMENT_NO_RETRY',hash:j.hash}
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
