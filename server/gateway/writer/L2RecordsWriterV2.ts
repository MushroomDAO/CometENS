import {
  createWalletClient,
  createPublicClient,
  http,
  type WalletClient,
  type PublicClient,
  type Chain,
  type Hex,
  type Address,
  type Account,
} from 'viem'
import { L2RecordsV2ABI } from '../abi'

// Minimal inline ABI for L2RecordsV3.transferSubnodeByGateway.
// The gateway-callable function requires msg.sender == contract owner (Worker EOA),
// bypassing the ERC-721 approval check after the gateway has verified the EIP-712 signature.
// Using standard ERC-721 transferFrom would fail because the Worker EOA is not the NFT owner.
const TRANSFER_SUBNODE_ABI = [
  {
    type: 'function',
    name: 'transferSubnodeByGateway',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'node', type: 'bytes32' },
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
    ],
    outputs: [],
  },
] as const

export class L2RecordsWriterV2 {
  private wallet: WalletClient
  private publicClient: PublicClient
  private contractAddress: Hex
  private account: Account

  constructor(
    account: Account,
    chain: Chain,
    rpcUrl: string,
    contractAddress: Hex,
  ) {
    this.account = account
    this.contractAddress = contractAddress
    const transport = http(rpcUrl, { timeout: 60_000, retryCount: 3, retryDelay: 1_000 })
    this.wallet = createWalletClient({ account, chain, transport })
    this.publicClient = createPublicClient({ chain, transport })
  }

  async registerSubnode(parentNode: Hex, labelhash: Hex, newOwner: `0x${string}`, label: string, addrBytes: Hex): Promise<Hex> {
    const hash = await this.wallet.writeContract({
      address: this.contractAddress,
      abi: L2RecordsV2ABI,
      functionName: 'registerSubnode',
      args: [parentNode, labelhash, newOwner, label, addrBytes],
      account: this.account,
      chain: this.wallet.chain!,
    })
    await this.publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 })
    return hash
  }

  async setAddr(node: Hex, coinType: bigint, addrBytes: Hex): Promise<Hex> {
    const hash = await this.wallet.writeContract({
      address: this.contractAddress,
      abi: L2RecordsV2ABI,
      functionName: 'setAddr',
      args: [node, coinType, addrBytes],
      account: this.account,
      chain: this.wallet.chain!,
    })
    await this.publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 })
    return hash
  }

  async setText(node: Hex, key: string, value: string): Promise<Hex> {
    const hash = await this.wallet.writeContract({
      address: this.contractAddress,
      abi: L2RecordsV2ABI,
      functionName: 'setText',
      args: [node, key, value],
      account: this.account,
      chain: this.wallet.chain!,
    })
    await this.publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 })
    return hash
  }

  async setContenthash(node: Hex, hash: Hex): Promise<Hex> {
    const txHash = await this.wallet.writeContract({
      address: this.contractAddress,
      abi: L2RecordsV2ABI,
      functionName: 'setContenthash',
      args: [node, hash],
      account: this.account,
      chain: this.wallet.chain!,
    })
    await this.publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 })
    return txHash
  }

  // V2: Registrar management
  async addRegistrar(parentNode: Hex, registrar: `0x${string}`, quota: bigint, expiry: bigint): Promise<Hex> {
    const hash = await this.wallet.writeContract({
      address: this.contractAddress,
      abi: L2RecordsV2ABI,
      functionName: 'addRegistrar',
      args: [parentNode, registrar, quota, expiry],
      account: this.account,
      chain: this.wallet.chain!,
    })
    await this.publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 })
    return hash
  }

  async removeRegistrar(parentNode: Hex, registrar: `0x${string}`): Promise<Hex> {
    const hash = await this.wallet.writeContract({
      address: this.contractAddress,
      abi: L2RecordsV2ABI,
      functionName: 'removeRegistrar',
      args: [parentNode, registrar],
      account: this.account,
      chain: this.wallet.chain!,
    })
    await this.publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 })
    return hash
  }

  async transferSubnode(node: Hex, from: Address, to: Address): Promise<Hex> {
    const { request } = await this.publicClient.simulateContract({
      address: this.contractAddress,
      abi: TRANSFER_SUBNODE_ABI,
      functionName: 'transferSubnodeByGateway',
      args: [node, from, to],
      account: this.account,
    })
    const hash = await this.wallet.writeContract(request)
    await this.publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 })
    return hash
  }

  async isRegistrar(parentNode: Hex, addr: `0x${string}`): Promise<boolean> {
    return await this.publicClient.readContract({
      address: this.contractAddress,
      abi: L2RecordsV2ABI,
      functionName: 'isRegistrar',
      args: [parentNode, addr],
    }) as boolean
  }

  async owner(): Promise<`0x${string}`> {
    return await this.publicClient.readContract({
      address: this.contractAddress,
      abi: L2RecordsV2ABI,
      functionName: 'owner',
    }) as `0x${string}`
  }
}
