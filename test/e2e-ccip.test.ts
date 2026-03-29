/**
 * E2E Test: CCIP-Read resolution flow using local Anvil nodes.
 *
 * Flow:
 *   1. Anvil L1 (port 18546): deploy OffchainResolver
 *   2. Anvil L2 (port 18547): deploy L2Records, write addr record
 *   3. Start gateway HTTP server (handleResolveSigned)
 *   4. Simulate CCIP-Read: call resolve() → catch OffchainLookup → POST gateway → resolveWithProof()
 *   5. Verify resolved address matches what was written on L2
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  toBytes,
  encodePacked,
  encodeFunctionData,
  decodeFunctionResult,
  decodeErrorResult,
  encodeAbiParameters,
  toHex,
  type Hex,
  type Address,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { foundry } from 'viem/chains'
import { spawn, type ChildProcess } from 'child_process'
import { readFileSync } from 'fs'
import { join } from 'path'
import { createServer, type Server } from 'http'
import { L2RecordsReader } from '../server/gateway/readers/L2RecordsReader'

// ─── Config ───────────────────────────────────────────────────────────────────

const L1_PORT = 18546
const L2_PORT = 18547
const GW_PORT = 18548
const CONTRACTS_DIR = join(import.meta.dirname, '..', 'contracts')

const DEPLOYER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex
const SIGNER_PK   = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as Hex
const deployer    = privateKeyToAccount(DEPLOYER_PK)
const signer      = privateKeyToAccount(SIGNER_PK)

const ALICE_ADDR: Address = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'

const l1Chain = { ...foundry, id: 31337, rpcUrls: { default: { http: [`http://127.0.0.1:${L1_PORT}`] } } }
const l2Chain = { ...foundry, id: 31337, rpcUrls: { default: { http: [`http://127.0.0.1:${L2_PORT}`] } } }

// ─── ABIs ─────────────────────────────────────────────────────────────────────

const OFFCHAIN_RESOLVER_ABI = [
  { type: 'function', name: 'resolve', stateMutability: 'view', inputs: [{ name: 'name', type: 'bytes' }, { name: 'data', type: 'bytes' }], outputs: [{ type: 'bytes' }] },
  { type: 'function', name: 'resolveWithProof', stateMutability: 'view', inputs: [{ name: 'response', type: 'bytes' }, { name: 'extraData', type: 'bytes' }], outputs: [{ type: 'bytes' }] },
  { type: 'error', name: 'OffchainLookup', inputs: [{ name: 'sender', type: 'address' }, { name: 'urls', type: 'string[]' }, { name: 'callData', type: 'bytes' }, { name: 'callbackFunction', type: 'bytes4' }, { name: 'extraData', type: 'bytes' }] },
] as const

const L2_RECORDS_ABI = [
  { type: 'function', name: 'addr', stateMutability: 'view', inputs: [{ name: 'node', type: 'bytes32' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'setAddr', stateMutability: 'nonpayable', inputs: [{ name: 'node', type: 'bytes32' }, { name: 'coinType', type: 'uint256' }, { name: 'addrBytes', type: 'bytes' }], outputs: [] },
  { type: 'function', name: 'setSubnodeOwner', stateMutability: 'nonpayable', inputs: [{ name: 'parentNode', type: 'bytes32' }, { name: 'labelhash', type: 'bytes32' }, { name: 'newOwner', type: 'address' }], outputs: [] },
] as const

// ─── Helpers ──────────────────────────────────────────────────────────────────

function namehash(name: string): Hex {
  let node = '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex
  if (!name) return node
  const labels = name.split('.').reverse()
  for (const label of labels) {
    const labelhash = keccak256(toBytes(label)) as Hex
    node = keccak256(encodePacked(['bytes32', 'bytes32'], [node, labelhash])) as Hex
  }
  return node
}

async function waitForPort(port: number, retries = 30): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      })
      if (res.ok) return
    } catch {
      // not ready
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`Port ${port} did not become available`)
}

async function deployContract(
  artifactName: string,
  args: unknown[],
  rpcPort: number,
  chain: typeof l1Chain,
): Promise<Address> {
  const artifact = JSON.parse(
    readFileSync(join(CONTRACTS_DIR, 'out', `${artifactName}.sol`, `${artifactName}.json`), 'utf8')
  )
  const wallet = createWalletClient({ account: deployer, chain, transport: http(`http://127.0.0.1:${rpcPort}`) })
  const pub = createPublicClient({ chain, transport: http(`http://127.0.0.1:${rpcPort}`) })
  const txHash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object, args })
  const receipt = await pub.waitForTransactionReceipt({ hash: txHash })
  if (!receipt.contractAddress) throw new Error(`${artifactName} deploy failed`)
  return receipt.contractAddress
}

// ─── Gateway server ───────────────────────────────────────────────────────────

function buildSignedResponse(result: Hex, expires: bigint, resolverAddr: Address): Hex {
  const messageHash = keccak256(
    encodePacked(
      ['bytes2', 'address', 'uint64', 'bytes32'],
      ['0x1900', resolverAddr, expires, keccak256(result)]
    )
  )
  return messageHash // returned for signing
}

function startGatewayServer(l2RecordsAddr: Address, l2RpcPort: number, resolverAddr: Address): Server {
  const l2Client = createPublicClient({ chain: l2Chain, transport: http(`http://127.0.0.1:${l2RpcPort}`) })
  const reader = new L2RecordsReader(l2Client as any, l2RecordsAddr)

  const ADDR_ABI = [{ type: 'function', name: 'addr', stateMutability: 'view', inputs: [{ name: 'node', type: 'bytes32' }], outputs: [{ name: '', type: 'address' }] }] as const

  return createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return }

    const body = await new Promise<string>((resolve) => {
      let raw = ''
      req.on('data', (c: Buffer) => { raw += c.toString() })
      req.on('end', () => resolve(raw))
    })

    try {
      const payload = JSON.parse(body) as { data?: Hex; sender?: Address; calldata?: Hex; resolverAddress?: Address }

      // Accept both viem CCIP-Read format {data, sender} and our custom format {calldata, resolverAddress}
      const calldata = (payload.data ?? payload.calldata) as Hex
      const resolverAddress = (payload.sender ?? payload.resolverAddress ?? resolverAddr) as Address

      const { decodeFunctionData, encodeFunctionResult } = await import('viem')
      const { functionName, args } = decodeFunctionData({ abi: ADDR_ABI, data: calldata })
      if (functionName !== 'addr') throw new Error('Unsupported selector')

      const [node] = args as [Hex]
      const addrValue = await reader.getAddr(node)

      const result = encodeFunctionResult({ abi: ADDR_ABI, functionName: 'addr', result: addrValue })

      const expires = BigInt(Math.floor(Date.now() / 1000) + 3600)
      // EIP-3668: bind signature to calldata to prevent replay across different queries
      const msgHash = keccak256(
        encodePacked(
          ['bytes2', 'address', 'uint64', 'bytes32', 'bytes32'],
          ['0x1900', resolverAddress, expires, keccak256(calldata), keccak256(result)]
        )
      )
      const sig = await signer.signMessage({ message: { raw: msgHash } })
      const response = encodeAbiParameters(
        [{ type: 'bytes' }, { type: 'uint64' }, { type: 'bytes' }],
        [result, expires, sig]
      )

      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: response }))
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: (e as Error).message }))
    }
  })
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('E2E: CCIP-Read resolution flow', () => {
  let l1Anvil: ChildProcess
  let l2Anvil: ChildProcess
  let gwServer: Server

  let resolverAddr: Address
  let l2RecordsAddr: Address

  const TEST_NAME = 'alice.test.eth'
  const TEST_NODE = namehash(TEST_NAME)

  beforeAll(async () => {
    // Start two Anvil instances
    l1Anvil = spawn('anvil', ['--port', String(L1_PORT), '--silent'])
    l2Anvil = spawn('anvil', ['--port', String(L2_PORT), '--silent'])
    await Promise.all([waitForPort(L1_PORT), waitForPort(L2_PORT)])

    // Deploy OffchainResolver on L1 (gateway URL points to our local server)
    resolverAddr = await deployContract(
      'OffchainResolver',
      [deployer.address, signer.address, `http://127.0.0.1:${GW_PORT}`],
      L1_PORT,
      l1Chain,
    )

    // Deploy L2Records on L2
    l2RecordsAddr = await deployContract('L2Records', [deployer.address], L2_PORT, l2Chain)

    // Write alice's ETH address to L2
    const l2Wallet = createWalletClient({ account: deployer, chain: l2Chain, transport: http(`http://127.0.0.1:${L2_PORT}`) })
    const l2Pub = createPublicClient({ chain: l2Chain, transport: http(`http://127.0.0.1:${L2_PORT}`) })

    const labelhash = keccak256(toBytes('alice')) as Hex
    const root = '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex

    // Note: for testing we use raw namehash parts; in production this matches ENS namehash
    const parentOfAliceTest = namehash('test.eth')
    let tx = await l2Wallet.writeContract({
      address: l2RecordsAddr, abi: L2_RECORDS_ABI, functionName: 'setSubnodeOwner',
      args: [parentOfAliceTest, labelhash, ALICE_ADDR],
      account: deployer, chain: l2Chain,
    })
    await l2Pub.waitForTransactionReceipt({ hash: tx })

    const addrBytes = toHex(toBytes(ALICE_ADDR), { size: 20 }) as Hex
    tx = await l2Wallet.writeContract({
      address: l2RecordsAddr, abi: L2_RECORDS_ABI, functionName: 'setAddr',
      args: [TEST_NODE, 60n, addrBytes],
      account: deployer, chain: l2Chain,
    })
    await l2Pub.waitForTransactionReceipt({ hash: tx })

    // Start gateway server (pass resolverAddr so it can sign correctly for viem {sender} requests)
    gwServer = startGatewayServer(l2RecordsAddr, L2_PORT, resolverAddr)
    await new Promise<void>((resolve) => gwServer.listen(GW_PORT, '127.0.0.1', resolve))
  }, 45_000)

  afterAll(() => {
    l1Anvil?.kill()
    l2Anvil?.kill()
    gwServer?.close()
  })

  it('viem automatically follows OffchainLookup (EIP-3668) and resolves alice address', async () => {
    // viem readContract with ccipRead: { enabled: true } (the default) automatically follows CCIP-Read.
    // It catches the OffchainLookup revert, calls the gateway, then calls resolveWithProof.
    const l1Pub = createPublicClient({
      chain: l1Chain,
      transport: http(`http://127.0.0.1:${L1_PORT}`),
      // CCIP-Read enabled by default in viem
    })

    const addrCalldata = encodeFunctionData({
      abi: [{ type: 'function', name: 'addr', inputs: [{ name: 'node', type: 'bytes32' }], outputs: [{ type: 'address' }] }] as const,
      functionName: 'addr',
      args: [TEST_NODE],
    })

    // viem will: call resolve() → catch OffchainLookup → POST gateway → call resolveWithProof()
    const result = await l1Pub.readContract({
      address: resolverAddr,
      abi: OFFCHAIN_RESOLVER_ABI,
      functionName: 'resolve',
      args: [toHex(toBytes(TEST_NAME)), addrCalldata],
    })

    // result is the raw bytes returned by resolveWithProof (ABI-encoded address)
    const decoded = decodeFunctionResult({
      abi: [{ type: 'function', name: 'addr', inputs: [{ name: 'node', type: 'bytes32' }], outputs: [{ type: 'address' }] }] as const,
      functionName: 'addr',
      data: result as Hex,
    })
    expect((decoded as string).toLowerCase()).toBe(ALICE_ADDR.toLowerCase())
  })

  it('manual CCIP-Read flow: POST gateway → resolveWithProof → returns alice address', async () => {
    // Tests the individual steps of CCIP-Read without viem's automatic handling.
    const l1Pub = createPublicClient({ chain: l1Chain, transport: http(`http://127.0.0.1:${L1_PORT}`) })

    const addrCalldata = encodeFunctionData({
      abi: [{ type: 'function', name: 'addr', inputs: [{ name: 'node', type: 'bytes32' }], outputs: [{ type: 'address' }] }] as const,
      functionName: 'addr',
      args: [TEST_NODE],
    })

    // Step 1: POST to gateway directly (simulating what a CCIP-Read client does after catching OffchainLookup)
    const gwRes = await fetch(`http://127.0.0.1:${GW_PORT}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ calldata: addrCalldata, resolverAddress: resolverAddr }),
    })
    expect(gwRes.ok).toBe(true)
    const { data: responseData } = (await gwRes.json()) as { data: Hex }
    expect(responseData).toMatch(/^0x/)

    // Step 2: Call resolveWithProof() with the gateway's signed response.
    // extraData must be abi.encode(name, callData) matching what resolve() put in OffchainLookup.
    const extraData = encodeAbiParameters(
      [{ type: 'bytes' }, { type: 'bytes' }],
      [toHex(toBytes(TEST_NAME)), addrCalldata],
    )
    const result = await l1Pub.readContract({
      address: resolverAddr,
      abi: OFFCHAIN_RESOLVER_ABI,
      functionName: 'resolveWithProof',
      args: [responseData, extraData],
    })

    // Step 3: Decode ABI-encoded address from result
    const decoded = decodeFunctionResult({
      abi: [{ type: 'function', name: 'addr', inputs: [{ name: 'node', type: 'bytes32' }], outputs: [{ type: 'address' }] }] as const,
      functionName: 'addr',
      data: result as Hex,
    })

    expect((decoded as string).toLowerCase()).toBe(ALICE_ADDR.toLowerCase())
  })

  it('gateway returns 400 for unsupported calldata', async () => {
    const res = await fetch(`http://127.0.0.1:${GW_PORT}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ calldata: '0xdeadbeef', resolverAddress: resolverAddr }),
    })
    expect(res.status).toBe(400)
  })
})
