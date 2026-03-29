/**
 * CometENS SDK — core implementation.
 *
 * Reads records directly from L2Records (no gateway needed for reads).
 * Writes go through the gateway's /api/manage endpoints (EIP-712 authorised).
 *
 * Usage:
 *   const sdk = new CometENS({
 *     rootDomain: 'aastar.eth',
 *     l1ResolverAddress: '0x87d97a2e...',
 *     l2RecordsAddress:  '0x9Ed5d101...',
 *     l1RpcUrl: 'https://eth-sepolia.g.alchemy.com/v2/...',
 *     l2RpcUrl: 'https://opt-sepolia.g.alchemy.com/v2/...',
 *     gatewayUrl: 'https://ens.aastar.io/api/ccip',  // or /api/ccip for local
 *   })
 *
 *   const addr = await sdk.getAddr('alice.aastar.eth')
 *   await sdk.register({ label: 'alice', owner: '0x...', signature: '0x...', deadline: ... })
 */

import {
  createPublicClient,
  http,
  namehash,
  encodeAbiParameters,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'
import { optimismSepolia, sepolia, optimism, mainnet } from 'viem/chains'
import type {
  CometENSOptions,
  ICometENS,
  ResolvedName,
  RegisterRequest,
  RegisterResult,
  SetAddrRequest,
  SetTextRequest,
} from './types'

// ─── ABIs ─────────────────────────────────────────────────────────────────────

const L2_ABI = [
  { type: 'function', name: 'addr', stateMutability: 'view',
    inputs: [{ name: 'node', type: 'bytes32' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'addr', stateMutability: 'view',
    inputs: [{ name: 'node', type: 'bytes32' }, { name: 'coinType', type: 'uint256' }],
    outputs: [{ type: 'bytes' }] },
  { type: 'function', name: 'text', stateMutability: 'view',
    inputs: [{ name: 'node', type: 'bytes32' }, { name: 'key', type: 'string' }],
    outputs: [{ type: 'string' }] },
  { type: 'function', name: 'contenthash', stateMutability: 'view',
    inputs: [{ name: 'node', type: 'bytes32' }], outputs: [{ type: 'bytes' }] },
] as const

// ─── Chain resolution ──────────────────────────────────────────────────────────

function getChains(l1RpcUrl: string, l2RpcUrl: string) {
  // Detect testnet vs mainnet by checking if the RPC URL mentions "sepolia"
  const isTestnet = l1RpcUrl.includes('sepolia') || l2RpcUrl.includes('sepolia')
  return {
    l1: isTestnet ? sepolia : mainnet,
    l2: isTestnet ? optimismSepolia : optimism,
  }
}

// ─── CometENS class ────────────────────────────────────────────────────────────

export class CometENS implements ICometENS {
  readonly options: CometENSOptions
  private l2Client: PublicClient

  constructor(options: CometENSOptions) {
    this.options = options
    const { l2 } = getChains(options.l1RpcUrl, options.l2RpcUrl)
    this.l2Client = createPublicClient({ chain: l2, transport: http(options.l2RpcUrl) })
  }

  // ── Resolution ───────────────────────────────────────────────────────────────

  async getAddr(name: string): Promise<Address | null> {
    const node = namehash(name) as Hex
    const addr = await this.l2Client.readContract({
      address: this.options.l2RecordsAddress,
      abi: L2_ABI,
      functionName: 'addr',
      args: [node],
    }) as Address
    return addr === '0x0000000000000000000000000000000000000000' ? null : addr
  }

  async getAddrByCoinType(name: string, coinType: bigint): Promise<Hex | null> {
    const node = namehash(name) as Hex
    const bytes = await this.l2Client.readContract({
      address: this.options.l2RecordsAddress,
      abi: L2_ABI,
      functionName: 'addr',
      args: [node, coinType],
    }) as Hex
    return bytes === '0x' || bytes === '0x0000000000000000000000000000000000000000' ? null : bytes
  }

  async getText(name: string, key: string): Promise<string | null> {
    const node = namehash(name) as Hex
    const value = await this.l2Client.readContract({
      address: this.options.l2RecordsAddress,
      abi: L2_ABI,
      functionName: 'text',
      args: [node, key],
    }) as string
    return value || null
  }

  async resolve(name: string): Promise<ResolvedName> {
    const [addr, contenthashRaw] = await Promise.all([
      this.getAddr(name),
      this._getContenthash(name),
    ])
    return { addr, texts: {}, contenthash: contenthashRaw }
  }

  private async _getContenthash(name: string): Promise<Hex | null> {
    const node = namehash(name) as Hex
    const bytes = await this.l2Client.readContract({
      address: this.options.l2RecordsAddress,
      abi: L2_ABI,
      functionName: 'contenthash',
      args: [node],
    }) as Hex
    return bytes === '0x' ? null : bytes
  }

  // ── Registration ─────────────────────────────────────────────────────────────

  async register(req: RegisterRequest): Promise<RegisterResult> {
    const name = `${req.label}.${this.options.rootDomain}`
    const gwBase = this.options.gatewayUrl?.replace('/api/ccip', '') || ''
    const resp = await fetch(`${gwBase}/api/manage/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from: req.owner,
        signature: req.signature,
        message: {
          parent: this.options.rootDomain,
          label: req.label,
          owner: req.owner,
          nonce: Date.now(),
          deadline: req.deadline,
        },
      }),
    })
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: resp.statusText }))
      throw new Error((err as any).error ?? 'Register failed')
    }
    const { txHash } = await resp.json() as { txHash: Hex }
    return { name, txHash }
  }

  // ── Record updates ────────────────────────────────────────────────────────────

  async setAddr(req: SetAddrRequest): Promise<{ txHash: Hex }> {
    const node = namehash(req.name) as Hex
    const coinType = req.coinType ?? 60n
    const addrBytes = encodeAbiParameters([{ type: 'address' }], [req.addr]) as Hex
    const gwBase = this.options.gatewayUrl?.replace('/api/ccip', '') || ''
    const resp = await fetch(`${gwBase}/api/manage/set-addr`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from: req.addr,
        signature: req.signature,
        message: { node, coinType: coinType.toString(), addr: req.addr, nonce: Date.now(), deadline: req.deadline },
      }),
    })
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: resp.statusText }))
      throw new Error((err as any).error ?? 'SetAddr failed')
    }
    return resp.json() as Promise<{ txHash: Hex }>
  }

  async setText(req: SetTextRequest): Promise<{ txHash: Hex }> {
    // Text record updates go through a future /api/manage/set-text endpoint
    throw new Error('setText via gateway not yet implemented — use admin direct write')
  }
}
