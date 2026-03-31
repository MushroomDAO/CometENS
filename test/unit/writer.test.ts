import { describe, it, expect, vi, beforeEach } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { optimismSepolia } from 'viem/chains'
import { keccak256, toBytes, toHex, type Hex } from 'viem'

// ─── Mock viem wallet/public client ──────────────────────────────────────────

const MOCK_TX_HASH = '0xabc123def456789000000000000000000000000000000000000000000000001' as Hex

const { mockWriteContract, mockWaitForTransactionReceipt } = vi.hoisted(() => ({
  mockWriteContract: vi.fn(),
  mockWaitForTransactionReceipt: vi.fn(),
}))

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>()
  return {
    ...actual,
    createWalletClient: vi.fn().mockReturnValue({
      writeContract: mockWriteContract,
      chain: optimismSepolia,
    }),
    createPublicClient: vi.fn().mockReturnValue({
      waitForTransactionReceipt: mockWaitForTransactionReceipt,
    }),
    http: vi.fn().mockReturnValue({}),
  }
})

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SIGNER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const
const account = privateKeyToAccount(SIGNER_PK)
const CONTRACT_ADDRESS = '0x1234567890123456789012345678901234567890' as Hex
const TEST_NODE = keccak256(toBytes('alice.test')) as Hex
const TEST_PARENT = keccak256(toBytes('parent')) as Hex
const TEST_LABEL = keccak256(toBytes('alice')) as Hex
const TEST_ADDR = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' as Hex

describe('L2RecordsWriter', () => {
  beforeEach(() => {
    mockWriteContract.mockResolvedValue(MOCK_TX_HASH)
    mockWaitForTransactionReceipt.mockResolvedValue({ status: 'success' })
  })

  it('registerSubnode calls writeContract with owner + label + addrBytes and returns txHash', async () => {
    const { L2RecordsWriter } = await import('../../server/gateway/writer/L2RecordsWriter')
    const writer = new L2RecordsWriter(account, optimismSepolia, 'http://localhost:8545', CONTRACT_ADDRESS)

    const addrBytes = toHex(toBytes(TEST_ADDR), { size: 20 }) as Hex
    const txHash = await writer.registerSubnode(TEST_PARENT, TEST_LABEL, TEST_ADDR, 'alice', addrBytes)

    expect(txHash).toBe(MOCK_TX_HASH)
    expect(mockWriteContract).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: 'registerSubnode',
        args: [TEST_PARENT, TEST_LABEL, TEST_ADDR, 'alice', addrBytes],
      })
    )
    expect(mockWaitForTransactionReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ hash: MOCK_TX_HASH })
    )
  })

  it('setAddr calls writeContract with correct args', async () => {
    const { L2RecordsWriter } = await import('../../server/gateway/writer/L2RecordsWriter')
    const writer = new L2RecordsWriter(account, optimismSepolia, 'http://localhost:8545', CONTRACT_ADDRESS)

    const addrBytes = toHex(toBytes(TEST_ADDR)) as Hex
    const txHash = await writer.setAddr(TEST_NODE, 60n, addrBytes)

    expect(txHash).toBe(MOCK_TX_HASH)
    expect(mockWriteContract).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: 'setAddr',
        args: [TEST_NODE, 60n, addrBytes],
      })
    )
  })

  it('setText calls writeContract with correct args', async () => {
    const { L2RecordsWriter } = await import('../../server/gateway/writer/L2RecordsWriter')
    const writer = new L2RecordsWriter(account, optimismSepolia, 'http://localhost:8545', CONTRACT_ADDRESS)

    const txHash = await writer.setText(TEST_NODE, 'com.twitter', '@alice')

    expect(txHash).toBe(MOCK_TX_HASH)
    expect(mockWriteContract).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: 'setText',
        args: [TEST_NODE, 'com.twitter', '@alice'],
      })
    )
  })

  it('setContenthash calls writeContract with correct args', async () => {
    const { L2RecordsWriter } = await import('../../server/gateway/writer/L2RecordsWriter')
    const writer = new L2RecordsWriter(account, optimismSepolia, 'http://localhost:8545', CONTRACT_ADDRESS)

    const hashBytes = '0xe301017012201234' as Hex
    const txHash = await writer.setContenthash(TEST_NODE, hashBytes)

    expect(txHash).toBe(MOCK_TX_HASH)
    expect(mockWriteContract).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: 'setContenthash',
        args: [TEST_NODE, hashBytes],
      })
    )
  })

  it('propagates writeContract errors', async () => {
    mockWriteContract.mockRejectedValue(new Error('insufficient funds'))
    const { L2RecordsWriter } = await import('../../server/gateway/writer/L2RecordsWriter')
    const writer = new L2RecordsWriter(account, optimismSepolia, 'http://localhost:8545', CONTRACT_ADDRESS)

    await expect(writer.setAddr(TEST_NODE, 60n, TEST_ADDR)).rejects.toThrow('insufficient funds')
  })
})
