import { createPublicClient, createWalletClient, custom, http, isHex, namehash, type Address } from 'viem'
import { mainnet, optimismSepolia, sepolia } from 'viem/chains'
import { config, isTestnet, l1RpcUrl } from './config'

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

const l2Client = createPublicClient({
  chain: optimismSepolia,
  transport: http(config.l2RpcUrl),
})

const l1SepoliaClient = createPublicClient({
  chain: sepolia,
  transport: http(config.l1SepoliaRpcUrl),
})

const l1MainnetClient = createPublicClient({
  chain: mainnet,
  transport: http(config.l1MainnetRpcUrl),
})

const CONTRACT = config.l2RecordsAddress
const VERIFYING = (import.meta.env?.VITE_EIP712_VERIFYING_CONTRACT || CONTRACT) as `0x${string}`

// Show root domain context in the page title area
const rootDomainEl = document.getElementById('rootDomain')
if (rootDomainEl && config.rootDomain) {
  rootDomainEl.textContent = config.rootDomain
}

function byId<T extends HTMLElement = HTMLElement>(id: string) {
  return document.getElementById(id) as T | null
}

function toNode(value: string): `0x${string}` {
  const v = value.trim()
  if (isHex(v) && v.length === 66) return v as `0x${string}`
  return namehash(v)
}

function setResult(text: string) {
  const resultEl = byId<HTMLDivElement>('result')
  if (!resultEl) return
  resultEl.textContent = text
}

function getQuerySource(): 'l1' | 'l2' {
  const el = byId<HTMLSelectElement>('querySource')
  return el?.value === 'l1' ? 'l1' : 'l2'
}

function getL1Client() {
  const chainEl = byId<HTMLSelectElement>('l1Chain')
  return chainEl?.value === 'mainnet' ? l1MainnetClient : l1SepoliaClient
}

const PUBLIC_RESOLVER_ABI = [
  {
    type: 'function',
    name: 'contenthash',
    stateMutability: 'view',
    inputs: [{ name: 'node', type: 'bytes32' }],
    outputs: [{ name: '', type: 'bytes' }],
  },
] as const

async function queryAddr() {
  const nodeInput = byId<HTMLInputElement>('nodeHex')
  if (!nodeInput) return
  try {
    const source = getQuerySource()
    if (source === 'l1') {
      const name = nodeInput.value.trim()
      if (!name) throw new Error('请输入 ENS name，例如 vitalik.eth 或 ses.fkey.id')
      const l1 = getL1Client()
      const value = await l1.getEnsAddress({ name })
      setResult(`L1 addr: ${value ?? '(null)'}`)
      return
    }

    if (CONTRACT === '0x0000000000000000000000000000000000000000') {
      throw new Error('未配置 L2Records 地址：请设置 OP_L2_RECORDS_ADDRESS 或 VITE_L2_RECORDS_ADDRESS')
    }
    const node = toNode(nodeInput.value)
    const value = await l2Client.readContract({
      address: CONTRACT,
      abi: L2_RECORDS_ABI,
      functionName: 'addr',
      args: [node],
    })
    setResult(`L2 addr: ${value}`)
  } catch (e) {
    setResult(`error: ${(e as Error)?.message ?? String(e)}`)
  }
}

async function queryText() {
  const nodeInput = byId<HTMLInputElement>('nodeHex')
  if (!nodeInput) return
  try {
    const source = getQuerySource()
    if (source === 'l1') {
      const name = nodeInput.value.trim()
      if (!name) throw new Error('请输入 ENS name，例如 vitalik.eth 或 ses.fkey.id')
      const l1 = getL1Client()
      const value = await l1.getEnsText({ name, key: 'com.twitter' })
      setResult(`L1 text(com.twitter): ${value ?? '(null)'}`)
      return
    }

    if (CONTRACT === '0x0000000000000000000000000000000000000000') {
      throw new Error('未配置 L2Records 地址：请设置 OP_L2_RECORDS_ADDRESS 或 VITE_L2_RECORDS_ADDRESS')
    }
    const node = toNode(nodeInput.value)
    const value = await l2Client.readContract({
      address: CONTRACT,
      abi: L2_RECORDS_ABI,
      functionName: 'text',
      args: [node, 'com.twitter'],
    })
    setResult(`L2 text(com.twitter): ${value}`)
  } catch (e) {
    setResult(`error: ${(e as Error)?.message ?? String(e)}`)
  }
}

