import type { PublicClient } from 'viem'
import { L2RecordsV2ABI } from '../abi'

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
      abi: L2RecordsV2ABI,
      functionName: 'addr',
      args: [node],
    }) as Promise<`0x${string}`>
  }

  async getAddrByCoinType(node: `0x${string}`, coinType: bigint): Promise<`0x${string}`> {
    return this.client.readContract({
      address: this.contractAddress,
      abi: L2RecordsV2ABI,
      functionName: 'addr',
      args: [node, coinType],
    }) as Promise<`0x${string}`>
  }

  async getText(node: `0x${string}`, key: string): Promise<string> {
    return this.client.readContract({
      address: this.contractAddress,
      abi: L2RecordsV2ABI,
      functionName: 'text',
      args: [node, key],
    }) as Promise<string>
  }

  async getContenthash(node: `0x${string}`): Promise<`0x${string}`> {
    return this.client.readContract({
      address: this.contractAddress,
      abi: L2RecordsV2ABI,
      functionName: 'contenthash',
      args: [node],
    }) as Promise<`0x${string}`>
  }
}

