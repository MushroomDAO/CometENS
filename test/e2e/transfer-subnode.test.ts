/**
 * E2E Test: Transfer-subnode flow against a local Anvil node.
 *
 * Flow:
 *   1. Start Anvil on a dedicated port
 *   2. Deploy L2RecordsV3 (ERC-721 subdomain ownership)
 *   3. Register "alice" subdomain → alice owns the NFT
 *   4. Verify subnodeOwner(node) == alice
 *   5. deployer calls transferSubnodeByGateway(node, alice, bob)
 *   6. Verify subnodeOwner(node) == bob
 *   7. Verify subnodeOwner(node) != alice
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  toBytes,
  encodePacked,
  type Hex,
  type Address,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { foundry } from 'viem/chains'
import { spawn, type ChildProcess } from 'child_process'
import { readFileSync } from 'fs'
import { join } from 'path'

// ─── Constants ────────────────────────────────────────────────────────────────

const ANVIL_PORT = 18551
const CONTRACTS_DIR = join(import.meta.dirname, '..', '..', 'contracts')

// Anvil well-known test accounts
const DEPLOYER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex
const ALICE_PK    = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex
const BOB_ADDR    = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as Address

const deployer = privateKeyToAccount(DEPLOYER_PK)
const alice    = privateKeyToAccount(ALICE_PK)

const ROOT = '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex

const anvilChain = {
  ...foundry,
  id: 31337,
  rpcUrls: { default: { http: [`http://127.0.0.1:${ANVIL_PORT}`] } },
}

// ─── ABI ──────────────────────────────────────────────────────────────────────

const L2V3_ABI = [
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'subnodeOwner', stateMutability: 'view', inputs: [{ name: 'node', type: 'bytes32' }], outputs: [{ type: 'address' }] },
  {
    type: 'function', name: 'setSubnodeOwner', stateMutability: 'nonpayable',
    inputs: [
      { name: 'parentNode', type: 'bytes32' },
      { name: 'labelhash', type: 'bytes32' },
      { name: 'newOwner', type: 'address' },
      { name: 'label', type: 'string' },
    ],
    outputs: [],
  },
  {
    type: 'function', name: 'transferSubnodeByGateway', stateMutability: 'nonpayable',
    inputs: [
      { name: 'node', type: 'bytes32' },
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
    ],
    outputs: [],
  },
] as const

// ─── Helpers ──────────────────────────────────────────────────────────────────

function nodeForLabel(parent: Hex, label: string): { labelhash: Hex; node: Hex } {
  const labelhash = keccak256(toBytes(label)) as Hex
  const node = keccak256(encodePacked(['bytes32', 'bytes32'], [parent, labelhash])) as Hex
  return { labelhash, node }
}

async function waitForAnvil(port: number, retries = 30): Promise<void> {
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

// ─── Anvil lifecycle ──────────────────────────────────────────────────────────

let anvilProc: ChildProcess

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('E2E: transfer-subnode flow on local Anvil', () => {
  let contractAddress: Address
  let publicClient: ReturnType<typeof createPublicClient>
  let deployerWallet: ReturnType<typeof createWalletClient>

  beforeAll(async () => {
    anvilProc = spawn('anvil', ['--port', String(ANVIL_PORT), '--hardfork', 'prague', '--disable-code-size-limit', '--silent'])
    await waitForAnvil(ANVIL_PORT)

    publicClient  = createPublicClient({ chain: anvilChain, transport: http(`http://127.0.0.1:${ANVIL_PORT}`) })
    deployerWallet = createWalletClient({ account: deployer, chain: anvilChain, transport: http(`http://127.0.0.1:${ANVIL_PORT}`) })

    // Deploy L2RecordsV3
    const artifact = JSON.parse(
      readFileSync(join(CONTRACTS_DIR, 'out', 'L2RecordsV3.sol', 'L2RecordsV3.json'), 'utf8')
    )
    const txHash = await deployerWallet.deployContract({
      abi: artifact.abi,
      bytecode: artifact.bytecode.object as Hex,
      args: [deployer.address],
    })
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash })
    if (!receipt.contractAddress) throw new Error('L2RecordsV3 deploy failed: no contractAddress')
    contractAddress = receipt.contractAddress
  }, 30_000)

  afterAll(() => {
    anvilProc?.kill()
  })

  it('deploys with correct owner', async () => {
    const contractOwner = await publicClient.readContract({
      address: contractAddress,
      abi: L2V3_ABI,
      functionName: 'owner',
      args: [],
    })
    expect(contractOwner.toLowerCase()).toBe(deployer.address.toLowerCase())
  })

  it('registers "alice" subdomain — alice is the owner', async () => {
    const { labelhash, node } = nodeForLabel(ROOT, 'alice')

    const txHash = await deployerWallet.writeContract({
      address: contractAddress,
      abi: L2V3_ABI,
      functionName: 'setSubnodeOwner',
      args: [ROOT, labelhash, alice.address, 'alice'],
      account: deployer,
      chain: anvilChain,
    })
    await publicClient.waitForTransactionReceipt({ hash: txHash })

    const ownerAfterRegister = await publicClient.readContract({
      address: contractAddress,
      abi: L2V3_ABI,
      functionName: 'subnodeOwner',
      args: [node],
    })
    expect(ownerAfterRegister.toLowerCase()).toBe(alice.address.toLowerCase())
  })

  it('deployer transfers "alice" node to bob via transferSubnodeByGateway', async () => {
    const { node } = nodeForLabel(ROOT, 'alice')

    // Confirm pre-condition: alice is current owner
    const ownerBefore = await publicClient.readContract({
      address: contractAddress,
      abi: L2V3_ABI,
      functionName: 'subnodeOwner',
      args: [node],
    })
    expect(ownerBefore.toLowerCase()).toBe(alice.address.toLowerCase())

    // Deployer (contract owner) triggers the gateway transfer
    const txHash = await deployerWallet.writeContract({
      address: contractAddress,
      abi: L2V3_ABI,
      functionName: 'transferSubnodeByGateway',
      args: [node, alice.address, BOB_ADDR],
      account: deployer,
      chain: anvilChain,
    })
    await publicClient.waitForTransactionReceipt({ hash: txHash })

    // Post-condition: bob is the new owner
    const ownerAfter = await publicClient.readContract({
      address: contractAddress,
      abi: L2V3_ABI,
      functionName: 'subnodeOwner',
      args: [node],
    })
    expect(ownerAfter.toLowerCase()).toBe(BOB_ADDR.toLowerCase())
    expect(ownerAfter.toLowerCase()).not.toBe(alice.address.toLowerCase())
  })

  it('non-owner cannot call transferSubnodeByGateway', async () => {
    // Register a fresh node for this isolation test
    const { labelhash: lh2, node: node2 } = nodeForLabel(ROOT, 'charlie')
    const txReg = await deployerWallet.writeContract({
      address: contractAddress,
      abi: L2V3_ABI,
      functionName: 'setSubnodeOwner',
      args: [ROOT, lh2, alice.address, 'charlie'],
      account: deployer,
      chain: anvilChain,
    })
    await publicClient.waitForTransactionReceipt({ hash: txReg })

    // alice (non-owner) tries to transfer charlie's node — should revert
    const aliceWallet = createWalletClient({
      account: alice,
      chain: anvilChain,
      transport: http(`http://127.0.0.1:${ANVIL_PORT}`),
    })

    await expect(
      aliceWallet.writeContract({
        address: contractAddress,
        abi: L2V3_ABI,
        functionName: 'transferSubnodeByGateway',
        args: [node2, alice.address, BOB_ADDR],
        account: alice,
        chain: anvilChain,
      })
    ).rejects.toThrow()
  })
})
