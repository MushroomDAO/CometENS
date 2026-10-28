#!/usr/bin/env node
/** Read-only registration journal recovery. Never signs, sends or unlocks. */
import {lstat,readFile} from 'node:fs/promises'
import {pathToFileURL} from 'node:url'
import {createPublicClient,http} from 'viem'
import {sepolia} from 'viem/chains'
const RPCS=['https://sepolia.rpc.thirdweb.com','https://ethereum-sepolia.publicnode.com']
const WALLET='0xF7Bf79AcB7F3702b9DbD397d8140ac9DE6Ce642C'
const H=/^0x[0-9a-f]{64}$/i
export function validateJournal(j,path){
 if(!j||Object.getPrototypeOf(j)!==Object.prototype||j.state!=='SIGNED_NO_RETRY'||!H.test(j.hash??'')||!H.test(j.commitment??'')||!H.test(j.calldataHash??'')||!H.test(j.preflightBlock??'')||j.chainId!==11155111||!Number.isSafeInteger(j.nonce)||j.nonce<0||!path.endsWith(`ensv2-register-${j.commitment.slice(2).toLowerCase()}.journal.json`))throw Error('INVALID_JOURNAL')
 return {hash:j.hash.toLowerCase(),nonce:j.nonce,commitment:j.commitment.toLowerCase()}
}
export async function recoverStatus(j,clients){
 if(!Array.isArray(clients)||clients.length!==2)throw Error('DUAL_RPC_REQUIRED')
 const results=await Promise.allSettled(clients.map(async c=>({chain:await c.getChainId(),tx:await c.getTransaction({hash:j.hash}).catch(e=>{if(e?.name==='TransactionNotFoundError')return null;throw e}),receipt:await c.getTransactionReceipt({hash:j.hash}).catch(e=>{if(e?.name==='TransactionReceiptNotFoundError')return null;throw e}),pending:await c.getTransactionCount({address:WALLET,blockTag:'pending'}),latest:await c.getTransactionCount({address:WALLET,blockTag:'latest'})})))
 if(results.some(x=>x.status!=='fulfilled'))return {status:'RPC_UNVERIFIABLE_DO_NOT_RETRY',hash:j.hash}
 const [a,b]=results.map(x=>x.value)
 if(a.chain!==11155111||b.chain!==11155111||a.pending!==b.pending||a.latest!==b.latest||(a.tx?.hash??null)!==(b.tx?.hash??null)||(a.receipt?.blockHash??null)!==(b.receipt?.blockHash??null)||(a.receipt?.status??null)!==(b.receipt?.status??null))return {status:'RPC_DISAGREEMENT_DO_NOT_RETRY',hash:j.hash}
 if(a.tx&&(a.tx.nonce!==j.nonce||a.tx.from?.toLowerCase()!==WALLET.toLowerCase()))return {status:'TX_IDENTITY_MISMATCH_DO_NOT_RETRY',hash:j.hash}
 if(a.receipt)return {status:a.receipt.status==='success'?'MINED_SUCCESS_VERIFY_NATIVE_OWNERSHIP':'MINED_REVERTED_DO_NOT_RETRY',hash:j.hash,blockHash:a.receipt.blockHash,blockNumber:String(a.receipt.blockNumber)}
 return {status:'UNKNOWN_DO_NOT_RETRY',hash:j.hash,transactionVisible:!!a.tx,pendingNonce:a.pending,latestNonce:a.latest,lockedNonce:j.nonce}
}
export async function readJournal(path){const s=await lstat(path);if(!s.isFile()||s.isSymbolicLink()||s.size<2||s.size>4096||(s.mode&0o077)!==0)throw Error('UNSAFE_JOURNAL');return validateJournal(JSON.parse(await readFile(path,'utf8')),path)}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{if(process.argv.length!==3)throw Error('USAGE');const journal=await readJournal(process.argv[2]);const result=await recoverStatus(journal,RPCS.map(url=>createPublicClient({chain:sepolia,transport:http(url,{retryCount:0}),ccipRead:false})));console.log(JSON.stringify(result));process.exitCode=2}catch{console.error('RECOVER_BLOCKED: read-only status unavailable; NEVER retry or delete signed journal');process.exitCode=2}}