async function queryCh() {
  const nodeInput = byId<HTMLInputElement>('nodeHex')
  if (!nodeInput) return
  try {
    const source = getQuerySource()
    if (source === 'l1') {
      const name = nodeInput.value.trim()
      if (!name) throw new Error('请输入 ENS name，例如 vitalik.eth 或 ses.fkey.id')
      const l1 = getL1Client()
      const resolver = await l1.getEnsResolver({ name })
      if (!resolver) {
        setResult('L1 contenthash: (no resolver)')
        return
      }
      const node = namehash(name)
      const value = await l1.readContract({
        address: resolver,
        abi: PUBLIC_RESOLVER_ABI,
        functionName: 'contenthash',
        args: [node],
      })
      setResult(`L1 contenthash: ${value}`)
      return
    }

    if (CONTRACT === '0x0000000000000000000000000000000000000000') {
      throw new Error('未配置 L2Records 地址：请设置 OP_L2_RECORDS_ADDRESS 或 VITE_L2_RECORDS_ADDRESS')
    }
    const node = toNode(nodeInput.value)
    const value = await l2Client.readContract({
      address: CONTRACT,
      abi: L2_RECORDS_ABI,
      functionName: 'contenthash',
      args: [node],
    })
    setResult(`L2 contenthash: ${value}`)
  } catch (e) {
    setResult(`error: ${(e as Error)?.message ?? String(e)}`)
  }
}

const qa = byId<HTMLButtonElement>('queryAddrBtn')
const qt = byId<HTMLButtonElement>('queryTextBtn')
const qc = byId<HTMLButtonElement>('queryChBtn')
qa?.addEventListener('click', queryAddr)
qt?.addEventListener('click', queryText)
qc?.addEventListener('click', queryCh)

// EIP-712 SetAddr typed data
const SetAddrTypes = {
  SetAddr: [
    { name: 'node', type: 'bytes32' },
    { name: 'coinType', type: 'uint256' },
    { name: 'addr', type: 'bytes' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const

function getEthereum(): any {
  const eth = (window as any).ethereum
  if (!eth) throw new Error('未检测到 MetaMask')
  return eth
}

async function signSetAddr() {
  const nodeEl = byId<HTMLInputElement>('sigNodeHex')
  const coinEl = byId<HTMLInputElement>('sigCoinType')
  const addrEl = byId<HTMLInputElement>('sigAddr')
  const deadlineEl = byId<HTMLInputElement>('sigDeadline')
  const outEl = byId<HTMLPreElement>('sigOutput')
  if (!nodeEl || !coinEl || !addrEl || !outEl) return

  const node = toNode(nodeEl.value)
  const coinType = BigInt(coinEl.value.trim() || '60')
  const addr = addrEl.value.trim() as `0x${string}`
  const now = Math.floor(Date.now() / 1000)
  const deadline = BigInt(deadlineEl?.value?.trim() || String(now + 600))

  const wallet = createWalletClient({
    chain: optimismSepolia,
    transport: custom(getEthereum()),
  })
  const [account] = await wallet.getAddresses()
  const nonce = BigInt(now) // 简化：以时间戳作为一次性 nonce，占位实现

  const domain = {
    name: 'CometENS',
    version: '1',
    chainId: optimismSepolia.id,
    verifyingContract: VERIFYING,
  } as const

  const message = { node, coinType, addr, nonce, deadline } as const

  const signature = await wallet.signTypedData({
    account,
    domain,
    primaryType: 'SetAddr',
    types: SetAddrTypes as any,
    message: message as any,
  })

  const payload = {
    domain,
    types: SetAddrTypes,
    primaryType: 'SetAddr',
    message,
    signature,
    from: account,
  }
  outEl.textContent = JSON.stringify(payload, null, 2)
}

const ss = byId<HTMLButtonElement>('signSetAddrBtn')
ss?.addEventListener('click', signSetAddr)
