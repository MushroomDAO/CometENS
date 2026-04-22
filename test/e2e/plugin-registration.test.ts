/**
 * E2E Test: Plugin registration flow against a local Anvil node.
 *
 * Flow:
 *   1. Start Anvil on a dedicated port
 *   2. Deploy L2RecordsV3 and FlatFeePlugin (0.01 ETH fee)
 *   3. Deployer registers "parent" subdomain for alice → alice owns the "parent" NFT
 *   4. Alice calls setPlugin(NODE_PARENT, flatFeePlugin)
 *   5. Deployer (contract owner / registrar) registers "child" under NODE_PARENT with 0.01 ETH
 *   6. Verify "child" was registered and subnodeOwner == bob
 *   7. Try to register a second child without fee → should revert with InsufficientFee
 *   8. Verify pendingFees[alice] == 0.01 ETH
 *   9. Alice withdraws fees → her balance increases
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  toBytes,
  encodePacked,
  parseEther,
  toHex,
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

// Anvil well-known test accounts
const DEPLOYER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex
const ALICE_PK    = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex

const deployer = privateKeyToAccount(DEPLOYER_PK)
const alice    = privateKeyToAccount(ALICE_PK)

// Bob is the recipient of the "child" registration
const BOB_ADDR = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as Address

const ROOT        = '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex
const FLAT_FEE    = parseEther('0.01')

const anvilChain = {
  ...foundry,
  id: 31337,
  rpcUrls: { default: { http: [`http://127.0.0.1:${ANVIL_PORT}`] } },
}

// ─── ABIs ─────────────────────────────────────────────────────────────────────

const L2V3_ABI = [
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  {
    type: 'function', name: 'subnodeOwner', stateMutability: 'view',
    inputs: [{ name: 'node', type: 'bytes32' }],
    outputs: [{ type: 'address' }],
  },
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
    type: 'function', name: 'registerSubnode', stateMutability: 'payable',
    inputs: [
      { name: 'parentNode', type: 'bytes32' },
      { name: 'labelhash', type: 'bytes32' },
      { name: 'newOwner', type: 'address' },
      { name: 'label', type: 'string' },
      { name: 'addrBytes', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function', name: 'setPlugin', stateMutability: 'nonpayable',
    inputs: [
      { name: 'parentNode', type: 'bytes32' },
      { name: 'plugin', type: 'address' },
    ],
    outputs: [],
  },
  {
    type: 'function', name: 'registrarPlugin', stateMutability: 'view',
    inputs: [{ name: 'parentNode', type: 'bytes32' }],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function', name: 'pendingFees', stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function', name: 'withdrawFees', stateMutability: 'nonpayable',
    inputs: [],
    outputs: [],
  },
] as const

const FLAT_FEE_PLUGIN_ABI = [
  { type: 'function', name: 'fee', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
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

async function deployArtifact(
  artifactPath: string,
  args: unknown[],
  wallet: ReturnType<typeof createWalletClient>,
  pub: ReturnType<typeof createPublicClient>,
): Promise<Address> {
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'))
  const txHash = await wallet.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object as Hex,
    args,
  })
  const receipt = await pub.waitForTransactionReceipt({ hash: txHash })
  if (!receipt.contractAddress) throw new Error(`Deploy failed for ${artifactPath}`)
  return receipt.contractAddress
}

// ─── Anvil lifecycle ──────────────────────────────────────────────────────────

let anvilProc: ChildProcess

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('E2E: plugin registration flow on local Anvil', () => {
  let l2Records: Address
  let flatFeePlugin: Address
  let publicClient: ReturnType<typeof createPublicClient>
  let deployerWallet: ReturnType<typeof createWalletClient>
  let aliceWallet: ReturnType<typeof createWalletClient>

  // NODE_PARENT = namehash("parent" under ROOT)
  let NODE_PARENT: Hex

  beforeAll(async () => {
    anvilProc = spawn('anvil', ['--port', String(ANVIL_PORT), '--hardfork', 'prague', '--disable-code-size-limit', '--silent'])
    await waitForAnvil(ANVIL_PORT)

    publicClient   = createPublicClient({ chain: anvilChain, transport: http(`http://127.0.0.1:${ANVIL_PORT}`) })
    deployerWallet = createWalletClient({ account: deployer, chain: anvilChain, transport: http(`http://127.0.0.1:${ANVIL_PORT}`) })
    aliceWallet    = createWalletClient({ account: alice,    chain: anvilChain, transport: http(`http://127.0.0.1:${ANVIL_PORT}`) })

    // Deploy L2RecordsV3
    l2Records = await deployArtifact(
      join(CONTRACTS_DIR, 'out', 'L2RecordsV3.sol', 'L2RecordsV3.json'),
      [deployer.address],
      deployerWallet,
      publicClient,
    )

    // Deploy FlatFeePlugin with 0.01 ETH fee
    flatFeePlugin = await deployArtifact(
      join(CONTRACTS_DIR, 'out', 'FlatFeePlugin.sol', 'FlatFeePlugin.json'),
      [FLAT_FEE],
      deployerWallet,
      publicClient,
    )

    // Step 3: Deployer registers "parent" subdomain for alice
    const { labelhash: parentLH, node: parentNode } = nodeForLabel(ROOT, 'parent')
    NODE_PARENT = parentNode

    const txReg = await deployerWallet.writeContract({
      address: l2Records,
      abi: L2V3_ABI,
      functionName: 'setSubnodeOwner',
      args: [ROOT, parentLH, alice.address, 'parent'],
      account: deployer,
      chain: anvilChain,
    })
    await publicClient.waitForTransactionReceipt({ hash: txReg })
  }, 30_000)

  afterAll(() => {
    anvilProc?.kill()
  })

  it('FlatFeePlugin is deployed with 0.01 ETH fee', async () => {
    const fee = await publicClient.readContract({
      address: flatFeePlugin,
      abi: FLAT_FEE_PLUGIN_ABI,
      functionName: 'fee',
      args: [],
    })
    expect(fee).toBe(FLAT_FEE)
  })

  it('alice owns the "parent" NFT', async () => {
    const parentOwner = await publicClient.readContract({
      address: l2Records,
      abi: L2V3_ABI,
      functionName: 'subnodeOwner',
      args: [NODE_PARENT],
    })
    expect(parentOwner.toLowerCase()).toBe(alice.address.toLowerCase())
  })

  it('alice can set FlatFeePlugin on her parent node', async () => {
    // Alice owns the parent NFT → she can attach a plugin
    const txPlugin = await aliceWallet.writeContract({
      address: l2Records,
      abi: L2V3_ABI,
      functionName: 'setPlugin',
      args: [NODE_PARENT, flatFeePlugin],
      account: alice,
      chain: anvilChain,
    })
    await publicClient.waitForTransactionReceipt({ hash: txPlugin })

    const pluginAddr = await publicClient.readContract({
      address: l2Records,
      abi: L2V3_ABI,
      functionName: 'registrarPlugin',
      args: [NODE_PARENT],
    })
    expect(pluginAddr.toLowerCase()).toBe(flatFeePlugin.toLowerCase())
  })

  it('deployer registers "child" under parent with correct fee → child is owned by bob', async () => {
    const { labelhash: childLH, node: childNode } = nodeForLabel(NODE_PARENT, 'child')
    const addrBytes = toHex(toBytes(BOB_ADDR), { size: 20 }) as Hex

    // Deployer is the contract owner and calls registerSubnode with the required ETH fee
    const txChild = await deployerWallet.writeContract({
      address: l2Records,
      abi: L2V3_ABI,
      functionName: 'registerSubnode',
      args: [NODE_PARENT, childLH, BOB_ADDR, 'child', addrBytes],
      account: deployer,
      chain: anvilChain,
      value: FLAT_FEE,
    })
    await publicClient.waitForTransactionReceipt({ hash: txChild })

    const childOwner = await publicClient.readContract({
      address: l2Records,
      abi: L2V3_ABI,
      functionName: 'subnodeOwner',
      args: [childNode],
    })
    expect(childOwner.toLowerCase()).toBe(BOB_ADDR.toLowerCase())
  })

  it('pendingFees[alice] accumulated the 0.01 ETH fee', async () => {
    const pending = await publicClient.readContract({
      address: l2Records,
      abi: L2V3_ABI,
      functionName: 'pendingFees',
      args: [alice.address],
    })
    expect(pending).toBe(FLAT_FEE)
  })

  it('registration without fee reverts with InsufficientFee', async () => {
    const { labelhash: lh2 } = nodeForLabel(NODE_PARENT, 'child2')
    const addrBytes = toHex(toBytes(BOB_ADDR), { size: 20 }) as Hex

    await expect(
      deployerWallet.writeContract({
        address: l2Records,
        abi: L2V3_ABI,
        functionName: 'registerSubnode',
        args: [NODE_PARENT, lh2, BOB_ADDR, 'child2', addrBytes],
        account: deployer,
        chain: anvilChain,
        value: 0n, // no fee
      })
    ).rejects.toThrow()
  })

  it('alice withdraws fees — her balance increases', async () => {
    const balBefore = await publicClient.getBalance({ address: alice.address })

    const txWithdraw = await aliceWallet.writeContract({
      address: l2Records,
      abi: L2V3_ABI,
      functionName: 'withdrawFees',
      args: [],
      account: alice,
      chain: anvilChain,
    })
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txWithdraw })

    const balAfter = await publicClient.getBalance({ address: alice.address })

    // Gas cost offsets some of the gain; net change should be positive (received 0.01 ETH minus gas)
    const gasCost = receipt.gasUsed * receipt.effectiveGasPrice
    const netGain = balAfter - balBefore + gasCost  // add back gas to isolate fee received
    expect(netGain).toBe(FLAT_FEE)

    // pendingFees should now be cleared
    const pendingAfter = await publicClient.readContract({
      address: l2Records,
      abi: L2V3_ABI,
      functionName: 'pendingFees',
      args: [alice.address],
    })
    expect(pendingAfter).toBe(0n)
  })
})
