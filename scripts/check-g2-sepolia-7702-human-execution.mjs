#!/usr/bin/env node
/** Human execution remains disabled. Inspect an unsigned plan or existing transaction hash only. */
import { readFile, lstat } from 'node:fs/promises'
import { createPublicClient, http } from 'viem'
import { sepolia } from 'viem/chains'
import { draftRevocation } from './draft-g2-sepolia-7702-revoke.mjs'
import { WALLET, CHAIN } from './check-g2-sepolia-7702-revocation.mjs'
const HASH=/^0x[0-9a-f]{64}$/i
const blocked=reason=>({status:'BLOCKED',reason,safeToSign:false,broadcast:false})
export async function readPublicInput(path) {
  const s=await lstat(path)
  if(!s.isFile()||s.isSymbolicLink()||s.size<=0||s.size>2048) throw Error('UNSAFE_INPUT')
  const raw=await readFile(path)
  if(raw.length>2048) throw Error('OVERSIZE')
  return JSON.parse(raw.toString())
}
export async function inspectRevokeReceipt(hash,clients) {
  if(!HASH.test(hash)||!Array.isArray(clients)||clients.length!==2) return blocked('INVALID_HASH_OR_RPCS')
  try {
    const states=await Promise.all(clients.map(async client=>({
      chain:await client.getChainId(),
      receipt:await client.getTransactionReceipt({hash}),
      tx:await client.getTransaction({hash}),
      code:await client.getBytecode({address:WALLET}),
    })))
    if(states.some(x=>x.chain!==CHAIN || x.receipt?.transactionHash?.toLowerCase()!==hash.toLowerCase() ||
       x.receipt?.status!=='success'|| x.tx?.from?.toLowerCase()!==WALLET.toLowerCase() ||
       x.tx?.type!=='eip7702' || x.code!=='0x')) return blocked('RECEIPT_OR_POSTCONDITION_UNVERIFIED')
    if(states[0].receipt.blockHash!==states[1].receipt.blockHash || states[0].receipt.blockNumber!==states[1].receipt.blockNumber) return blocked('RECEIPT_RPC_DISAGREEMENT')
    return {status:'POSTCONDITION_OBSERVED',hash,chainId:CHAIN,code:'0x',blockNumber:String(states[0].receipt.blockNumber),broadcast:false,safeToSign:false}
  }catch{return blocked('RECEIPT_PENDING_OR_RPC_FAILED')}
}
async function main() {
  const [mode,arg]=process.argv.slice(2)
  if(process.argv.length!==4||!['check','receipt'].includes(mode))throw Error('EXECUTE_DISABLED')
  const clients=['https://sepolia.drpc.org','https://ethereum-sepolia-rpc.publicnode.com'].map(url=>createPublicClient({chain:sepolia,transport:http(url,{retryCount:0}),ccipRead:false}))
  const result=mode==='check'?await draftRevocation(await readPublicInput(arg),clients):await inspectRevokeReceipt(arg,clients)
  console.log(JSON.stringify(result))
  process.exitCode=result.status==='POSTCONDITION_OBSERVED'?0:2
}
if(process.argv[1]?.endsWith('check-g2-sepolia-7702-human-execution.mjs'))main().catch(()=>{console.error('BLOCKED: no signing or transaction broadcast available');process.exitCode=2})
