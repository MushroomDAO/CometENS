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

const L2_RECORDS_V2_ABI = [
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
  {
    type: 'function',
    name: 'addRegistrar',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'parentNode', type: 'bytes32' },
      { name: 'registrar', type: 'address' },
      { name: 'quota', type: 'uint256' },
      { name: 'expiry', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'removeRegistrar',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'parentNode', type: 'bytes32' },
      { name: 'registrar', type: 'address' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'isRegistrar',
    stateMutability: 'view',
    inputs: [
      { name: 'parentNode', type: 'bytes32' },
      { name: 'addr', type: 'address' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'owner',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
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
      abi: L2_RECORDS_V2_ABI,
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
      abi: L2_RECORDS_V2_ABI,
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
      abi: L2_RECORDS_V2_ABI,
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
      abi: L2_RECORDS_V2_ABI,
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
      abi: L2_RECORDS_V2_ABI,
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
      abi: L2_RECORDS_V2_ABI,
      functionName: 'removeRegistrar',
      args: [parentNode, registrar],
      account: this.account,
      chain: this.wallet.chain!,
    })
    await this.publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 })
    return hash
  }

  async isRegistrar(parentNode: Hex, addr: `0x${string}`): Promise<boolean> {
    return await this.publicClient.readContract({
      address: this.contractAddress,
      abi: L2_RECORDS_V2_ABI,
      functionName: 'isRegistrar',
      args: [parentNode, addr],
    }) as boolean
  }

  async owner(): Promise<`0x${string}`> {
    return await this.publicClient.readContract({
      address: this.contractAddress,
      abi: L2_RECORDS_V2_ABI,
      functionName: 'owner',
    }) as `0x${string}`
  }
}
