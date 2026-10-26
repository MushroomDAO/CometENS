#!/usr/bin/env node
/** Human-only Sepolia register. Never automatically retries a transaction. */
import { readFile, stat, open } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { createPublicClient, http, createWalletClient, keccak256, encodeFunctionData } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { sepolia } from 'viem/chains'
import { checkRegister, readPublicOrder } from './g2-local-sepolia-register.mjs'
import { assertPrivateFile } from './g2-local-sepolia-signer.mjs'
import { REG_ABI, REGISTRAR, WALLET } from './prepare-g2-sepolia-ensv2-registration.mjs'

const DIR = `${process.env.HOME}/.config/cometens-g2-sepolia`
const URLS = ['https://sepolia.drpc.org', 'https://ethereum-sepolia-rpc.publicnode.com']
const same = (a,b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()
const clients = () => URLS.map(url => createPublicClient({ chain: sepolia, transport: http(url,{ retryCount:0 }), ccipRead:false }))
const parse = async path => { const b = await readFile(path); if (b.length>4096) throw Error('file-too-large'); return JSON.parse(b.toString()) }

export function requireReady(result) {
  if (result?.reason !== 'REGISTER_EXECUTION_NOT_REVIEWED' || result.broadcasts !== false ||
      !result.block?.hash || typeof result.quotedPrice !== 'string' ||
      BigInt(result.allowance) < BigInt(result.quotedPrice)) throw Error('reveal-preflight-blocked')
  return result
}

/** O_EXCL reservation blocks concurrent invocations and all retries after ambiguity. */
export async function reserveBeforeSend(path, details) {
  const f = await open(path,'wx',0o600)
  try {
    await f.writeFile(JSON.stringify({state:'RESERVED_NO_RETRY',...details})+'\n'); await f.sync()
    const { dirname }=await import('node:path')
    const dir=await open(dirname(path),'r')
    try {await dir.sync()} finally {await dir.close()}
  }
  catch (e) { await f.close(); throw e }
  return f
}

export async function recordSignedHash(file, details) {
  const bytes=Buffer.from(JSON.stringify({state:'SIGNED_NO_RETRY',...details})+'\n')
  await file.write(bytes,0,bytes.length,0)
  await file.truncate(bytes.length)
  await file.sync()
}

export async function corroborateReceipt(a,b,hash) {
  const results = await Promise.allSettled([a,b].map(c=>c.getTransactionReceipt({hash})))
  if(results.some(r=>r.status!=='fulfilled')) return {status:'UNKNOWN_DO_NOT_RETRY',hash}
  const [x,y]=results.map(r=>r.value)
  if(!same(x.transactionHash,hash)||!same(y.transactionHash,hash)||
      !same(x.blockHash,y.blockHash)||x.blockNumber!==y.blockNumber||x.status!==y.status)
    return {status:'RPC_DISAGREEMENT_DO_NOT_RETRY',hash}
  return {status:x.status==='success'?'CONFIRMED':'REVERTED',hash,blockHash:x.blockHash,blockNumber:String(x.blockNumber)}
}

async function main() {
  const [mode,orderPath]=process.argv.slice(2)
  if(!['check','execute'].includes(mode)||!orderPath||process.argv.length!==4) throw Error('usage')
  const manifestPath=`${DIR}/cometens-g2-20261023.public-manifest.json`
  const saltPath=`${DIR}/cometens-g2-20261023.salt.json`
  await Promise.all([manifestPath,saltPath].map(async p=>assertPrivateFile(await stat(p))))
  const [manifest,order]=await Promise.all([parse(manifestPath),readPublicOrder(orderPath)])
  const pair=clients()
  const ready=requireReady(await checkRegister({order,manifest,saltFile:saltPath,clients:pair}))
  console.log(JSON.stringify({status:'CHECKED',chainId:11155111,action:'register',from:WALLET,to:REGISTRAR,
    quotedPrice:ready.quotedPrice,allowance:ready.allowance,block:ready.block,submitted:false}))
  if(mode==='check') return
  if(!stdin.isTTY||!stdout.isTTY) throw Error('interactive-terminal-required')
  const prompt=createInterface({input:stdin,output:stdout})
  try { if(await prompt.question('Type EXECUTE REGISTER SEPOLIA (ONE ATTEMPT): ')!=='EXECUTE REGISTER SEPOLIA') throw Error('declined') }
  finally { prompt.close() }
  if(Date.parse(order.expiresAt)<=Date.now()) throw Error('order-expired')
  const second=requireReady(await checkRegister({order,manifest,saltFile:saltPath,clients:pair}))
  const { loadOrCreateSalt, validateRegistrationManifest }=await import('./prepare-g2-sepolia-ensv2-registration.mjs')
  const m=validateRegistrationManifest(manifest)
  const secret=await loadOrCreateSalt(saltPath,m,{create:false})
  const args=[m.label,WALLET,secret.salt,'0x0000000000000000000000000000000000000000',
    '0x0000000000000000000000000000000000000000',m.duration,
    '0x240b0316df57887dbbe58b586508b19e633a14aa','0x'+'00'.repeat(32)]
  const data=encodeFunctionData({abi:REG_ABI,functionName:'register',args})
  if(!same(secret.commitment,order.commitment)) throw Error('commitment-mismatch')
  // Reserve before accessing any signer. A failure leaves the durable NO_RETRY lock.
  const journal=`${DIR}/ensv2-register-${order.commitment.slice(2)}.journal.json`
  const file=await reserveBeforeSend(journal,{commitment:order.commitment,orderExpiresAt:order.expiresAt})
  try {
    const keyPath=`${DIR}/test-wallet.key`
    await assertPrivateFile(await stat(keyPath))
    const key=(await readFile(keyPath,'utf8')).trim()
    if(!/^(0x)?[a-f0-9]{64}$/i.test(key)) throw Error('invalid-key-format')
    const account=privateKeyToAccount(key.startsWith('0x')?key:`0x${key}`)
    if(!same(account.address,WALLET)) throw Error('wrong-wallet')
    const a=pair[0], b=pair[1]
    const [nonceA,nonceB,gasA,gasB,chainA,chainB]=await Promise.all([
      a.getTransactionCount({address:WALLET,blockTag:'pending'}),b.getTransactionCount({address:WALLET,blockTag:'pending'}),
      a.estimateGas({account:WALLET,to:REGISTRAR,data}),b.estimateGas({account:WALLET,to:REGISTRAR,data}),
      a.getChainId(),b.getChainId()])
    if(nonceA!==nonceB||chainA!==11155111||chainB!==11155111||gasA<=0n||gasB<=0n) throw Error('rpc-nonce-or-gas-disagreement')
    const fees=await a.estimateFeesPerGas()
    if(!fees.maxFeePerGas||!fees.maxPriorityFeePerGas) throw Error('unverifiable-fees')
    const raw=await account.signTransaction({chainId:11155111,type:'eip1559',nonce:nonceA,to:REGISTRAR,
      value:0n,data,gas:(gasA>gasB?gasA:gasB)*12n/10n,
      maxFeePerGas:fees.maxFeePerGas,maxPriorityFeePerGas:fees.maxPriorityFeePerGas})
    const hash=keccak256(raw)
    await recordSignedHash(file,{commitment:order.commitment,hash,nonce:Number(nonceA),chainId:11155111,
      calldataHash:keccak256(data),preflightBlock:second.block.hash})
    // ONE raw broadcast only. On timeout or error, keep journal; query hash manually.
    const sent=await createWalletClient({chain:sepolia,transport:http(URLS[0],{retryCount:0})}).sendRawTransaction({serializedTransaction:raw})
    if(!same(sent,hash)) throw Error('broadcast-hash-mismatch')
    console.log(JSON.stringify({status:'SUBMITTED_NO_RETRY',hash,journal}))
    const receipt=await corroborateReceipt(...pair,hash)
    console.log(JSON.stringify(receipt))
  } finally {await file.close()}
}
if(process.argv[1]?.endsWith('g2-human-ensv2-register.mjs')) main().catch(()=>{
  console.error('REGISTER BLOCKED OR AMBIGUOUS: inspect private journal and chain hash; NEVER auto retry')
  process.exitCode=2
})
