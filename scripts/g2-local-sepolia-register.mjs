#!/usr/bin/env node
/** ENSv2 register/reveal validation. Never signs or broadcasts until the observed revert is resolved. */
import { readFile } from 'node:fs/promises'
import { createPublicClient, http } from 'viem'
import { sepolia } from 'viem/chains'
import { validateRegistrationManifest, loadOrCreateSalt, prepareSepoliaRegistration, REGISTRAR, WALLET } from './prepare-g2-sepolia-ensv2-registration.mjs'
import { assertPrivateFile } from './g2-local-sepolia-signer.mjs'
import { stat } from 'node:fs/promises'

const COMMITMENT='0x2f960f05f42a357bbadfd04487066d5e429ccea0329860ea5a7211e5a7c2ec35'
const REVERT_RECEIVER='0x57f447ce'
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase()
const DELEGATION=/^0xef0100[0-9a-f]{40}$/i
export async function checkWalletDelegation(clients) {
  if (!Array.isArray(clients)||clients.length!==2) return {status:'BLOCKED',reason:'DUAL_RPC_REQUIRED'}
  try {
    const states=await Promise.all(clients.map(async client=>({chain:await client.getChainId(),code:await client.getBytecode({address:WALLET,blockTag:'latest'})})))
    if (states.some(s=>s.chain!==11155111||typeof s.code!=='string')) return {status:'BLOCKED',reason:'WALLET_CODE_UNVERIFIED'}
    if (!same(states[0].code,states[1].code)) return {status:'BLOCKED',reason:'WALLET_CODE_RPC_DISAGREEMENT'}
    if (DELEGATION.test(states[0].code)) return {status:'BLOCKED',reason:'EIP7702_DELEGATION_ACTIVE',delegate:`0x${states[0].code.slice(8)}`}
    if (states[0].code!=='0x') return {status:'BLOCKED',reason:'UNEXPECTED_WALLET_CODE'}
    return {status:'PASS'}
  } catch { return {status:'BLOCKED',reason:'WALLET_CODE_RPC_FAILED'} }
}
export function validateRegisterOrder(order, manifest) {
  if (!order || Object.getPrototypeOf(order)!==Object.prototype ||
      Object.keys(order).sort().join(',')!=='action,chainId,commitment,expiresAt,from,maxTotalCost,to,version' ||
      order.version!==1 || order.action!=='register' || order.chainId!==11155111 ||
      !same(order.from,WALLET) || !same(order.to,REGISTRAR) ||
      !same(order.commitment,COMMITMENT) || order.maxTotalCost!=='9000000' ||
      !Number.isFinite(Date.parse(order.expiresAt)) || Date.parse(order.expiresAt)<=Date.now() ||
      Date.parse(order.expiresAt)>Date.now()+7*86400000) throw Error('INVALID_REGISTER_ORDER')
  const m=validateRegistrationManifest(manifest)
  if (m.maxCost!==9000000n || m.label!=='cometens-g2-20261023') throw Error('MANIFEST_MISMATCH')
  return m
}
export async function checkRegister({order,manifest,saltFile,clients}) {
  let m
  try { m=validateRegisterOrder(order,manifest) } catch { return {status:'BLOCKED',reason:'INVALID_REGISTER_ORDER'} }
  let salt
  try { salt=await loadOrCreateSalt(saltFile,m,{create:false}) } catch { return {status:'BLOCKED',reason:'SALT_INVALID'} }
  if (!same(salt.commitment,order.commitment)) return {status:'BLOCKED',reason:'COMMITMENT_MISMATCH'}
  if (!Array.isArray(clients)||clients.length!==2) return {status:'BLOCKED',reason:'DUAL_RPC_REQUIRED'}
  const wallet=await checkWalletDelegation(clients)
  if(wallet.status!=='PASS') return wallet
  const checks=await Promise.all(clients.map(client=>prepareSepoliaRegistration({manifest,saltFile,phase:'reveal',client})))
  if (checks.some(x=>x.reason!=='EXTERNAL_WALLET_ACTION_REQUIRED'||x.simulated!==true))
    return {status:'BLOCKED',reason:'CHAIN_PREFLIGHT_FAILED',details:checks.map(x=>x.reason)}
  const [a,b]=checks
  if (a.totalCost!==b.totalCost || a.allowance!==b.allowance || a.paymentBalance!==b.paymentBalance ||
      a.simulationBlock?.hash!==b.simulationBlock?.hash || a.simulationBlock?.number!==b.simulationBlock?.number ||
      a.revealDraft?.data!==b.revealDraft?.data || BigInt(a.totalCost)>m.maxCost ||
      BigInt(a.allowance)>m.maxCost || BigInt(a.allowance)<BigInt(a.totalCost))
    return {status:'BLOCKED',reason:'RPC_DISAGREEMENT_OR_CAP'}
  // Execution remains disabled until owner clears wallet delegation and new review passes.
  return {status:'BLOCKED',reason:'REGISTER_EXECUTION_NOT_REVIEWED',selector:REVERT_RECEIVER,
    commitment:order.commitment,quotedPrice:a.totalCost,allowance:a.allowance,
    block:a.simulationBlock,signatures:false,broadcasts:false}
}
async function main() {
  const [mode,orderPath]=process.argv.slice(2)
  if (process.argv.length!==4 || !['check','execute'].includes(mode)) throw Error('USAGE')
  if (mode==='execute') throw Error('REGISTER_EXECUTION_DISABLED_PENDING_OWNER_DELEGATION_CLEARANCE')
  const dir=`${process.env.HOME}/.config/cometens-g2-sepolia`
  const [manifestPath,saltFile]=[`${dir}/cometens-g2-20261023.public-manifest.json`,`${dir}/cometens-g2-20261023.salt.json`]
  await Promise.all([manifestPath,saltFile,orderPath].map(async p=>assertPrivateFile(await stat(p))))
  const parse=async p=>{const data=await readFile(p);if(data.length>4096)throw Error('SIZE');return JSON.parse(data.toString())}
  const [manifest,order]=await Promise.all([parse(manifestPath),parse(orderPath)])
  const urls=['https://sepolia.drpc.org','https://ethereum-sepolia-rpc.publicnode.com']
  const clients=urls.map(url=>createPublicClient({chain:sepolia,transport:http(url,{retryCount:0}),ccipRead:false}))
  console.log(JSON.stringify(await checkRegister({order,manifest,saltFile,clients})))
  process.exitCode=2
}
if (process.argv[1]?.endsWith('g2-local-sepolia-register.mjs'))main().catch(()=>{
  console.error('REGISTER BLOCKED: local validation or read-only RPC failed; no signature, no broadcast')
  process.exitCode=2
})
