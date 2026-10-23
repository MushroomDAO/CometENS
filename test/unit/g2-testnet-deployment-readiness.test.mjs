import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { keccak256, namehash } from 'viem'
import { checkG2NativeReadiness } from '../../scripts/check-g2-native-testnet-readiness.mjs'

const address = n => `0x${n.toString(16).padStart(40,'0')}`
const hash = n => `0x${n.toString(16).padStart(64,'0')}`
const code = n => `0x60${n.toString(16).padStart(2,'0')}600055`
const contracts = () => ({
  source:{address:address(12),expectedRuntimeHash:keccak256(code(12))},
  relay:{address:address(13),expectedRuntimeHash:keccak256(code(13))},
  inbox:{address:address(14),expectedRuntimeHash:keccak256(code(14))},
  l1Messenger:{address:address(15),expectedRuntimeHash:keccak256(code(15))},
  opMessenger:{address:'0x4200000000000000000000000000000000000007',expectedRuntimeHash:keccak256(code(16))},
  registry:{address:'0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e',expectedRuntimeHash:keccak256(code(17))},
  wrapper:{address:'0x0635513f179D50A207757E05759CbD106d7dFcE8',expectedRuntimeHash:keccak256(code(18))},
  registrar:{address:'0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85',expectedRuntimeHash:keccak256(code(19))},
})
const manifest = () => ({ version:1, networks:{l1ChainId:11155111,opChainId:11155420},
  community:{parentName:'community.eth',expectedHolder:address(4)},
  deployPlan:{addressPredictionReviewed:true,contractsApproved:true,targetDomainReviewed:true},
  contracts:contracts(),
})
const artifacts = () => Object.fromEntries(Object.entries({
  source:['string','address','bytes32','bytes32','bytes32'],
  relay:['address','bytes32','bytes32','address','bytes32','address'],
  inbox:['bytes32','address'],
}).map(([key,types])=>[key,{abi:[{type:'constructor',inputs:types.map(type=>({type}))}],
  bytecode:{object:'0x60006000'}}]))
const parent=namehash('community.eth')
const messengerVersion=keccak256('0x434f4d4554454e535f47325f4e41544956455f524553554c545f5631')
const c=contracts()
const head=n=>({number:100n,hash:hash(n),timestamp:2_000_000n})
function fixture(options={}) {
  const calls=[]
  const chainReads={11155111:0,11155420:0}
  const result = (fn,chain,contractAddress)=>{
    const properties={
      parentNode:parent,destinationInbox:c.inbox.address,SOURCE_CHAIN_ID:11155111n,
      registryRuntimeHash:c.registry.expectedRuntimeHash,wrapperRuntimeHash:c.wrapper.expectedRuntimeHash,
      registrarRuntimeHash:c.registrar.expectedRuntimeHash,nativeSource:c.source.address,
      sourceRuntimeHash:c.source.expectedRuntimeHash,l1Messenger:c.l1Messenger.address,
      messengerRuntimeHash:c.l1Messenger.expectedRuntimeHash,MESSAGE_VERSION:messengerVersion,
      L1_CHAIN_ID:11155111n,OP_CHAIN_ID:11155420n,
      l1ResultEmitter:c.relay.address,VERSION:messengerVersion,sovereignReceipt:false,
      currentAuthority:[address(4),2_000_000n+10n*86400n],
    }
    return (options.mutateFunction===fn && (!options.mutateChain || chain===options.mutateChain) &&
      (!options.mutateAddress || options.mutateAddress.toLowerCase()===contractAddress.toLowerCase())) ?
      options.badValue : properties[fn]
  }
  let l1FinalizedCalls=0,opFinalizedCalls=0
  function client(chain) {
    const l1=chain===11155111
    return {
      async getChainId(){calls.push(['chain',chain]);chainReads[chain]++
        return options.wrongChain===chain || (options.wrongChainFirst===chain && chainReads[chain]===1) ? 1 : chain},
      async getBlock(p){
        calls.push(['block',chain,p]);
        if(p.blockTag==='finalized'){
          const read = l1 ? ++l1FinalizedCalls : ++opFinalizedCalls
          return {...head(l1?1:2),hash: options.driftChain===chain && read>1 ? hash(99):head(l1?1:2).hash}
        }
        return { ...head(l1?1:2), number:p.blockNumber,hash:options.driftSource===chain?hash(88):head(l1?1:2).hash}
      },
      async getBytecode(p){
        calls.push(['code',chain,p]);
        const entry=Object.entries(c).find(([,v])=>v.address.toLowerCase()===p.address.toLowerCase())
        if(!entry)throw Error('unexpected-code-address')
        if(options.badCode===entry[0])return '0x6000'
        const i={source:12,relay:13,inbox:14,l1Messenger:15,opMessenger:16,registry:17,wrapper:18,registrar:19}[entry[0]]
        return code(i)
      },
      async readContract(p){
        calls.push(['read',chain,p]);
        return result(p.functionName,chain,p.address)
      },
    }
  }
  return {l1Client:client(11155111),opClient:client(11155420),calls}
}
const run=(m=manifest(),opts={})=>checkG2NativeReadiness(m,{artifacts:artifacts(),...fixture(opts)})

