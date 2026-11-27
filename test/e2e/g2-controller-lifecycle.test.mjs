import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createPublicClient, createWalletClient, http, keccak256, namehash, parseEventLogs, zeroAddress } from 'viem'
import { optimismSepolia } from 'viem/chains'
import { V4ControllerAdapter } from '../../sdk/v4'
import { runV4Cli } from '../../scripts/v4-controller-cli.mjs'

let anvil, directory, rpcUrl, client, wallet, artifact

beforeAll(async () => {
  execFileSync('forge', ['build', 'src/L2CommunityRecordsV4.sol'], {
    cwd: fileURLToPath(new URL('../../contracts/', import.meta.url)),
    env: { ...process.env, FOUNDRY_PROFILE: 'v4_controller' },
  })
  artifact = JSON.parse(await readFile(new URL('../../contracts/out/v4-controller/L2CommunityRecordsV4.sol/L2CommunityRecordsV4.json', import.meta.url), 'utf8'))
  expect((artifact.deployedBytecode.object.length - 2) / 2).toBeLessThanOrEqual(24576)
  directory = await mkdtemp(join(tmpdir(), 'cometens-v4-'))
  // Match the SDK profile on a private loopback chain. The OS chooses the port.
  anvil = spawn('anvil', ['--host', '127.0.0.1', '--port', '0', '--chain-id', '11155420'], { stdio: ['ignore', 'pipe', 'inherit'] })
  const lines = createInterface({ input: anvil.stdout })
  await new Promise((resolve, reject) => {
    anvil.once('error', reject)
    anvil.once('exit', () => reject(new Error('Anvil exited before startup')))
    lines.on('line', line => {
      const match = line.match(/^Listening on (127\.0\.0\.1:\d+)$/)
      if (match) {
        rpcUrl = 'http://' + match[1]
        resolve()
      }
    })
  })
  client = createPublicClient({ chain: optimismSepolia, transport: http(rpcUrl), cacheTime: 0 })
  wallet = createWalletClient({ chain: optimismSepolia, transport: http(rpcUrl) })
})

afterAll(async () => {
  if (anvil?.pid && anvil.exitCode === null && anvil.signalCode === null) {
    const stopped = once(anvil, 'exit')
    anvil.kill()
    await stopped
  }
  if (directory) await rm(directory, { recursive: true, force: true })
})

async function deploy(parentName, account) {
  const hash = await wallet.deployContract({ gas: 8_000_000n, account, abi: artifact.abi, bytecode: artifact.bytecode.object, args: [namehash(parentName), account] })
  const receipt = await client.waitForTransactionReceipt({ hash })
  expect(receipt.status).toBe('success')
  const contract = receipt.contractAddress
  const expectedCodeHash = keccak256(await client.getCode({ address: contract }))
  const profile = join(directory, parentName + '.json')
  await writeFile(profile, JSON.stringify({ parentName, contract, expectedCodeHash, chainId: 11155420 }))
  return { profile, contract }
}

async function cli(root, command, ...flags) {
  const raw = await runV4Cli([command, '--profile', root.profile, ...flags], { rpcUrl, adapterClass: V4ControllerAdapter })
  const response = JSON.parse(raw)
  expect(response.broadcast).toBe(false)
  return response.result
}

async function execute(root, command, controller, operator, ...flags) {
  const tx = await cli(root, command, '--from', controller, '--operator', operator, ...flags)
  expect(tx.to.toLowerCase()).toBe(root.contract.toLowerCase())
  const hash = await wallet.sendTransaction({ account: controller, to: tx.to, data: tx.data })
  const mined = await client.waitForTransactionReceipt({ hash })
  const { receipt } = await cli(root, 'receipt', '--hash', hash)
  expect(receipt).toMatchObject({ status: 'success', transactionHash: hash, blockNumber: mined.blockNumber.toString() })
  return parseEventLogs({ abi: artifact.abi, logs: mined.logs }).map(log => log.eventName)
}

it('isolates two communities through grant, restriction, rotation and revocation', async () => {
  const [ownerA, ownerB, operator, next, member] = await wallet.getAddresses()
  const a = await deploy('alpha.eth', ownerA)
  const b = await deploy('beta.eth', ownerB)
  const expiresAt = String((await client.getBlock()).timestamp + 3600n)
  const scope = (permissions, quota) => ['--permissions', permissions, '--quota', quota, '--expires-at', expiresAt]
  const status = async (root, who) => (await cli(root, 'status', '--operator', who)).operator

  expect(await execute(a, 'prepare-grant', ownerA, operator, ...scope('3', '4'))).toEqual(['OperatorGranted'])
  expect(await status(a, operator)).toMatchObject({ canInitialAddrUnsigned: true, remainingQuota: '4' })
  expect(await status(b, operator)).toMatchObject({ canIssue: false, controller: ownerB })
  await expect(cli(b, 'prepare-grant', '--from', ownerA, '--operator', operator, ...scope('1', '1'))).rejects.toThrow(/current community controller/)

  await expect(client.simulateContract({ address: b.contract, abi: artifact.abi, functionName: 'issue',
    args: ['first', member, zeroAddress], account: operator })).rejects.toThrow(/Unauthorized/)

  await execute(a, 'prepare-grant', ownerA, operator, ...scope('1', '2'))
  expect(await status(a, operator)).toMatchObject({ canInitialAddrUnsigned: false, remainingQuota: '2' })
  expect(await execute(a, 'prepare-rotate', ownerA, operator, '--next', next, ...scope('1', '2'))).toEqual(['OperatorGranted', 'OperatorRevoked'])
  expect((await status(a, operator)).canIssue).toBe(false)
  const issue = { address: a.contract, abi: artifact.abi, functionName: 'issue', args: ['first', member, zeroAddress], account: next }
  const issued = await wallet.writeContract(issue)
  expect((await client.waitForTransactionReceipt({ hash: issued })).status).toBe('success')
  expect(await client.readContract({ address: a.contract, abi: artifact.abi, functionName: 'subnodeOwner',
    args: [namehash('first.alpha.eth')] })).toBe(member)
  expect((await status(a, next)).remainingQuota).toBe('1')
  expect(await execute(a, 'prepare-revoke', ownerA, next)).toEqual(['OperatorRevoked'])
  expect((await status(a, next)).canIssue).toBe(false)
  await expect(client.simulateContract({ ...issue, args: ['second', member, zeroAddress] })).rejects.toThrow(/Unauthorized/)
}, 30_000)
