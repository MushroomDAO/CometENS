import {it, expect} from 'vitest'
import {spawn} from 'node:child_process'
import {createServer} from 'node:net'
import {access} from 'node:fs/promises'
import {existsSync} from 'node:fs'
import {createPublicClient, createWalletClient, defineChain, http, toHex, zeroAddress} from 'viem'
import {generatePrivateKey, privateKeyToAccount} from 'viem/accounts'

const executable = `${process.env.HOME}/.foundry/bin/anvil`
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

it.skipIf(!existsSync(executable))('clears delegated code through a locally mined type-4 self-authorization', async () => {
  await access(executable)
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  const chain = defineChain({id: 31337, name: 'Anvil local', nativeCurrency: {name:'Ether',symbol:'ETH',decimals:18}, rpcUrls:{default:{http:[`http://127.0.0.1:${port}`]}}})
  const rpc = `http://127.0.0.1:${port}`
  const child = spawn(executable,['--host','127.0.0.1','--port',String(port),'--chain-id','31337','--hardfork','prague','--silent'],{stdio:'ignore'})
  try {
    const publicClient = createPublicClient({chain,transport:http(rpc,{retryCount:0})})
    let started = false
    for(let i=0;i<40;i++) {if(child.exitCode!==null)break;try{await publicClient.getBlockNumber(); started=true; break}catch{await delay(100)}}
    expect(started).toBe(true)
    const account = privateKeyToAccount(generatePrivateKey())
    const wallet = createWalletClient({account,chain,transport:http(rpc,{retryCount:0})})
    await publicClient.request({method:'anvil_setBalance',params:[account.address,toHex(10n**18n)]})
    const previousCode='0xef0100'+'11'.repeat(20)
    await publicClient.request({method:'anvil_setCode',params:[account.address,previousCode]})
    expect(await publicClient.getBytecode({address:account.address})).toBe(previousCode)
    const nonce = await publicClient.getTransactionCount({address:account.address})
    const authorization = await wallet.signAuthorization({contractAddress:zeroAddress,executor:'self',chainId:31337})
    expect(BigInt(authorization.nonce)).toBe(BigInt(nonce)+1n)
    expect(authorization.address.toLowerCase()).toBe(zeroAddress)
    const hash = await wallet.sendTransaction({account,chain,to:account.address,type:'eip7702',data:'0x',value:0n,nonce,gas:100000n,maxFeePerGas:2000000000n,maxPriorityFeePerGas:1000000000n,authorizationList:[authorization]})
    const tx = await publicClient.getTransaction({hash})
    expect(tx.type).toBe('eip7702')
    expect(tx.authorizationList).toHaveLength(1)
    expect((await publicClient.waitForTransactionReceipt({hash})).status).toBe('success')
    expect((await publicClient.getBytecode({address:account.address})) ?? '0x').toBe('0x')
  } finally {child.kill('SIGTERM')}
},30000)
