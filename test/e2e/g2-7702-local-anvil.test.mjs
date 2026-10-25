import {it, expect, vi} from 'vitest'
import {spawn} from 'node:child_process'
import {createServer} from 'node:net'
import {existsSync} from 'node:fs'
import {mkdtemp, open, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {delimiter, join} from 'node:path'
import {createPublicClient, createWalletClient, defineChain, http, zeroAddress} from 'viem'
import {generatePrivateKey, privateKeyToAccount} from 'viem/accounts'

const executable = [
  ...(process.env.PATH ?? '').split(delimiter).map(dir => join(dir, 'anvil')),
  join(process.env.HOME ?? '', '.foundry/bin/anvil'),
  join(process.env.XDG_DATA_HOME ?? '', 'foundry/bin/anvil'),
].find(path => existsSync(path))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

it('uses the real executor, signed type-4 transaction and receipt inspector on disposable Prague Anvil', async () => {
  expect(executable, 'Install Foundry Anvil to run this local E2E test').toBeTruthy()
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  const rpc = `http://127.0.0.1:${port}`
  const chain = defineChain({id:11155111,name:'Local Prague simulation',nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18},rpcUrls:{default:{http:[rpc]}}})
  const child = spawn(executable,['--host','127.0.0.1','--port',String(port),'--chain-id','11155111','--hardfork','prague','--silent'],{stdio:'ignore'})
  const directory = await mkdtemp(join(tmpdir(),'cometens-7702-local-'))
  try {
    const publicClient = createPublicClient({chain,transport:http(rpc,{retryCount:0})})
    let started = false
    for(let i=0;i<50;i++){if(child.exitCode!==null)break;try{await publicClient.getBlockNumber();started=true;break}catch{await delay(100)}}
    expect(started).toBe(true)
    const account = privateKeyToAccount(generatePrivateKey())
    const wallet = createWalletClient({account,chain,transport:http(rpc,{retryCount:0})})
    await publicClient.request({method:'anvil_setBalance',params:[account.address,'0xde0b6b3a7640000']})
    const oldCode='0xef0100'+'11'.repeat(20)
    await publicClient.request({method:'anvil_setCode',params:[account.address,oldCode]})
    expect(await publicClient.getBytecode({address:account.address})).toBe(oldCode)

    // Isolate the production wallet constant only in this test's module loader.
    // The runtime's signer/nonce/receipt gates and viem signing stay real.
    vi.doMock('../../scripts/check-g2-sepolia-7702-revocation.mjs',()=>({
      WALLET:account.address, DELEGATE:'0x'+'11'.repeat(20), CHAIN:11155111,
      checkRemote:async()=>{throw Error('unexpected remote check')},
    }))
    const {executeVerified,inspectHash} = await import('../../scripts/g2-sepolia-human-7702-revoke.mjs')
    const nonce=await publicClient.getTransactionCount({address:account.address})
    const o={version:1,action:'clear-7702',chainId:11155111,wallet:account.address,
      expiresAt:new Date(Date.now()+120000).toISOString(),
      maxGas:'60000',maxFeePerGasWei:'2000000000',maxPriorityFeePerGasWei:'1000000000'}
    const persist=async(path,obj)=>{const file=await open(path,'wx',0o600);try{await file.writeFile(JSON.stringify(obj));await file.sync()}finally{await file.close()}}
    const result=await executeVerified({o,clients:[publicClient,publicClient],wallet,account,nonce,
      journalPath:join(directory,'attempt'),recheck:async()=>nonce,guard:async()=>{},persist})
    expect(['PENDING_NO_RETRY','AWAITING_FINALITY','DELEGATION_CLEARED_FINALIZED']).toContain(result.status)
    const hash=result.hash
    await publicClient.waitForTransactionReceipt({hash})
    const tx=await publicClient.getTransaction({hash})
    const receipt=await publicClient.getTransactionReceipt({hash})
    expect(tx.type).toBe('eip7702')
    expect(tx.authorizationList).toHaveLength(1)
    expect(tx.authorizationList[0].address.toLowerCase()).toBe(zeroAddress)
    expect(BigInt(tx.authorizationList[0].nonce)).toBe(BigInt(nonce)+1n)
    expect(receipt.status).toBe('success')
    expect(receipt.gasUsed).toBeLessThanOrEqual(60000n)
    console.info(`LOCAL_ANVIL chainId=11155111 hardfork=prague type=eip7702 gasUsed=${receipt.gasUsed} hash=${hash}`)
    await publicClient.request({method:'anvil_mine',params:['0x80']})
    let inspected
    for(let i=0;i<30;i++){
      inspected=await inspectHash([publicClient,publicClient],hash,nonce)
      if(inspected.status==='DELEGATION_CLEARED_FINALIZED')break
      expect(['PENDING_NO_RETRY','AWAITING_FINALITY']).toContain(inspected.status)
      await delay(100)
    }
    expect(inspected.status).toBe('DELEGATION_CLEARED_FINALIZED')
    expect((await publicClient.getBytecode({address:account.address}))??'0x').toBe('0x')
  }finally{
    vi.doUnmock('../../scripts/check-g2-sepolia-7702-revocation.mjs')
    child.kill('SIGTERM')
    await rm(directory,{recursive:true,force:true})
  }
},30000)
