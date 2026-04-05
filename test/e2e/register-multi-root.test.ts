/**
 * E2E Test: D6 Multi-root domain registration against local Anvil.
 *
 * Verifies that a wallet can own subdomains under multiple parent domains
 * simultaneously — the D6 "no primaryNode restriction" behavior.
 *
 * Flow:
 *   1. Start Anvil on a dedicated port
 *   2. Deploy L2RecordsV3 with deployer as owner
 *   3. Add deployer as registrar for namehash('aastar.eth')
 *   4. Register 'alice' under aastar.eth → verify subnodeOwner == alice
 *   5. Add deployer as registrar for namehash('forest.aastar.eth')
 *   6. Register 'alice' under forest.aastar.eth → verify subnodeOwner == alice
 *   7. Both nodes simultaneously owned by alice (D6: no per-wallet restriction)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  toBytes,
  toHex,
  encodePacked,
  namehash,
  type Hex,
  type Address,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { foundry } from 'viem/chains'
import { spawn, type ChildProcess } from 'child_process'
import { readFileSync } from 'fs'
import { join } from 'path'

// ─── Constants ────────────────────────────────────────────────────────────────

const ANVIL_PORT = 18552
const CONTRACTS_DIR = join(import.meta.dirname, '..', '..', 'contracts')

// Anvil well-known test accounts (same across all e2e tests)
const DEPLOYER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex
const ALICE_PK    = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex

const deployer = privateKeyToAccount(DEPLOYER_PK)
const alice    = privateKeyToAccount(ALICE_PK)

// ENS parent nodes
const AASTAR_ETH_NODE    = namehash('aastar.eth') as Hex
const FOREST_AASTAR_NODE = namehash('forest.aastar.eth') as Hex

const anvilChain = {
  ...foundry,
  id: 31337,
  rpcUrls: { default: { http: [`http://127.0.0.1:${ANVIL_PORT}`] } },
}

// ─── Minimal ABI ──────────────────────────────────────────────────────────────

const L2V3_ABI = [
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  {
    type: 'function', name: 'addRegistrar', stateMutability: 'nonpayable',
    inputs: [
      { name: 'parentNode', type: 'bytes32' },
      { name: 'registrar',  type: 'address' },
      { name: 'quota',      type: 'uint256' },
      { name: 'expiry',     type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function', name: 'isRegistrar', stateMutability: 'view',
    inputs: [{ name: 'parentNode', type: 'bytes32' }, { name: 'addr_', type: 'address' }],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function', name: 'registerSubnode', stateMutability: 'nonpayable',
    inputs: [
      { name: 'parentNode', type: 'bytes32' },
      { name: 'labelhash',  type: 'bytes32' },
      { name: 'newOwner',   type: 'address' },
      { name: 'label',      type: 'string' },
      { name: 'addrBytes',  type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function', name: 'subnodeOwner', stateMutability: 'view',
    inputs: [{ name: 'node', type: 'bytes32' }],
    outputs: [{ type: 'address' }],
  },
] as const

// ─── Helpers ──────────────────────────────────────────────────────────────────

function labelHash(label: string): Hex {
  return keccak256(toBytes(label)) as Hex
}

function subnodeHash(parentNode: Hex, label: string): Hex {
  const lh = labelHash(label)
  return keccak256(encodePacked(['bytes32', 'bytes32'], [parentNode, lh])) as Hex
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

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('E2E: D6 multi-root domain registration on local Anvil', () => {
  let contractAddress: Address
  let publicClient: ReturnType<typeof createPublicClient>
  let deployerWallet: ReturnType<typeof createWalletClient>

  // Computed node values for the two registrations
  let aliceUnderAastarNode: Hex       // namehash('alice.aastar.eth')
  let aliceUnderForestNode: Hex       // namehash('alice.forest.aastar.eth')

  beforeAll(async () => {
    anvilProc = spawn('anvil', [
      '--port', String(ANVIL_PORT),
      '--hardfork', 'prague',
      '--disable-code-size-limit',
      '--silent',
    ])
    await waitForAnvil(ANVIL_PORT)

    publicClient   = createPublicClient({ chain: anvilChain, transport: http(`http://127.0.0.1:${ANVIL_PORT}`) })
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

    // Pre-compute node hashes for assertions
    aliceUnderAastarNode  = subnodeHash(AASTAR_ETH_NODE, 'alice')
    aliceUnderForestNode  = subnodeHash(FOREST_AASTAR_NODE, 'alice')
  }, 60_000)

  afterAll(() => {
    anvilProc?.kill()
  })

  // ── Step 1: contract owner check ──────────────────────────────────────────

  it('deploys L2RecordsV3 with deployer as owner', async () => {
    const contractOwner = await publicClient.readContract({
      address: contractAddress, abi: L2V3_ABI, functionName: 'owner', args: [],
    })
    expect(contractOwner.toLowerCase()).toBe(deployer.address.toLowerCase())
  })

  // ── Step 2: aastar.eth registrar ──────────────────────────────────────────

  it('adds deployer as registrar for aastar.eth node', async () => {
    const expiry = BigInt(Math.floor(Date.now() / 1000) + 86_400 * 365)  // 1 year
    const txHash = await deployerWallet.writeContract({
      address: contractAddress, abi: L2V3_ABI, functionName: 'addRegistrar',
      args: [AASTAR_ETH_NODE, deployer.address, 100n, expiry],
      account: deployer, chain: anvilChain,
    })
    await publicClient.waitForTransactionReceipt({ hash: txHash })

    const isReg = await publicClient.readContract({
      address: contractAddress, abi: L2V3_ABI, functionName: 'isRegistrar',
      args: [AASTAR_ETH_NODE, deployer.address],
    })
    expect(isReg).toBe(true)
  })

  // ── Step 3: register alice under aastar.eth ───────────────────────────────

  it('registers "alice" under aastar.eth → subnodeOwner == alice', async () => {
    const lh = labelHash('alice')
    const addrBytes = toHex(toBytes(alice.address), { size: 20 }) as Hex

    const txHash = await deployerWallet.writeContract({
      address: contractAddress, abi: L2V3_ABI, functionName: 'registerSubnode',
      args: [AASTAR_ETH_NODE, lh, alice.address, 'alice', addrBytes],
      account: deployer, chain: anvilChain,
    })
    await publicClient.waitForTransactionReceipt({ hash: txHash })

    const owner = await publicClient.readContract({
      address: contractAddress, abi: L2V3_ABI, functionName: 'subnodeOwner',
      args: [aliceUnderAastarNode],
    })
    expect(owner.toLowerCase()).toBe(alice.address.toLowerCase())
  })

  // ── Step 4: forest.aastar.eth registrar ───────────────────────────────────

  it('adds deployer as registrar for forest.aastar.eth node', async () => {
    const expiry = BigInt(Math.floor(Date.now() / 1000) + 86_400 * 365)
    const txHash = await deployerWallet.writeContract({
      address: contractAddress, abi: L2V3_ABI, functionName: 'addRegistrar',
      args: [FOREST_AASTAR_NODE, deployer.address, 100n, expiry],
      account: deployer, chain: anvilChain,
    })
    await publicClient.waitForTransactionReceipt({ hash: txHash })

    const isReg = await publicClient.readContract({
      address: contractAddress, abi: L2V3_ABI, functionName: 'isRegistrar',
      args: [FOREST_AASTAR_NODE, deployer.address],
    })
    expect(isReg).toBe(true)
  })

  // ── Step 5: register alice under forest.aastar.eth ────────────────────────

  it('registers "alice" under forest.aastar.eth → subnodeOwner == alice', async () => {
    const lh = labelHash('alice')
    const addrBytes = toHex(toBytes(alice.address), { size: 20 }) as Hex

    const txHash = await deployerWallet.writeContract({
      address: contractAddress, abi: L2V3_ABI, functionName: 'registerSubnode',
      args: [FOREST_AASTAR_NODE, lh, alice.address, 'alice', addrBytes],
      account: deployer, chain: anvilChain,
    })
    await publicClient.waitForTransactionReceipt({ hash: txHash })

    const owner = await publicClient.readContract({
      address: contractAddress, abi: L2V3_ABI, functionName: 'subnodeOwner',
      args: [aliceUnderForestNode],
    })
    expect(owner.toLowerCase()).toBe(alice.address.toLowerCase())
  })

  // ── Step 6: D6 verification — both nodes owned simultaneously ─────────────

  it('D6: alice owns alice.aastar.eth and alice.forest.aastar.eth simultaneously', async () => {
    // Both ownership queries in parallel
    const [ownerAastar, ownerForest] = await Promise.all([
      publicClient.readContract({
        address: contractAddress, abi: L2V3_ABI, functionName: 'subnodeOwner',
        args: [aliceUnderAastarNode],
      }),
      publicClient.readContract({
        address: contractAddress, abi: L2V3_ABI, functionName: 'subnodeOwner',
        args: [aliceUnderForestNode],
      }),
    ])

    expect(ownerAastar.toLowerCase()).toBe(alice.address.toLowerCase())
    expect(ownerForest.toLowerCase()).toBe(alice.address.toLowerCase())
  })

  it('D6: alice.aastar.eth and alice.forest.aastar.eth have distinct node hashes', () => {
    expect(aliceUnderAastarNode).not.toBe(aliceUnderForestNode)
  })

  it('D6: namehash("alice.aastar.eth") matches subnodeHash(aastar.eth, "alice")', () => {
    const fromNs = namehash('alice.aastar.eth') as Hex
    expect(aliceUnderAastarNode.toLowerCase()).toBe(fromNs.toLowerCase())
  })

  it('D6: namehash("alice.forest.aastar.eth") matches subnodeHash(forest.aastar.eth, "alice")', () => {
    const fromNs = namehash('alice.forest.aastar.eth') as Hex
    expect(aliceUnderForestNode.toLowerCase()).toBe(fromNs.toLowerCase())
  })
})
