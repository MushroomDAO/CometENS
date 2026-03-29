import type { PublicClient } from 'viem'

const L2_RECORDS_ABI = [
  {
    type: 'function',
    name: 'addr',
    stateMutability: 'view',
    inputs: [{ name: 'node', type: 'bytes32' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'addr',
    stateMutability: 'view',
    inputs: [{ name: 'node', type: 'bytes32' }, { name: 'coinType', type: 'uint256' }],
    outputs: [{ name: '', type: 'bytes' }],
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

export class L2RecordsReader {
  private client: PublicClient
  private contractAddress: `0x${string}`

  constructor(client: PublicClient, contractAddress: `0x${string}`) {
    this.client = client
    this.contractAddress = contractAddress
  }

  async getAddr(node: `0x${string}`): Promise<`0x${string}`> {
    return this.client.readContract({
      address: this.contractAddress,
      abi: L2_RECORDS_ABI,
      functionName: 'addr',
      args: [node],
    }) as Promise<`0x${string}`>
  }

  async getAddrByCoinType(node: `0x${string}`, coinType: bigint): Promise<`0x${string}`> {
    return this.client.readContract({
      address: this.contractAddress,
      abi: L2_RECORDS_ABI,
      functionName: 'addr',
      args: [node, coinType],
    }) as Promise<`0x${string}`>
  }

  async getText(node: `0x${string}`, key: string): Promise<string> {
    return this.client.readContract({
      address: this.contractAddress,
      abi: L2_RECORDS_ABI,
      functionName: 'text',
      args: [node, key],
    }) as Promise<string>
  }

  async getContenthash(node: `0x${string}`): Promise<`0x${string}`> {
    return this.client.readContract({
      address: this.contractAddress,
      abi: L2_RECORDS_ABI,
      functionName: 'contenthash',
      args: [node],
    }) as Promise<`0x${string}`>
  }
}