describe('G2 native deployment readiness is a read-only BLOCKER, not a deployment tool',()=>{
  it('valid immutable pointers only produce BLOCKED report with all unsafe flags false',async()=>{
    const report=await run()
    expect(report).toMatchObject({status:'BLOCKED',parentNode:parent,chainIds:{l1:11155111,op:11155420},
      dryRunOnly:true,broadcasts:false,signatures:false,liveSignerUsed:false,readyToBroadcast:false,
      nativeAuthorityVerified:false,ensV2AuthorityVerified:false,opGrantsNativeRights:false,sovereignReceipt:false,
      historicalLegacyPinsMatched:true})
    expect(report.blockers).toContain('rpc-snapshot-not-current-execution-time-authority')
    expect(report.blockers).toContain('live-contract-review-and-community-native-ensv2-signoff-required')
  })
  it('missing manifest/artifacts/clients stays BLOCKED without contacting chains',async()=>{
    expect((await checkG2NativeReadiness({})).blockers).toContain('invalid-manifest')
    expect((await checkG2NativeReadiness(manifest())).blockers).toContain('missing-independent-read-only-l1-op-observations')
    expect((await checkG2NativeReadiness(manifest())).blockers).toContain('missing-or-drifted-relay-creation-artifact')
    const m=manifest();m.deployPlan.addressPredictionReviewed=false
    expect((await run(m)).blockers).toContain('addressPredictionReviewed-not-approved')
  })
  it.each([
    ['wrong OP chain',{wrongChain:11155420}],['wrong L1 chain',{wrongChain:11155111}],
    ['only initial L1 chain check wrong',{wrongChainFirst:11155111}],
    ['only initial OP chain check wrong',{wrongChainFirst:11155420}],
    ['wrong source code',{badCode:'source'}],['wrong relay code',{badCode:'relay'}],
    ['wrong OP messenger code',{badCode:'opMessenger'}],['wrong wrapper code',{badCode:'wrapper'}],
    ['L1 finality drift',{driftChain:11155111}],['OP finality drift',{driftChain:11155420}],
    ['source block hash drift',{driftSource:11155111}],
    ['native holder mismatch',{mutateFunction:'currentAuthority',badValue:[address(5),2_900_000n]}],
    ['native name expires',{mutateFunction:'currentAuthority',badValue:[address(4),2_000_001n]}],
    ['wrong relay destination',{mutateFunction:'destinationInbox',mutateChain:11155111,badValue:address(5)}],
    ['relay destination alone corrupted',{mutateFunction:'destinationInbox',mutateAddress:c.relay.address,badValue:address(5)}],
    ['wrong native source',{mutateFunction:'nativeSource',badValue:address(9)}],
    ['wrong source hash',{mutateFunction:'sourceRuntimeHash',badValue:hash(55)}],
    ['wrong chain constant',{mutateFunction:'SOURCE_CHAIN_ID',badValue:1n}],
    ['wrong parent',{mutateFunction:'parentNode',badValue:hash(22)}],
    ['source parent alone corrupted',{mutateFunction:'parentNode',mutateAddress:c.source.address,badValue:hash(22)}],
    ['wrong OP emitter',{mutateFunction:'l1ResultEmitter',badValue:address(11)}],
    ['wrong message version',{mutateFunction:'VERSION',badValue:hash(33)}],
    ['false sovereignty flag changes',{mutateFunction:'sovereignReceipt',badValue:true}],
  ])('fails closed on %s',async(_,mutation)=>{
    const report=await run(manifest(),mutation)
    expect(report.status).toBe('BLOCKED')
    expect(report.blockers).toContain('unverified-read-only-chain-wiring-or-authority')
    expect(report.historicalLegacyPinsMatched).not.toBe(true)
  })
  it('rejects wrong network, privileged key injection, wrong deployment target and address collisions',async()=>{
    for(const edited of [
      m=>{m.networks.l1ChainId=1},m=>{m.community.parentName='alice.com'},
      m=>{m.PRIVATE_KEY='secret'},m=>{m.contracts.source.privateKey='secret'},
      m=>{m.contracts.opMessenger.address=address(7)},
      m=>{m.contracts.inbox.address=m.contracts.relay.address},
      m=>{m.deployPlan.addressPredictionReviewed='true'},
      m=>{m.community.expectedHolder=address(0)},
    ]){
      const m=manifest();edited(m)
      const result=await checkG2NativeReadiness(m)
      expect(result.status).toBe('BLOCKED')
      expect(result.blockers.length).toBeGreaterThan(0)
      expect(JSON.stringify(result)).not.toContain('secret')
    }
  })
  it('checks exact historical finalized block selectors for all native/OP reads and code pins',async()=>{
    const {l1Client,opClient,calls}=fixture()
    const r=await checkG2NativeReadiness(manifest(),{artifacts:artifacts(),l1Client,opClient})
    expect(r.historicalLegacyPinsMatched).toBe(true)
    expect(calls.filter(x=>x[0]==='read').length).toBeGreaterThan(14)
    expect(calls.filter(x=>x[0]==='read').every(x=>x[2].blockNumber===100n)).toBe(true)
    expect(calls.filter(x=>x[0]==='code')).toHaveLength(8)
    expect(calls.filter(x=>x[0]==='code').every(x=>x[2].blockNumber===100n)).toBe(true)
    expect(calls.filter(x=>x[0]==='chain'&&x[1]===11155111)).toHaveLength(2)
    expect(calls.filter(x=>x[0]==='chain'&&x[1]===11155420)).toHaveLength(2)
  })
  it('rejects accessor injection without reading private fields; mutable external manifest cannot redirect awaited checks',async()=>{
    const m = manifest()
    let accessed = 0
    Object.defineProperty(m.contracts.relay, 'address', { enumerable:true,
      get() { accessed++; return address(13) } })
    expect((await checkG2NativeReadiness(m)).blockers).toContain('invalid-manifest')
    expect(accessed).toBe(0)
    const change = manifest()
    const {l1Client,opClient} = fixture()
    const initial = l1Client.getBlock
    l1Client.getBlock = async args => {
      change.contracts.source.address = address(99)
      change.community.expectedHolder = address(55)
      return initial(args)
    }
    const report = await checkG2NativeReadiness(change,{artifacts:artifacts(),l1Client,opClient})
    expect(report.historicalLegacyPinsMatched).toBe(true)
    expect(report.nativeAuthorityVerified).toBe(false)
  })
  it('CLI remains offline, reports BLOCKED and exits nonzero without leaking secret fields',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'g2-testnet-readiness-'))
    const entry=new URL('../../scripts/check-g2-native-testnet-readiness.mjs', import.meta.url).pathname
    try {
      const file=join(dir,'manifest.json')
      await writeFile(file, JSON.stringify(manifest()))
      const run=spawnSync(process.execPath,[entry,'--manifest',file],{encoding:'utf8',timeout:6000})
      expect(run.status).toBe(1)
      expect(JSON.parse(run.stdout).status).toBe('BLOCKED')
      expect(run.stdout).not.toContain('privateKey')
      expect(run.stdout).not.toContain('secret')
      const bad=spawnSync(process.execPath,[entry,'--manifest',join(dir,'missing-private-file.json')],{encoding:'utf8'})
      expect(bad.status).toBe(1)
      expect(bad.stderr).not.toContain('missing-private-file')
      const help=spawnSync(process.execPath,[entry,'--help'],{encoding:'utf8'})
      expect(help.status).toBe(0)
      expect(help.stdout).toContain('No keys')
    } finally {await rm(dir,{recursive:true,force:true})}
  })
})
