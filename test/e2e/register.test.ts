/**
 * E2E Test: Subdomain registration flow using local Anvil node.
 *
 * Flow:
 *   1. Start Anvil on a random port
 *   2. Deploy L2Records via Worker EOA
 *   3. Call setSubnodeOwner  → alice.test.eth owned by alice
 *   4. Call setAddr          → ETH address record for alice node
 *   5. Query L2Records       → verify addr + owner
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  keccak256,
  toBytes,
  toHex,
  encodePacked,
  type Hex,
  type Address,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { foundry } from 'viem/chains'
import { execSync, spawn, type ChildProcess } from 'child_process'
import { readFileSync } from 'fs'
import { join } from 'path'

// ─── Constants ────────────────────────────────────────────────────────────────

const ANVIL_PORT = 18545
const CONTRACTS_DIR = join(import.meta.dirname, '..', '..', 'contracts')

// Anvil well-known test accounts
const DEPLOYER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex
const ALICE_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex

const deployer = privateKeyToAccount(DEPLOYER_PK)
const alice = privateKeyToAccount(ALICE_PK)

const anvilChain = { ...foundry, id: 31337, rpcUrls: { default: { http: [`http://127.0.0.1:${ANVIL_PORT}`] } } }

function namehashParts(parent: Hex, label: string): { parentNode: Hex; labelhash: Hex; node: Hex } {
  const labelhash = keccak256(toBytes(label)) as Hex
  const node = keccak256(encodePacked(['bytes32', 'bytes32'], [parent, labelhash])) as Hex
  return { parentNode: parent, labelhash, node }
}

// ─── Anvil lifecycle ──────────────────────────────────────────────────────────

let anvilProc: ChildProcess

async function waitForAnvil(port: number, retries = 20): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      })
      if (res.ok) return
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`Anvil did not start on port ${port}`)
}

// ─── Deploy helper ────────────────────────────────────────────────────────────

async function deployL2Records(): Promise<Address> {
  const artifact = JSON.parse(
    readFileSync(join(CONTRACTS_DIR, 'out', 'L2Records.sol', 'L2Records.json'), 'utf8')
  )
  const abi = artifact.abi
  const bytecode: Hex = artifact.bytecode.object

  const wallet = createWalletClient({ account: deployer, chain: anvilChain, transport: http(`http://127.0.0.1:${ANVIL_PORT}`) })
  const publicClient = createPublicClient({ chain: anvilChain, transport: http(`http://127.0.0.1:${ANVIL_PORT}`) })

  const txHash = await wallet.deployContract({ abi, bytecode, args: [deployer.address] })
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash })

  if (!receipt.contractAddress) throw new Error('Deploy failed: no contractAddress in receipt')
  return receipt.contractAddress
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('E2E: subdomain registration on local Anvil', () => {
  let contractAddress: Address
  let publicClient: ReturnType<typeof createPublicClient>
  let walletClient: ReturnType<typeof createWalletClient>

  const L2_RECORDS_ABI = [
    { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
    { type: 'function', name: 'setSubnodeOwner', stateMutability: 'nonpayable', inputs: [{ name: 'parentNode', type: 'bytes32' }, { name: 'labelhash', type: 'bytes32' }, { name: 'newOwner', type: 'address' }, { name: 'label', type: 'string' }], outputs: [] },
    { type: 'function', name: 'registerSubnode', stateMutability: 'nonpayable', inputs: [{ name: 'parentNode', type: 'bytes32' }, { name: 'labelhash', type: 'bytes32' }, { name: 'newOwner', type: 'address' }, { name: 'label', type: 'string' }, { name: 'addrBytes', type: 'bytes' }], outputs: [] },
    { type: 'function', name: 'labelOf', stateMutability: 'view', inputs: [{ name: 'node', type: 'bytes32' }], outputs: [{ type: 'string' }] },
    { type: 'function', name: 'primaryNode', stateMutability: 'view', inputs: [{ name: 'addr_', type: 'address' }], outputs: [{ type: 'bytes32' }] },
    { type: 'function', name: 'subnodeOwner', stateMutability: 'view', inputs: [{ name: 'node', type: 'bytes32' }], outputs: [{ type: 'address' }] },
    { type: 'function', name: 'setAddr', stateMutability: 'nonpayable', inputs: [{ name: 'node', type: 'bytes32' }, { name: 'coinType', type: 'uint256' }, { name: 'addrBytes', type: 'bytes' }], outputs: [] },
    { type: 'function', name: 'addr', stateMutability: 'view', inputs: [{ name: 'node', type: 'bytes32' }], outputs: [{ type: 'address' }] },
    { type: 'function', name: 'setText', stateMutability: 'nonpayable', inputs: [{ name: 'node', type: 'bytes32' }, { name: 'key', type: 'string' }, { name: 'value', type: 'string' }], outputs: [] },
    { type: 'function', name: 'text', stateMutability: 'view', inputs: [{ name: 'node', type: 'bytes32' }, { name: 'key', type: 'string' }], outputs: [{ type: 'string' }] },
    { type: 'function', name: 'setContenthash', stateMutability: 'nonpayable', inputs: [{ name: 'node', type: 'bytes32' }, { name: 'hash', type: 'bytes' }], outputs: [] },
    { type: 'function', name: 'contenthash', stateMutability: 'view', inputs: [{ name: 'node', type: 'bytes32' }], outputs: [{ type: 'bytes' }] },
  ] as const

  beforeAll(async () => {
    anvilProc = spawn('anvil', ['--port', String(ANVIL_PORT), '--silent'])
    await waitForAnvil(ANVIL_PORT)
    contractAddress = await deployL2Records()

    publicClient = createPublicClient({ chain: anvilChain, transport: http(`http://127.0.0.1:${ANVIL_PORT}`) })
    walletClient = createWalletClient({ account: deployer, chain: anvilChain, transport: http(`http://127.0.0.1:${ANVIL_PORT}`) })
  }, 30_000)

  afterAll(() => {
    anvilProc?.kill()
  })

  it('deploys with correct owner', async () => {
    const owner = await publicClient.readContract({
      address: contractAddress, abi: L2_RECORDS_ABI, functionName: 'owner', args: [],
    })
    expect(owner.toLowerCase()).toBe(deployer.address.toLowerCase())
  })

  it('registers subdomain via setSubnodeOwner', async () => {
    const ROOT = '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex
    const { parentNode, labelhash, node } = namehashParts(ROOT, 'alice')

    const txHash = await walletClient.writeContract({
      address: contractAddress, abi: L2_RECORDS_ABI, functionName: 'setSubnodeOwner',
      args: [parentNode, labelhash, alice.address, 'alice'],
      account: deployer, chain: anvilChain,
    })
    await publicClient.waitForTransactionReceipt({ hash: txHash })

    const owner = await publicClient.readContract({
      address: contractAddress, abi: L2_RECORDS_ABI, functionName: 'subnodeOwner', args: [node],
    })
    expect(owner.toLowerCase()).toBe(alice.address.toLowerCase())
  })

  it('registerSubnode atomically sets owner + ETH addr in one tx', async () => {
    const ROOT = '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex
    // Use a fresh address (Anvil account #2) so primaryNode is unset
    const daveOwner = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as Address
    const { labelhash, node } = namehashParts(ROOT, 'dave')
    const addrBytes = toHex(toBytes(daveOwner), { size: 20 }) as Hex

    const txHash = await walletClient.writeContract({
      address: contractAddress, abi: L2_RECORDS_ABI, functionName: 'registerSubnode',
      args: [ROOT, labelhash, daveOwner, 'dave', addrBytes],
      account: deployer, chain: anvilChain,
    })
    await publicClient.waitForTransactionReceipt({ hash: txHash })

    const resolved = await publicClient.readContract({
      address: contractAddress, abi: L2_RECORDS_ABI, functionName: 'addr', args: [node],
    })
    expect(resolved.toLowerCase()).toBe(daveOwner.toLowerCase())

    const label = await publicClient.readContract({
      address: contractAddress, abi: L2_RECORDS_ABI, functionName: 'labelOf', args: [node],
    })
    expect(label).toBe('dave')

    const primary = await publicClient.readContract({
      address: contractAddress, abi: L2_RECORDS_ABI, functionName: 'primaryNode', args: [daveOwner],
    })
    expect(primary).toBe(node)
  })

  it('sets and reads text record', async () => {
    const ROOT = '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex
    const { labelhash, node } = namehashParts(ROOT, 'bob')

    await walletClient.writeContract({
      address: contractAddress, abi: L2_RECORDS_ABI, functionName: 'setSubnodeOwner',
      args: [ROOT, labelhash, alice.address, 'bob'],
      account: deployer, chain: anvilChain,
    })

    const txHash = await walletClient.writeContract({
      address: contractAddress, abi: L2_RECORDS_ABI, functionName: 'setText',
      args: [node, 'com.twitter', '@bob_eth'],
      account: deployer, chain: anvilChain,
    })
    await publicClient.waitForTransactionReceipt({ hash: txHash })

    const value = await publicClient.readContract({
      address: contractAddress, abi: L2_RECORDS_ABI, functionName: 'text', args: [node, 'com.twitter'],
    })
    expect(value).toBe('@bob_eth')
  })

  it('sets and reads contenthash', async () => {
    const ROOT = '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex
    const { labelhash, node } = namehashParts(ROOT, 'carol')
    const ipfsHash = '0xe301017012201234567890abcdef1234567890abcdef1234567890abcdef1234' as Hex

    await walletClient.writeContract({
      address: contractAddress, abi: L2_RECORDS_ABI, functionName: 'setSubnodeOwner',
      args: [ROOT, labelhash, alice.address, 'carol'],
      account: deployer, chain: anvilChain,
    })

    const txHash = await walletClient.writeContract({
      address: contractAddress, abi: L2_RECORDS_ABI, functionName: 'setContenthash',
      args: [node, ipfsHash],
      account: deployer, chain: anvilChain,
    })
    await publicClient.waitForTransactionReceipt({ hash: txHash })

    const value = await publicClient.readContract({
      address: contractAddress, abi: L2_RECORDS_ABI, functionName: 'contenthash', args: [node],
    })
    expect(value.toLowerCase()).toBe(ipfsHash.toLowerCase())
  })

  it('non-owner cannot write records', async () => {
    const ROOT = '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex
    const { labelhash } = namehashParts(ROOT, 'hacker')

    const aliceWallet = createWalletClient({
      account: alice, chain: anvilChain, transport: http(`http://127.0.0.1:${ANVIL_PORT}`),
    })

    await expect(
      aliceWallet.writeContract({
        address: contractAddress, abi: L2_RECORDS_ABI, functionName: 'setSubnodeOwner',
        args: [ROOT, labelhash, alice.address, 'hacker'],
        account: alice, chain: anvilChain,
      })
    ).rejects.toThrow()
  })
})
