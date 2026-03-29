import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  encodeFunctionData,
  decodeFunctionResult,
  keccak256,
  toBytes,
  toHex,
  zeroAddress,
  type Hex,
} from 'viem'

// ─── Minimal ABI fragments ────────────────────────────────────────────────────

const ADDR_ABI = [
  {
    type: 'function',
    name: 'addr',
    stateMutability: 'view',
    inputs: [{ name: 'node', type: 'bytes32' }],
    outputs: [{ name: '', type: 'address' }],
  },
] as const

const TEXT_ABI = [
  {
    type: 'function',
    name: 'text',
    stateMutability: 'view',
    inputs: [
      { name: 'node', type: 'bytes32' },
      { name: 'key', type: 'string' },
    ],
    outputs: [{ name: '', type: 'string' }],
  },
] as const

const CONTENTHASH_ABI = [
  {
    type: 'function',
    name: 'contenthash',
    stateMutability: 'view',
    inputs: [{ name: 'node', type: 'bytes32' }],
    outputs: [{ name: '', type: 'bytes' }],
  },
] as const

// ─── Mock L2RecordsReader ─────────────────────────────────────────────────────

const TEST_NODE = keccak256(toBytes('alice.test')) as Hex
const TEST_ADDR = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' as Hex
const TEST_TEXT = '@alice_web3'
const TEST_CONTENTHASH = '0xe301017012201234567890abcdef' as Hex

const TEST_ADDR_BYTES = toHex(toBytes(TEST_ADDR), { size: 20 }) as Hex

const mockGetAddr = vi.fn().mockResolvedValue(TEST_ADDR)
const mockGetAddrByCoinType = vi.fn().mockResolvedValue(TEST_ADDR_BYTES)
const mockGetText = vi.fn().mockResolvedValue(TEST_TEXT)
const mockGetContenthash = vi.fn().mockResolvedValue(TEST_CONTENTHASH)

vi.mock('../../server/gateway/readers/L2RecordsReader', () => {
  class L2RecordsReader {
    getAddr = mockGetAddr
    getAddrByCoinType = mockGetAddrByCoinType
    getText = mockGetText
    getContenthash = mockGetContenthash
  }
  return { L2RecordsReader }
})

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>()
  return {
    ...actual,
    createPublicClient: vi.fn().mockReturnValue({}),
    http: vi.fn().mockReturnValue({}),
  }
})

vi.mock('viem/accounts', () => ({
  privateKeyToAccount: vi.fn().mockReturnValue(null),
}))

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('handleResolve', () => {
  beforeEach(() => {
    vi.resetModules()
    mockGetAddr.mockResolvedValue(TEST_ADDR)
    mockGetAddrByCoinType.mockResolvedValue(TEST_ADDR_BYTES)
    mockGetText.mockResolvedValue(TEST_TEXT)
    mockGetContenthash.mockResolvedValue(TEST_CONTENTHASH)
  })

  it('decodes addr calldata and returns encoded address', async () => {
    const calldata = encodeFunctionData({
      abi: ADDR_ABI,
      functionName: 'addr',
      args: [TEST_NODE],
    })

    const { handleResolve } = await import('../../server/gateway/index')
    const result = await handleResolve(calldata)

    const decoded = decodeFunctionResult({ abi: ADDR_ABI, functionName: 'addr', data: result })
    expect(decoded.toLowerCase()).toBe(TEST_ADDR.toLowerCase())
    expect(mockGetAddr).toHaveBeenCalledWith(TEST_NODE)
  })

  it('decodes addr(node, coinType) calldata and returns encoded bytes (ENSIP-11 multichain)', async () => {
    const ADDR_MULTICHAIN_ABI = [{
      type: 'function', name: 'addr', stateMutability: 'view',
      inputs: [{ name: 'node', type: 'bytes32' }, { name: 'coinType', type: 'uint256' }],
      outputs: [{ name: '', type: 'bytes' }],
    }] as const
    const BASE_COIN_TYPE = BigInt(0x80000000) | BigInt(8453) // toCoinType(base.id)
    const calldata = encodeFunctionData({
      abi: ADDR_MULTICHAIN_ABI,
      functionName: 'addr',
      args: [TEST_NODE, BASE_COIN_TYPE],
    })

    const { handleResolve } = await import('../../server/gateway/index')
    const result = await handleResolve(calldata)

    expect(result).toMatch(/^0x/)
    expect(mockGetAddrByCoinType).toHaveBeenCalledWith(TEST_NODE, BASE_COIN_TYPE)
  })

  it('decodes text calldata and returns encoded string', async () => {
    const calldata = encodeFunctionData({
      abi: TEXT_ABI,
      functionName: 'text',
      args: [TEST_NODE, 'com.twitter'],
    })

    const { handleResolve } = await import('../../server/gateway/index')
    const result = await handleResolve(calldata)

    const decoded = decodeFunctionResult({ abi: TEXT_ABI, functionName: 'text', data: result })
    expect(decoded).toBe(TEST_TEXT)
    expect(mockGetText).toHaveBeenCalledWith(TEST_NODE, 'com.twitter')
  })

  it('decodes contenthash calldata and returns encoded bytes', async () => {
    const calldata = encodeFunctionData({
      abi: CONTENTHASH_ABI,
      functionName: 'contenthash',
      args: [TEST_NODE],
    })

    const { handleResolve } = await import('../../server/gateway/index')
    const result = await handleResolve(calldata)

    const decoded = decodeFunctionResult({
      abi: CONTENTHASH_ABI,
      functionName: 'contenthash',
      data: result,
    })
    expect(decoded.toLowerCase()).toBe(TEST_CONTENTHASH.toLowerCase())
    expect(mockGetContenthash).toHaveBeenCalledWith(TEST_NODE)
  })

  it('throws on unsupported selector', async () => {
    const { handleResolve } = await import('../../server/gateway/index')
    await expect(handleResolve('0xdeadbeef' as Hex)).rejects.toThrow()
  })
})

describe('handleResolveSigned (no signer)', () => {
  it('returns abi-encoded {data} with empty sig when no private key configured', async () => {
    const calldata = encodeFunctionData({
      abi: ADDR_ABI,
      functionName: 'addr',
      args: [TEST_NODE],
    })

    const { handleResolveSigned } = await import('../../server/gateway/index')
    const result = await handleResolveSigned(calldata)

    expect(result).toHaveProperty('data')
    expect(result.data.startsWith('0x')).toBe(true)
    // data should be abi.encode(result, expires, sig) — longer than just the result
    expect(result.data.length).toBeGreaterThan(66)
  })
})
