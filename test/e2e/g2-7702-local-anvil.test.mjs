import {it, expect} from 'vitest'
import {spawn} from 'node:child_process'
import {createServer} from 'node:net'
import {existsSync} from 'node:fs'
import {delimiter, join} from 'node:path'
import {createPublicClient, createWalletClient, defineChain, http, keccak256, toHex, zeroAddress} from 'viem'
import {generatePrivateKey, privateKeyToAccount} from 'viem/accounts'

const executable = [
  ...(process.env.PATH ?? '').split(delimiter).map(dir => join(dir, 'anvil')),
  join(process.env.HOME ?? '', '.foundry/bin/anvil'),
  join(process.env.XDG_DATA_HOME ?? '', 'foundry/bin/anvil'),
].find(path => existsSync(path))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

it('clears delegated code through a locally mined type-4 self-authorization', async () => {
  expect(executable, 'Anvil must be installed for EIP-7702 integration testing').toBeTruthy()
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
    const signed = await wallet.signTransaction({account,chain,to:account.address,type:'eip7702',data:'0x',value:0n,nonce,gas:60000n,maxFeePerGas:2000000000n,maxPriorityFeePerGas:1000000000n,authorizationList:[authorization]})
    const expectedHash = keccak256(signed)
    const hash = await wallet.sendRawTransaction({serializedTransaction:signed})
    expect(hash).toBe(expectedHash)
    const tx = await publicClient.getTransaction({hash})
    expect(tx.hash).toBe(expectedHash)
    expect(tx.type).toBe('eip7702')
    expect(tx.authorizationList).toHaveLength(1)
    const receipt = await publicClient.waitForTransactionReceipt({hash})
    expect(receipt.status).toBe('success')
    expect(receipt.gasUsed).toBeLessThanOrEqual(60000n)
    console.info(`Local disposable EIP-7702 revoke gasUsed=${receipt.gasUsed}`)
    expect((await publicClient.getBytecode({address:account.address})) ?? '0x').toBe('0x')
  } finally {child.kill('SIGTERM')}
},30000)
