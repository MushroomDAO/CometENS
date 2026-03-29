import {
  createPublicClient,
  http,
  decodeFunctionData,
  encodeFunctionResult,
  encodeAbiParameters,
  keccak256,
  encodePacked,
  type Hex,
} from 'viem'
import { optimismSepolia } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { L2RecordsReader } from './readers/L2RecordsReader'

// ─── ABI constants ────────────────────────────────────────────────────────────

const RESOLVE_ABI = [
  {
    type: 'function',
    name: 'addr',
    stateMutability: 'view',
    inputs: [{ name: 'node', type: 'bytes32' }],
    outputs: [{ name: '', type: 'address' }],
  },
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
  {
    type: 'function',
    name: 'contenthash',
    stateMutability: 'view',
    inputs: [{ name: 'node', type: 'bytes32' }],
    outputs: [{ name: '', type: 'bytes' }],
  },
] as const

// ─── Client & reader setup ────────────────────────────────────────────────────

const rpcUrl =
  process.env.OP_SEPOLIA_RPC_URL ||
  process.env.L2_RPC_URL ||
  process.env.VITE_L2_RPC_URL ||
  ''

const client = createPublicClient({
  chain: optimismSepolia,
  transport: http(rpcUrl),
})

const l2RecordsAddress = (
  process.env.L2_RECORDS_ADDRESS ||
  process.env.VITE_L2_RECORDS_ADDRESS ||
  '0x0000000000000000000000000000000000000000'
) as `0x${string}`

const reader = new L2RecordsReader(client, l2RecordsAddress)

const signer = (() => {
  const pk = process.env.PRIVATE_KEY_SUPPLIER as Hex | undefined
  if (!pk) return null
  return privateKeyToAccount(pk)
})()

// ─── Handlers ─────────────────────────────────────────────────────────────────

export async function handleResolve(calldata: Hex): Promise<Hex> {
  const { functionName, args } = decodeFunctionData({ abi: RESOLVE_ABI, data: calldata })

  if (functionName === 'addr') {
    const [node] = args as [Hex]
    const value = await reader.getAddr(node)
    return encodeFunctionResult({ abi: RESOLVE_ABI, functionName: 'addr', result: value })
  }

  if (functionName === 'text') {
    const [node, key] = args as [Hex, string]
    const value = await reader.getText(node, key)
    return encodeFunctionResult({ abi: RESOLVE_ABI, functionName: 'text', result: value })
  }

  if (functionName === 'contenthash') {
    const [node] = args as [Hex]
    const value = await reader.getContenthash(node)
    return encodeFunctionResult({ abi: RESOLVE_ABI, functionName: 'contenthash', result: value })
  }

  throw new Error('Unsupported selector')
}

/**
 * Handles a CCIP-Read gateway request following EIP-3668.
 *
 * Returns `{ data }` where `data` is ABI-encoded `(bytes result, uint64 expires, bytes sig)`.
 * The signature commits to: hex"1900" ++ resolverAddress ++ expires ++ keccak256(calldata) ++ keccak256(result)
 *
 * @param calldata  Original calldata from OffchainLookup (e.g. addr(node) encoded)
 * @param resolverAddress  The L1 OffchainResolver address (= `sender` in the OffchainLookup error)
 */
export async function handleResolveSigned(
  calldata: Hex,
  resolverAddress: Hex = '0x0000000000000000000000000000000000000000',
): Promise<{ data: Hex }> {
  const result = await handleResolve(calldata)

  const expires = BigInt(Math.floor(Date.now() / 1000) + 3600) as unknown as bigint

  if (!signer) {
    // No signer configured: return unsigned response (resolver will reject, but useful in dev)
    const data = encodeAbiParameters(
      [{ type: 'bytes' }, { type: 'uint64' }, { type: 'bytes' }],
      [result, expires, '0x'],
    )
    return { data }
  }

  // EIP-3668: sign keccak256(hex"1900" ++ resolver ++ expires ++ keccak256(calldata) ++ keccak256(result))
  const messageHash = keccak256(
    encodePacked(
      ['bytes2', 'address', 'uint64', 'bytes32', 'bytes32'],
      ['0x1900', resolverAddress, expires, keccak256(calldata), keccak256(result)],
    ),
  )
  const sig = await signer.signMessage({ message: { raw: messageHash } })

  const data = encodeAbiParameters(
    [{ type: 'bytes' }, { type: 'uint64' }, { type: 'bytes' }],
    [result, expires, sig],
  )

  return { data }
}
