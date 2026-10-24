#!/usr/bin/env node
/** Unsigned EIP-7702 revocation proposal. No wallet or signing primitives. */
import { readFile, lstat } from 'node:fs/promises'
import { createPublicClient, http, zeroAddress } from 'viem'
import { sepolia } from 'viem/chains'
import { WALLET, CHAIN, DELEGATE, checkRemote } from './check-g2-sepolia-7702-revocation.mjs'
const blocked = reason => ({status:'BLOCKED',reason,safeToSign:false,broadcast:false})
export function validateDraftOrder(o) {
  if (!o || Object.getPrototypeOf(o)!==Object.prototype ||
    Object.keys(o).sort().join(',')!=='action,chainId,expiresAt,maxFeeWei,maxGas,version,wallet' ||
    o.version!==1 || o.action!=='revoke-7702' || o.chainId!==CHAIN || o.wallet!==WALLET ||
    typeof o.expiresAt!=='string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(o.expiresAt) || !Number.isFinite(Date.parse(o.expiresAt)) || Date.parse(o.expiresAt)<=Date.now() || Date.parse(o.expiresAt)>Date.now()+3600000 ||
    typeof o.maxFeeWei!=='string' || typeof o.maxGas!=='string' || !/^[1-9][0-9]*$/.test(o.maxFeeWei) || !/^[1-9][0-9]*$/.test(o.maxGas) ||
    BigInt(o.maxFeeWei)>1000000000000000n || BigInt(o.maxGas)>150000n || BigInt(o.maxGas)<46000n) throw Error('INVALID_REVOKE_ORDER')
  return o
}
export async function draftRevocation(o, clients) {
  try { validateDraftOrder(o) } catch { return blocked('INVALID_REVOKE_ORDER') }
  if (!Array.isArray(clients)||clients.length!==2) return blocked('DUAL_RPC_REQUIRED')
  try {
    const [a,b]=await Promise.all(clients.map(async c=>({snapshot:await checkRemote(c),fees:await c.estimateFeesPerGas()})))
    if (a.snapshot.status!=='READY_FOR_HUMAN_REVIEW' || b.snapshot.status!=='READY_FOR_HUMAN_REVIEW') return blocked('UNSAFE_CHAIN_STATE')
    if (a.snapshot.observedTransactionNonce!==b.snapshot.observedTransactionNonce ||
        a.snapshot.verifiedDelegateCodeHash!==b.snapshot.verifiedDelegateCodeHash) return blocked('RPC_DISAGREEMENT')
    for (const x of [a,b]) {
      if (x.fees.maxFeePerGas==null || x.fees.maxPriorityFeePerGas==null ||
          BigInt(x.fees.maxFeePerGas)*BigInt(o.maxGas)>BigInt(o.maxFeeWei)) return blocked('GAS_FEE_CAP')
    }
    if (Date.parse(o.expiresAt)<=Date.now()) return blocked('INVALID_REVOKE_ORDER')
    return {status:'UNSIGNED_HUMAN_REVIEW_ONLY',safeToSign:false,broadcast:false,
      wallet:WALLET,chainId:CHAIN,currentDelegate:DELEGATE,
      authorization:{contractAddress:zeroAddress,executor:'self',chainId:CHAIN,nonce:a.snapshot.expectedSelfAuthorizationNonce},
      transaction:{type:'eip7702',to:WALLET,value:'0',data:'0x',nonce:a.snapshot.observedTransactionNonce,
        maxFeeWei:o.maxFeeWei,maxGas:o.maxGas},
      expiresAt:o.expiresAt,
      warning:'No execution support: loss of delegated smart account capabilities. Pending nonce, code, delegate and fees can change; human wallet owner must independently review.'}
  } catch { return blocked('RPC_UNVERIFIED') }
}
export async function readOrder(path){
  const s=await lstat(path)
  if (!s.isFile()||s.isSymbolicLink()||s.size<=0||s.size>2048) throw Error('UNSAFE_ORDER_FILE')
  return JSON.parse(await readFile(path,'utf8'))
}
async function main(){
  const [mode,path]=process.argv.slice(2)
  if(process.argv.length!==4||mode!=='check')throw Error('EXECUTE_UNAVAILABLE')
  const order=await readOrder(path)
  const clients=['https://sepolia.drpc.org','https://ethereum-sepolia-rpc.publicnode.com'].map(url=>createPublicClient({chain:sepolia,transport:http(url,{retryCount:0}),ccipRead:false}))
  console.log(JSON.stringify(await draftRevocation(order,clients)))
  process.exitCode=2
}
if(process.argv[1]?.endsWith('draft-g2-sepolia-7702-revoke.mjs'))main().catch(()=>{console.error('REVOKE BLOCKED: no signer or transaction available');process.exitCode=2})
