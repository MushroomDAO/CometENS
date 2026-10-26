#!/usr/bin/env node
/** User-operated Sepolia-only test signer. AI must never run --execute. */
import { readFile, stat } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { createPublicClient, createWalletClient, http, keccak256, parseAbi, encodeFunctionData, encodeAbiParameters, parseAbiParameters } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { sepolia } from 'viem/chains'

const ADDRESS = '0xF7Bf79AcB7F3702b9DbD397d8140ac9DE6Ce642C'
const REGISTRAR = '0xf633e7fc17e2bbe0d0965d18ec1821dcb754a3d3'
const TOKEN = '0x240b0316df57887dbbe58b586508b19e633a14aa'
const ZERO = '0x0000000000000000000000000000000000000000'
const REG_HASH = '0xb025a7edb8e81862c2d28857211a7a91c1fb2b17c5bcf28b983987067f083c2a'
const TOKEN_HASH = '0xa9a4749f886f5035336f6e16dce5ca6f339ae73f76e94ad4b8f46a447dc335f3'
const ZERO32 = `0x${'00'.repeat(32)}`
const PRIVATE_DIR = `${process.env.HOME}/.config/cometens-g2-sepolia`
const MANIFEST = `${PRIVATE_DIR}/cometens-g2-20261023.public-manifest.json`
const SALT = `${PRIVATE_DIR}/cometens-g2-20261023.salt.json`
const KEY = `${PRIVATE_DIR}/test-wallet.key`
const ERC20 = parseAbi(['function allowance(address,address) view returns (uint256)', 'function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)'])
const REG = parseAbi(['function commit(bytes32 commitment)', 'function commitmentAt(bytes32) view returns (uint64)', 'function MAX_COMMITMENT_AGE() view returns (uint64)', 'function isAvailable(string) view returns (bool)', 'function getRegisterPrice(string,uint64,address) view returns (uint256,uint256)', 'function makeCommitment(string,address,bytes32,address,address,uint64,bytes32) pure returns (bytes32)'])
const same = (a,b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()
const is32 = x => /^0x[0-9a-f]{64}$/i.test(x ?? '')
export function validateOrder(o, m, s) {
  const keys=['version','chainId','from','action','to','amountBaseUnits','commitment','expiresAt']
  if (!o || typeof o !== 'object' || Array.isArray(o) || Object.keys(o).sort().join() !== keys.sort().join() ||
      o.version !== 1 || o.chainId !== 11155111 || !same(o.from, ADDRESS) ||
      !Number.isSafeInteger(Date.parse(o.expiresAt)) || Date.parse(o.expiresAt) <= Date.now() ||
      Date.parse(o.expiresAt) > Date.now() + 7*86400000 ||
      m?.label !== 'cometens-g2-20261023' || !same(m.wallet, ADDRESS) || m.maxTotalCost !== '9000000' ||
      !same(m.expectedRegistrarCodeHash,REG_HASH) || !same(m.expectedTokenCodeHash,TOKEN_HASH)) throw Error('invalid-order')
  if (o.action === 'approve') {
    if (!same(o.to,TOKEN) || o.commitment !== null || typeof o.amountBaseUnits !== 'string' ||
      !/^[1-9][0-9]*$/.test(o.amountBaseUnits) || BigInt(o.amountBaseUnits) > BigInt(m.maxTotalCost)) throw Error('unsafe-approve')
  } else if (o.action === 'commit') {
    if (!same(o.to,REGISTRAR) || o.amountBaseUnits !== null || !is32(o.commitment) ||
        !same(s?.commitment,o.commitment) || s?.label!==m.label || s?.durationSeconds!==m.durationSeconds ||
        !same(s?.wallet,ADDRESS) || !is32(s?.salt)) throw Error('unsafe-commit')
    const expected = keccak256(encodeAbiParameters(parseAbiParameters('string,address,bytes32,address,address,uint64,bytes32'),
      [m.label,ADDRESS,s.salt,ZERO,ZERO,BigInt(m.durationSeconds),ZERO32]))
    if (!same(expected,o.commitment)) throw Error('commitment-binding')
  } else throw Error('unsupported-action')
  return o
}
const loadJson = async (path,max=4096) => { const b=await readFile(path); if(b.length>max)throw Error('oversized');return JSON.parse(b.toString()) }
export function assertPrivateFile(s, uid = typeof process.getuid === 'function' ? process.getuid() : undefined) {
  if (uid == null) throw Error('posix-ownership-check-required')
  if (!s.isFile() || (s.mode & 0o777) !== 0o600 || s.uid !== uid) throw Error('unsafe-file')
}
const privateFile = async path => assertPrivateFile(await stat(path))
export async function validateChain(client,o,m) {
  if (await client.getChainId()!==11155111) throw Error('wrong-chain')
  const [registrarCode,tokenCode] = await Promise.all([client.getBytecode({address:REGISTRAR}),client.getBytecode({address:TOKEN})])
  if (!registrarCode || !tokenCode || !same(keccak256(registrarCode),m.expectedRegistrarCodeHash) ||
      !same(keccak256(tokenCode),m.expectedTokenCodeHash))throw Error('code-identity')
  const available=await client.readContract({address:REGISTRAR,abi:REG,functionName:'isAvailable',args:[m.label]})
  if (!available)throw Error('name-unavailable')
  const [base,premium]=await client.readContract({address:REGISTRAR,abi:REG,functionName:'getRegisterPrice',args:[m.label,BigInt(m.durationSeconds),TOKEN]})
  const price=base+premium
  if(price<=0n || price>BigInt(m.maxTotalCost))throw Error('price-cap')
  if(o.action==='approve'){
    if(BigInt(o.amountBaseUnits)!==price)throw Error('stale-approval-price')
    const allowance=await client.readContract({address:TOKEN,abi:ERC20,functionName:'allowance',args:[ADDRESS,REGISTRAR]})
    if(allowance!==0n)throw Error('existing-allowance-manual-review')
    if(await client.readContract({address:TOKEN,abi:ERC20,functionName:'balanceOf',args:[ADDRESS]})<price)throw Error('insufficient-token')
    return {abi:ERC20,functionName:'approve',address:TOKEN,args:[REGISTRAR,price],price}
  }
  // ENSv2 allows re-committing a hash after its previous reveal window expires.
  // Read its age and commitment against one L1 block, never local wall-clock time.
  const head=await client.getBlock({blockTag:'latest'})
  if(typeof head?.number!=='bigint'||typeof head.timestamp!=='bigint'||head.timestamp<=0n)
    throw Error('commitment-block-unverified')
  const [committed,maxAge]=await Promise.all([
    client.readContract({address:REGISTRAR,abi:REG,functionName:'commitmentAt',args:[o.commitment],blockNumber:head.number}),
    client.readContract({address:REGISTRAR,abi:REG,functionName:'MAX_COMMITMENT_AGE',blockNumber:head.number}),
  ])
  if(typeof committed!=='bigint'||typeof maxAge!=='bigint'||maxAge<=0n)
    throw Error('commitment-window-unverified')
  if(committed!==0n && head.timestamp<committed+maxAge)throw Error('commitment-already-live')
  return {abi:REG,functionName:'commit',address:REGISTRAR,args:[o.commitment],price}
}
export async function awaitSubmittedReceipt(client,hash,action,log=console.error) {
  try { return await client.waitForTransactionReceipt({hash,confirmations:2,timeout:180000}) }
  catch {
    log(JSON.stringify({status:'SUBMITTED_UNCONFIRMED',hash,action,message:'DO NOT RETRY execute; inspect receipt by hash before any further action'}))
    return null
  }
}
async function main(){
  const [mode,orderPath] = process.argv.slice(2)
  if(!['check','execute'].includes(mode) || !orderPath || process.argv.length!==4)throw Error('usage: node scripts/g2-local-sepolia-signer.mjs check|execute order.json')
  await Promise.all([privateFile(MANIFEST),privateFile(SALT)])
  const [m,o,s]=await Promise.all([loadJson(MANIFEST),loadJson(orderPath),loadJson(SALT)])
  validateOrder(o,m,s)
  const rpc=process.env.COMETENS_SEPOLIA_RPC_URL || 'https://sepolia.drpc.org'
  const url=new URL(rpc); if(url.protocol!=='https:'||url.username||url.password)throw Error('rpc-invalid')
  const client=createPublicClient({chain:sepolia,transport:http(rpc,{retryCount:0}),ccipRead:false})
  const tx=await validateChain(client,o,m)
  const data=encodeFunctionData({abi:tx.abi,functionName:tx.functionName,args:tx.args})
  console.log(JSON.stringify({status:'CHECKED',action:o.action,chainId:11155111,from:ADDRESS,to:tx.address,amountBaseUnits:o.amountBaseUnits,priceBaseUnits:String(tx.price),calldata:data,expiresAt:o.expiresAt,submitted:false}))
  if(mode==='check')return
  if(!stdin.isTTY||!stdout.isTTY)throw Error('interactive-terminal-required')
  const prompt=createInterface({input:stdin,output:stdout})
  try{const answer=await prompt.question(`Type EXECUTE ${o.action.toUpperCase()} to sign and broadcast on SEPOLIA: `); if(answer!==`EXECUTE ${o.action.toUpperCase()}`)throw Error('user-declined')}
  finally{prompt.close()}
  if(Date.parse(o.expiresAt)<=Date.now())throw Error('expired-during-confirmation')
  await privateFile(KEY)
  const key=(await readFile(KEY,'utf8')).trim()
  if(!/^(0x)?[a-fA-F0-9]{64}$/.test(key))throw Error('key-format')
  const account=privateKeyToAccount(key.startsWith('0x')?key:`0x${key}`)
  if(!same(account.address,ADDRESS))throw Error('signer-mismatch')
  // Re-read after terminal confirmation, then simulate as the real signer.
  const latest=await validateChain(client,o,m)
  const sim=await client.simulateContract({account,address:latest.address,abi:latest.abi,functionName:latest.functionName,args:latest.args})
  const gas=await client.estimateContractGas({account,address:latest.address,abi:latest.abi,functionName:latest.functionName,args:latest.args})
  const wallet=createWalletClient({account,chain:sepolia,transport:http(rpc,{retryCount:0})})
  const hash=await wallet.writeContract({...sim.request,gas:gas*12n/10n})
  console.log(JSON.stringify({status:'SUBMITTED',hash,action:o.action}))
  const receipt=await awaitSubmittedReceipt(client,hash,o.action)
  if(!receipt){process.exitCode=4;return}
  console.log(JSON.stringify({status:receipt.status,hash,blockNumber:String(receipt.blockNumber),gasUsed:String(receipt.gasUsed)}))
  if(receipt.status!=='success')process.exitCode=3
}
if(process.argv[1]?.endsWith('g2-local-sepolia-signer.mjs'))main().catch(()=>{console.error('SIGNER BLOCKED: validation, transaction, or RPC failed; check chain state and logs.');process.exitCode=2})
