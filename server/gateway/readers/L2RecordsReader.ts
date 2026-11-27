import type { Account, Chain, PublicClient, Transport } from 'viem'
import { L2RecordsV2ABI } from '../abi'

// Default PublicClient fixes chain to `Chain | undefined`. A client bound to a
// concrete chain (optimismSepolia adds deposit txs on getBlock) is a different
// type, not a subtype, so the chain has to stay a parameter.
export class L2RecordsReader<
  transport extends Transport = Transport,
  chain extends Chain | undefined = Chain | undefined,
  account extends Account | undefined = undefined,
> {
  private client: PublicClient<transport, chain, account>
  private contractAddress: `0x${string}`

  constructor(client: PublicClient<transport, chain, account>, contractAddress: `0x${string}`) {
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

