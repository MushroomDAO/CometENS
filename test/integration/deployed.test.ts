/**
 * Integration tests against deployed contracts on testnets.
 *
 * Requirements:
 *   - .env.local with OP_SEPOLIA_RPC_URL, OP_L2_RECORDS_ADDRESS,
 *     PRIVATE_KEY_JASON, SEPOLIA_RPC_URL, L1_OFFCHAIN_RESOLVER_ADDRESS
 *
 * Run: npm test -- test/integration-deployed.test.ts
 *
 * These tests skip gracefully if env vars are not set.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  toBytes,
  encodePacked,
  encodeFunctionData,
  encodeAbiParameters,
  decodeAbiParameters,
  toHex,
  namehash,
  type Hex,
  type Address,
} from 'viem'
import { optimismSepolia, sepolia } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'

// ─── Config ───────────────────────────────────────────────────────────────────

const OP_RPC     = process.env.OP_SEPOLIA_RPC_URL ?? ''
const L2_ADDR    = (process.env.OP_L2_RECORDS_ADDRESS ?? '') as Address
const L1_RPC     = process.env.SEPOLIA_RPC_URL ?? ''
const L1_ADDR    = (process.env.L1_OFFCHAIN_RESOLVER_ADDRESS ?? '') as Address
const PRIVATE_KEY = (process.env.PRIVATE_KEY_JASON ?? '') as Hex
const SIGNER_PK   = (process.env.PRIVATE_KEY_SUPPLIER ?? PRIVATE_KEY) as Hex

const SKIP = !OP_RPC || !L2_ADDR || L2_ADDR === '' || !PRIVATE_KEY

// ─── ABIs ─────────────────────────────────────────────────────────────────────

const L2_ABI = [
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'registerSubnode', stateMutability: 'nonpayable', inputs: [{ name: 'parentNode', type: 'bytes32' }, { name: 'labelhash', type: 'bytes32' }, { name: 'newOwner', type: 'address' }, { name: 'label', type: 'string' }, { name: 'addrBytes', type: 'bytes' }], outputs: [] },
  { type: 'function', name: 'setSubnodeOwner', stateMutability: 'nonpayable', inputs: [{ name: 'parentNode', type: 'bytes32' }, { name: 'labelhash', type: 'bytes32' }, { name: 'newOwner', type: 'address' }, { name: 'label', type: 'string' }], outputs: [] },
  { type: 'function', name: 'labelOf', stateMutability: 'view', inputs: [{ name: 'node', type: 'bytes32' }], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'primaryNode', stateMutability: 'view', inputs: [{ name: 'addr_', type: 'address' }], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'subnodeOwner', stateMutability: 'view', inputs: [{ name: 'node', type: 'bytes32' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'setAddr', stateMutability: 'nonpayable', inputs: [{ name: 'node', type: 'bytes32' }, { name: 'coinType', type: 'uint256' }, { name: 'addrBytes', type: 'bytes' }], outputs: [] },
  { type: 'function', name: 'addr', stateMutability: 'view', inputs: [{ name: 'node', type: 'bytes32' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'setText', stateMutability: 'nonpayable', inputs: [{ name: 'node', type: 'bytes32' }, { name: 'key', type: 'string' }, { name: 'value', type: 'string' }], outputs: [] },
  { type: 'function', name: 'text', stateMutability: 'view', inputs: [{ name: 'node', type: 'bytes32' }, { name: 'key', type: 'string' }], outputs: [{ type: 'string' }] },
] as const

const RESOLVER_ABI = [
  { type: 'function', name: 'signerAddress', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'gatewayUrl', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'resolveWithProof', stateMutability: 'view', inputs: [{ name: 'response', type: 'bytes' }, { name: 'extraData', type: 'bytes' }], outputs: [{ type: 'bytes' }] },
] as const

// ─── Helpers ──────────────────────────────────────────────────────────────────

function labelhash(label: string): Hex {
  return keccak256(toBytes(label)) as Hex
}

function makeNode(parentNode: Hex, label: string): Hex {
  const lh = labelhash(label)
  return keccak256(encodePacked(['bytes32', 'bytes32'], [parentNode, lh])) as Hex
}

const ROOT = '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex

// ─── Tests ────────────────────────────────────────────────────────────────────

describe.skipIf(SKIP)('Integration: L2Records on OP Sepolia', () => {
  let opPub: ReturnType<typeof createPublicClient>
  let opWallet: ReturnType<typeof createWalletClient>
  let deployer: ReturnType<typeof privateKeyToAccount>
  const testLabel = `test-${Date.now()}`

  beforeAll(() => {
    deployer = privateKeyToAccount(PRIVATE_KEY)
    opPub = createPublicClient({ chain: optimismSepolia, transport: http(OP_RPC) })
    opWallet = createWalletClient({ account: deployer, chain: optimismSepolia, transport: http(OP_RPC) })
  })

  it('reads L2Records contract owner', async () => {
    const owner = await opPub.readContract({ address: L2_ADDR, abi: L2_ABI, functionName: 'owner', args: [] })
    console.log('L2Records owner:', owner)
    expect(owner.toLowerCase()).toBe(deployer.address.toLowerCase())
  }, 30_000)

  it('registers a subdomain + sets ETH addr atomically on OP Sepolia', async () => {
    const lh = labelhash(testLabel)
    const node = makeNode(ROOT, testLabel)
    const addrBytes = toHex(toBytes(deployer.address), { size: 20 }) as Hex

    const txHash = await opWallet.writeContract({
      address: L2_ADDR, abi: L2_ABI, functionName: 'registerSubnode',
      args: [ROOT, lh, deployer.address, testLabel, addrBytes],
      account: deployer, chain: optimismSepolia,
    })
    console.log('registerSubnode tx:', txHash)
    const receipt = await opPub.waitForTransactionReceipt({ hash: txHash, confirmations: 2 })
    expect(receipt.status).toBe('success')

    const nodeOwner = await opPub.readContract({ address: L2_ADDR, abi: L2_ABI, functionName: 'subnodeOwner', args: [node] })
    expect(nodeOwner.toLowerCase()).toBe(deployer.address.toLowerCase())

    const resolved = await opPub.readContract({ address: L2_ADDR, abi: L2_ABI, functionName: 'addr', args: [node] })
    expect(resolved.toLowerCase()).toBe(deployer.address.toLowerCase())

    const label = await opPub.readContract({ address: L2_ADDR, abi: L2_ABI, functionName: 'labelOf', args: [node] })
    expect(label).toBe(testLabel)
  }, 60_000)

  it('sets text record on OP Sepolia', async () => {
    const node = makeNode(ROOT, testLabel)
    const txHash = await opWallet.writeContract({
      address: L2_ADDR, abi: L2_ABI, functionName: 'setText',
      args: [node, 'com.twitter', '@cometens_test'],
      account: deployer, chain: optimismSepolia,
    })
    await opPub.waitForTransactionReceipt({ hash: txHash, confirmations: 2 })

    const value = await opPub.readContract({ address: L2_ADDR, abi: L2_ABI, functionName: 'text', args: [node, 'com.twitter'] })
    expect(value).toBe('@cometens_test')
    console.log('text record set:', value)
  }, 60_000)
})

describe.skipIf(!L1_RPC || !L1_ADDR)('Integration: OffchainResolver on Sepolia', () => {
  let l1Pub: ReturnType<typeof createPublicClient>

  beforeAll(() => {
    l1Pub = createPublicClient({ chain: sepolia, transport: http(L1_RPC) })
  })

  it('reads signer and gateway URL from deployed resolver', async () => {
    const signer = await l1Pub.readContract({ address: L1_ADDR, abi: RESOLVER_ABI, functionName: 'signerAddress', args: [] })
    const gateway = await l1Pub.readContract({ address: L1_ADDR, abi: RESOLVER_ABI, functionName: 'gatewayUrl', args: [] })
    console.log('Resolver signer:', signer)
    console.log('Resolver gateway:', gateway)
    expect(signer).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(gateway).toMatch(/^https?:\/\//)
  }, 30_000)

  it('resolveWithProof verifies a valid signed response', async () => {
    if (!SIGNER_PK) { console.log('SKIP: no PRIVATE_KEY_SUPPLIER'); return }

    const signerAccount = privateKeyToAccount(SIGNER_PK)
    const node = makeNode(ROOT, 'test-resolver')
    const addrCalldata = encodeFunctionData({
      abi: [{ type: 'function', name: 'addr', inputs: [{ name: 'node', type: 'bytes32' }], outputs: [{ type: 'address' }] }] as const,
      functionName: 'addr',
      args: [node],
    })

    // Build a fake result (resolver address itself)
    const fakeResult = encodeFunctionData({
      abi: [{ type: 'function', name: 'addr', inputs: [{ name: 'node', type: 'bytes32' }], outputs: [{ type: 'address' }] }] as const,
      functionName: 'addr',
      args: [node],
    }).slice(0, 10) // just the selector as placeholder

    const result = encodeAbiParameters([{ type: 'address' }], [signerAccount.address])
    const expires = BigInt(Math.floor(Date.now() / 1000) + 3600)

    const msgHash = keccak256(
      encodePacked(
        ['bytes2', 'address', 'uint64', 'bytes32', 'bytes32'],
        ['0x1900', L1_ADDR, expires, keccak256(addrCalldata), keccak256(result)]
      )
    )
    const sig = await signerAccount.signMessage({ message: { raw: msgHash } })

    const response = encodeAbiParameters(
      [{ type: 'bytes' }, { type: 'uint64' }, { type: 'bytes' }],
      [result, expires, sig]
    )
    const extraData = encodeAbiParameters(
      [{ type: 'bytes' }, { type: 'bytes' }],
      [toHex(toBytes('test-resolver.eth')), addrCalldata]
    )

    const returned = await l1Pub.readContract({
      address: L1_ADDR, abi: RESOLVER_ABI, functionName: 'resolveWithProof',
      args: [response, extraData],
    })

    const [decoded] = decodeAbiParameters([{ type: 'address' }], returned as Hex)
    expect((decoded as string).toLowerCase()).toBe(signerAccount.address.toLowerCase())
    console.log('resolveWithProof returned:', decoded)
  }, 30_000)
})

// ─── aastar.eth end-to-end ────────────────────────────────────────────────────

const ENS_NAME = 'aastar.eth'
const ENS_NODE = namehash(ENS_NAME) as Hex

const SKIP_E2E = !L1_RPC || !L1_ADDR || !OP_RPC || !L2_ADDR || !SIGNER_PK

const L2_WRITE_ABI = [
  { type: 'function', name: 'setAddr', stateMutability: 'nonpayable',
    inputs: [{ name: 'node', type: 'bytes32' }, { name: 'coinType', type: 'uint256' }, { name: 'addrBytes', type: 'bytes' }],
    outputs: [] },
  { type: 'function', name: 'addr', stateMutability: 'view',
    inputs: [{ name: 'node', type: 'bytes32' }], outputs: [{ type: 'address' }] },
] as const

const RESOLVER_FULL_ABI = [
  { type: 'function', name: 'resolve', stateMutability: 'view',
    inputs: [{ name: 'name', type: 'bytes' }, { name: 'data', type: 'bytes' }],
    outputs: [{ type: 'bytes' }] },
  { type: 'function', name: 'resolveWithProof', stateMutability: 'view',
    inputs: [{ name: 'response', type: 'bytes' }, { name: 'extraData', type: 'bytes' }],
    outputs: [{ type: 'bytes' }] },
] as const

describe.skipIf(SKIP_E2E)('Integration: aastar.eth CCIP-Read flow', () => {
  let l1Pub: ReturnType<typeof createPublicClient>
  let opPub: ReturnType<typeof createPublicClient>
  let opWallet: ReturnType<typeof createWalletClient>
  let deployer: ReturnType<typeof privateKeyToAccount>
  let signerAccount: ReturnType<typeof privateKeyToAccount>

  beforeAll(() => {
    deployer = privateKeyToAccount(PRIVATE_KEY as Hex)
    signerAccount = privateKeyToAccount(SIGNER_PK as Hex)
    l1Pub = createPublicClient({ chain: sepolia, transport: http(L1_RPC) })
    opPub = createPublicClient({ chain: optimismSepolia, transport: http(OP_RPC) })
    opWallet = createWalletClient({ account: deployer, chain: optimismSepolia, transport: http(OP_RPC) })
  })

  it('aastar.eth resolver on Sepolia is set to our OffchainResolver', async () => {
    const resolver = await l1Pub.getEnsResolver({ name: ENS_NAME })
    console.log('aastar.eth resolver:', resolver)
    expect(resolver?.toLowerCase()).toBe(L1_ADDR.toLowerCase())
  }, 30_000)

  it('sets ETH addr record for aastar.eth node on L2Records', async () => {
    const addrBytes = toHex(toBytes(deployer.address), { size: 20 }) as Hex
    const txHash = await opWallet.writeContract({
      address: L2_ADDR, abi: L2_WRITE_ABI, functionName: 'setAddr',
      args: [ENS_NODE, 60n, addrBytes],
      account: deployer, chain: optimismSepolia,
    })
    console.log('L2 setAddr tx:', txHash)
    const receipt = await opPub.waitForTransactionReceipt({ hash: txHash, confirmations: 2 })
    expect(receipt.status).toBe('success')

    const stored = await opPub.readContract({
      address: L2_ADDR, abi: L2_WRITE_ABI, functionName: 'addr', args: [ENS_NODE],
    })
    console.log('L2 addr for aastar.eth:', stored)
    expect(stored.toLowerCase()).toBe(deployer.address.toLowerCase())
  }, 60_000)

  it('manually signs CCIP-Read response and resolveWithProof verifies it for aastar.eth', async () => {
    // Build calldata for addr(node) query on aastar.eth
    const addrCalldata = encodeFunctionData({
      abi: [{ type: 'function', name: 'addr', inputs: [{ name: 'node', type: 'bytes32' }], outputs: [{ type: 'address' }] }] as const,
      functionName: 'addr',
      args: [ENS_NODE],
    })

    // Simulate what the gateway returns: ABI-encode the deployer address as result
    const result = encodeAbiParameters([{ type: 'address' }], [deployer.address])
    const expires = BigInt(Math.floor(Date.now() / 1000) + 3600)

    // EIP-3668 signature: hex"1900" ++ resolver ++ expires ++ keccak256(calldata) ++ keccak256(result)
    const msgHash = keccak256(
      encodePacked(
        ['bytes2', 'address', 'uint64', 'bytes32', 'bytes32'],
        ['0x1900', L1_ADDR, expires, keccak256(addrCalldata), keccak256(result)]
      )
    )
    const sig = await signerAccount.signMessage({ message: { raw: msgHash } })

    const response = encodeAbiParameters(
      [{ type: 'bytes' }, { type: 'uint64' }, { type: 'bytes' }],
      [result, expires, sig]
    )
    // extraData must match what resolve() puts in OffchainLookup: abi.encode(name_bytes, calldata)
    const dnsEncoded = toHex(toBytes(ENS_NAME))
    const extraData = encodeAbiParameters(
      [{ type: 'bytes' }, { type: 'bytes' }],
      [dnsEncoded, addrCalldata]
    )

    const returned = await l1Pub.readContract({
      address: L1_ADDR, abi: RESOLVER_FULL_ABI, functionName: 'resolveWithProof',
      args: [response, extraData],
    })
    const [decoded] = decodeAbiParameters([{ type: 'address' }], returned as Hex)
    console.log('resolveWithProof for aastar.eth:', decoded)
    expect((decoded as string).toLowerCase()).toBe(deployer.address.toLowerCase())
  }, 30_000)
})
