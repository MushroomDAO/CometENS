import {
  createWalletClient,
  createPublicClient,
  http,
  type WalletClient,
  type PublicClient,
  type Chain,
  type Hex,
  type Account,
} from 'viem'

const L2_RECORDS_WRITE_ABI = [
  {
    type: 'function',
    name: 'registerSubnode',
    stateMutability: 'nonpayable',
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
    type: 'function',
    name: 'setAddr',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'node', type: 'bytes32' },
      { name: 'coinType', type: 'uint256' },
      { name: 'addrBytes', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setText',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'node', type: 'bytes32' },
      { name: 'key', type: 'string' },
      { name: 'value', type: 'string' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setContenthash',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'node', type: 'bytes32' },
      { name: 'hash', type: 'bytes' },
    ],
    outputs: [],
  },
] as const

export class L2RecordsWriter {
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
    this.wallet = createWalletClient({ account, chain, transport: http(rpcUrl) })
    this.publicClient = createPublicClient({ chain, transport: http(rpcUrl) })
  }

  async registerSubnode(parentNode: Hex, labelhash: Hex, newOwner: `0x${string}`, label: string, addrBytes: Hex): Promise<Hex> {
    const hash = await this.wallet.writeContract({
      address: this.contractAddress,
      abi: L2_RECORDS_WRITE_ABI,
      functionName: 'registerSubnode',
      args: [parentNode, labelhash, newOwner, label, addrBytes],
      account: this.account,
      chain: this.wallet.chain!,
    })
    await this.publicClient.waitForTransactionReceipt({ hash })
    return hash
  }

  async setAddr(node: Hex, coinType: bigint, addrBytes: Hex): Promise<Hex> {
    const hash = await this.wallet.writeContract({
      address: this.contractAddress,
      abi: L2_RECORDS_WRITE_ABI,
      functionName: 'setAddr',
      args: [node, coinType, addrBytes],
      account: this.account,
      chain: this.wallet.chain!,
    })
    await this.publicClient.waitForTransactionReceipt({ hash })
    return hash
  }

  async setText(node: Hex, key: string, value: string): Promise<Hex> {
    const hash = await this.wallet.writeContract({
      address: this.contractAddress,
      abi: L2_RECORDS_WRITE_ABI,
      functionName: 'setText',
      args: [node, key, value],
      account: this.account,
      chain: this.wallet.chain!,
    })
    await this.publicClient.waitForTransactionReceipt({ hash })
    return hash
  }

  async setContenthash(node: Hex, hash: Hex): Promise<Hex> {
    const txHash = await this.wallet.writeContract({
      address: this.contractAddress,
      abi: L2_RECORDS_WRITE_ABI,
      functionName: 'setContenthash',
      args: [node, hash],
      account: this.account,
      chain: this.wallet.chain!,
    })
    await this.publicClient.waitForTransactionReceipt({ hash: txHash })
    return txHash
  }
}
