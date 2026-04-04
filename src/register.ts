import { createWalletClient, createPublicClient, http, custom } from 'viem'
import { optimismSepolia, optimism } from 'viem/chains'
import { namehash } from 'viem/ens'
import { config } from './config'
import { RegisterTypes, buildDomain } from '../server/gateway/manage/schemas'

// Minimal ABI for L2Records reads
const L2_READ_ABI = [
  {
    type: 'function', name: 'addr',
    stateMutability: 'view',
    inputs: [{ name: 'node', type: 'bytes32' }],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function', name: 'subnodeOwner',
    stateMutability: 'view',
    inputs: [{ name: 'node', type: 'bytes32' }],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function', name: 'primaryNode',
    stateMutability: 'view',
    inputs: [{ name: 'addr_', type: 'address' }],
    outputs: [{ type: 'bytes32' }],
  },
  {
    type: 'function', name: 'labelOf',
    stateMutability: 'view',
    inputs: [{ name: 'node', type: 'bytes32' }],
    outputs: [{ type: 'string' }],
  },
] as const

function getL2Client() {
  const chain = config.network === 'op-mainnet' ? optimism : optimismSepolia
  return createPublicClient({ chain, transport: http(config.l2RpcUrl) })
}

// ─── DOM helpers ──────────────────────────────────────────────────────────────

function byId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null
}

function setResult(msg: string, type: 'success' | 'error') {
  const el = byId('result')
  if (!el) return
  el.textContent = msg
  el.className = `result ${type}`
}

function clearResult() {
  const el = byId('result')
  if (!el) return
  el.className = 'result hidden'
  el.textContent = ''
}

// ─── Wallet state ─────────────────────────────────────────────────────────────

let connectedAddress: `0x${string}` | null = null

function getEthereum(): any {
  const eth = (window as any).ethereum
  if (!eth) throw new Error('MetaMask not detected. Please install MetaMask.')
  return eth
}

function getChain() {
  return config.network === 'op-mainnet' ? optimism : optimismSepolia
}

// ─── Chain display ────────────────────────────────────────────────────────────

const CHAIN_NAMES: Record<number, string> = {
  1: 'Ethereum Mainnet',
  10: 'Optimism',
  11155111: 'Ethereum Sepolia',
  11155420: 'OP Sepolia',
  31337: 'Anvil (local)',
}

function updateChainDisplay(chainId: number) {
  const required = getChain()
  const isOk = chainId === required.id
  const nameEl = byId('chainName')
  const idEl = byId('chainId')
  const switchBtn = byId<HTMLButtonElement>('switchChainBtn')

  if (nameEl) {
    nameEl.textContent = CHAIN_NAMES[chainId] ?? `Unknown chain`
    nameEl.className = `chain-name ${isOk ? 'ok' : 'wrong'}`
  }
  if (idEl) idEl.textContent = `(chainId: ${chainId})`
  if (switchBtn) switchBtn.classList.toggle('hidden', isOk)
}

async function readChainId(): Promise<number> {
  const eth = getEthereum()
  const hex: string = await eth.request({ method: 'eth_chainId' })
  return parseInt(hex, 16)
}

async function switchToRequiredChain(): Promise<void> {
  const eth = getEthereum()
  const required = getChain()
  const hexId = `0x${required.id.toString(16)}`
  try {
    await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexId }] })
  } catch (err: any) {
    // 4902 = chain not added yet — add it
    if (err.code === 4902) {
      const params: any = {
        chainId: hexId,
        chainName: required.name,
        nativeCurrency: required.nativeCurrency,
        rpcUrls: required.rpcUrls.default.http,
      }
      if (required.blockExplorers?.default.url) {
        params.blockExplorerUrls = [required.blockExplorers.default.url]
      }
      await eth.request({
        method: 'wallet_addEthereumChain',
        params: [params],
      })
    } else {
      throw err
    }
  }
}

async function connectWallet(): Promise<`0x${string}`> {
  const ethereum = getEthereum()

  // Ensure correct chain before creating wallet client
  const currentChainId = await readChainId()
  const required = getChain()
  if (currentChainId !== required.id) {
    await switchToRequiredChain()
  }

  const wallet = createWalletClient({
    chain: getChain(),
    transport: custom(ethereum),
  })
  const [address] = await wallet.requestAddresses()
  return address
}

// ─── Existing registration banner ────────────────────────────────────────────

// Cache key includes contract address suffix so it auto-invalidates when contract changes
const STORAGE_KEY = `cometens_reg_${config.l2RecordsAddress.toLowerCase().slice(-8)}`

interface RegistrationRecord {
  address: string
  label: string
  fullName: string
}

function saveRegistration(address: string, label: string, fullName: string) {
  const records: RegistrationRecord[] = getRegistrations()
  const idx = records.findIndex(r => r.address.toLowerCase() === address.toLowerCase())
  const rec = { address: address.toLowerCase(), label, fullName }
  if (idx >= 0) records[idx] = rec
  else records.push(rec)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(records))
}

function getRegistrations(): RegistrationRecord[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
  } catch {
    return []
  }
}

function getRegistrationFor(address: string): RegistrationRecord | undefined {
  return getRegistrations().find(r => r.address.toLowerCase() === address.toLowerCase())
}

function clearRegistrationFor(address: string) {
  const records = getRegistrations().filter(r => r.address.toLowerCase() !== address.toLowerCase())
  localStorage.setItem(STORAGE_KEY, JSON.stringify(records))
}

async function checkExistingRegistration(address: string) {
  const ZERO_NODE = '0x0000000000000000000000000000000000000000000000000000000000000000'

  // Primary: query L2Records on-chain — authoritative, always current
  let onChainReachable = false
  try {
    const client = getL2Client()
    const node = await client.readContract({
      address: config.l2RecordsAddress,
      abi: L2_READ_ABI,
      functionName: 'primaryNode',
      args: [address as `0x${string}`],
    })
    onChainReachable = true

    if (!node || node === ZERO_NODE) {
      // Definitively not registered — clear any stale cache and stop
      clearRegistrationFor(address)
      return
    }

    const label = await client.readContract({
      address: config.l2RecordsAddress,
      abi: L2_READ_ABI,
      functionName: 'labelOf',
      args: [node],
    })
    if (label) {
      const fullName = `${label}.${config.rootDomain}`
      saveRegistration(address, label, fullName)
      showExistingBanner({ address, label, fullName })
    } else {
      clearRegistrationFor(address)
    }
    return
  } catch {
    // Chain unreachable — fall through to server/cache
  }

  // On-chain was reachable but returned nothing — don't show stale cache
  if (onChainReachable) return

  // Fallback: server cache (for dev server mode, only if L2 RPC is down)
  try {
    const res = await fetch(`${config.apiUrl}/lookup?address=${encodeURIComponent(address)}`)
    if (res.ok) {
      const json = await res.json() as { found: boolean; label?: string; fullName?: string }
      if (json.found && json.label && json.fullName) {
        saveRegistration(address, json.label, json.fullName)
        showExistingBanner({ address, label: json.label, fullName: json.fullName })
        return
      }
    }
  } catch {
    // server unreachable — fall through to localStorage cache
  }

  // Last resort: localStorage (only shown when both L2 RPC and server are unreachable)
  const cached = getRegistrationFor(address)
  if (cached) showExistingBanner(cached)
}

function showExistingBanner(rec: RegistrationRecord) {
  let banner = byId('existingBanner')
  if (!banner) {
    banner = document.createElement('div')
    banner.id = 'existingBanner'
    banner.className = 'existing-banner'
    const card = byId('verifyCard')?.parentElement ?? document.body
    // insert before the register card
    const registerCard = byId('registerBtn')?.closest('.card')
    if (registerCard) {
      registerCard.parentElement?.insertBefore(banner, registerCard)
    } else {
      card.appendChild(banner)
    }
  }
  banner.textContent = ''
  const prefix = document.createElement('span')
  prefix.textContent = 'This wallet already has a subdomain: '
  const strong = document.createElement('strong')
  strong.textContent = rec.fullName
  const sep = document.createTextNode(' — ')
  const link = document.createElement('a')
  link.href = '#'
  link.id = 'forceRegisterLink'
  link.textContent = 'register another'
  banner.append(prefix, strong, sep, link)

  link.addEventListener('click', (e) => {
    e.preventDefault()
    banner!.remove()
  })
}

// ─── Register ─────────────────────────────────────────────────────────────────

async function register(): Promise<void> {
  clearResult()

  const labelInput = byId<HTMLInputElement>('labelInput')
  const label = labelInput?.value.trim() ?? ''
  if (!label) {
    setResult('Please enter a subdomain label.', 'error')
    return
  }
  if (!connectedAddress) {
    setResult('Please connect your wallet first.', 'error')
    return
  }

  const registerBtn = byId<HTMLButtonElement>('registerBtn')
  if (registerBtn) {
    registerBtn.disabled = true
    registerBtn.textContent = 'Checking…'
  }

  const parentEl = byId<HTMLInputElement>('parentInput')
  const parent = (parentEl?.value.trim() || config.rootDomain).toLowerCase()

  try {
    // Pre-flight: check availability before asking MetaMask to sign
    const checkRes = await fetch(
      `${config.apiUrl}/check-label?label=${encodeURIComponent(label)}&parent=${encodeURIComponent(parent)}`
    )
    if (checkRes.ok) {
      const checkJson = await checkRes.json() as { available: boolean; owner?: string }
      if (!checkJson.available) {
        throw new Error(`"${label}.${parent}" is already registered to ${checkJson.owner ?? 'another address'}.`)
      }
    }

    if (registerBtn) registerBtn.textContent = 'Signing…'

    const ethereum = getEthereum()
    const chain = getChain()
    const wallet = createWalletClient({ chain, transport: custom(ethereum) })

    const now = Math.floor(Date.now() / 1000)
    const nonce = BigInt(Date.now())
    const deadline = BigInt(now + 600)

    const domain = buildDomain(chain.id, config.l2RecordsAddress)
    const message = {
      parent,
      label,
      owner: connectedAddress,
      nonce,
      deadline,
    }

    const signature = await wallet.signTypedData({
      account: connectedAddress,
      domain,
      primaryType: 'Register',
      types: RegisterTypes as any,
      message: message as any,
    })

    if (registerBtn) registerBtn.textContent = 'Submitting…'

    const response = await fetch(`${config.apiUrl}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from: connectedAddress,
        signature,
        domain: { verifyingContract: config.l2RecordsAddress },
        message: {
          parent: message.parent,
          label: message.label,
          owner: message.owner,
          nonce: nonce.toString(),
          deadline: deadline.toString(),
        },
      }),
    })

    const json = await response.json()

    if (!response.ok) {
      throw new Error(json.error ?? `Server error ${response.status}`)
    }

    const fullName = `${label}.${parent}`
    const txInfo = json.txHash ? `\nTx: ${json.txHash}` : '\n(no tx — worker key not configured)'
    saveRegistration(connectedAddress!, label, fullName)
    setResult(`Registered: ${fullName}${txInfo}`, 'success')
    showVerifyCard(fullName, connectedAddress!)
  } catch (e) {
    setResult((e as Error)?.message ?? String(e), 'error')
  } finally {
    if (registerBtn) {
      registerBtn.disabled = !connectedAddress
      registerBtn.textContent = 'Register Subdomain'
    }
  }
}

// ─── Verify ───────────────────────────────────────────────────────────────────

function showVerifyCard(fullName: string, owner: `0x${string}`) {
  const card = byId('verifyCard')
  const nameEl = byId('verifyName')
  const linksEl = byId('verifyLinks')
  if (!card || !nameEl || !linksEl) return

  nameEl.textContent = fullName
  card.classList.remove('hidden')

  // Build external links
  const l2Contract = config.l2RecordsAddress
  const isTestnet = config.network === 'op-sepolia'

  const etherscanBase = isTestnet
    ? 'https://sepolia-optimism.etherscan.io'
    : 'https://optimistic.etherscan.io'
  const ensApp = isTestnet
    ? `https://sepolia.app.ens.domains/${fullName}`
    : `https://app.ens.domains/${fullName}`

  const txHash = (byId('result')?.textContent ?? '').match(/0x[a-f0-9]{64}/i)?.[0] ?? ''
  linksEl.textContent = ''
  const ensLink = document.createElement('a')
  ensLink.href = ensApp
  ensLink.target = '_blank'
  ensLink.style.background = '#0b79d0'
  ensLink.style.color = '#fff'
  ensLink.style.borderColor = '#0b79d0'
  ensLink.textContent = 'View on ENS App'

  const contractLink = document.createElement('a')
  contractLink.href = `${etherscanBase}/address/${l2Contract}#readContract`
  contractLink.target = '_blank'
  contractLink.textContent = 'L2Records on Etherscan'

  linksEl.append(ensLink, contractLink)
  if (txHash) {
    const txLink = document.createElement('a')
    txLink.href = `${etherscanBase}/tx/${txHash}`
    txLink.target = '_blank'
    txLink.textContent = 'View Tx'
    linksEl.append(txLink)
  }

  // Wire verify button — passes owner so we can compare
  const btn = byId<HTMLButtonElement>('verifyBtn')
  if (btn) {
    btn.onclick = () => verifyResolution(fullName, owner)
  }
}

async function verifyResolution(fullName: string, expectedOwner: `0x${string}`) {
  const resultEl = byId('verifyResult')
  const btn = byId<HTMLButtonElement>('verifyBtn')
  if (!resultEl) return

  resultEl.className = 'verify-result pending'
  resultEl.classList.remove('hidden')
  resultEl.textContent = 'Querying L2Records…'
  if (btn) btn.disabled = true

  try {
    const l2Chain = config.network === 'op-mainnet' ? optimism : optimismSepolia
    const client = createPublicClient({ chain: l2Chain, transport: http(config.l2RpcUrl) })

    const node = namehash(fullName) as `0x${string}`
    const resolved = await client.readContract({
      address: config.l2RecordsAddress,
      abi: L2_READ_ABI,
      functionName: 'addr',
      args: [node],
    })

    const match = resolved.toLowerCase() === expectedOwner.toLowerCase()
    resultEl.className = `verify-result ${match ? 'ok' : 'fail'}`
    const setContent = (parts: Array<string | HTMLElement>) => {
      resultEl.textContent = ''
      for (const part of parts) {
        if (typeof part === 'string') resultEl.append(document.createTextNode(part))
        else resultEl.append(part)
      }
    }
    if (match) {
      const strong = document.createElement('strong')
      strong.textContent = fullName
      const code = document.createElement('code')
      code.textContent = resolved
      setContent([
        '✓ Resolved successfully', document.createElement('br'),
        strong, document.createElement('br'),
        '→ ', code,
      ])
    } else if (resolved === '0x0000000000000000000000000000000000000000') {
      setContent([
        '⚠ Not found yet — the L2 transaction may still be confirming.',
        document.createElement('br'),
        'Wait ~10 seconds and try again.',
      ])
    } else {
      const resolvedCode = document.createElement('code')
      resolvedCode.textContent = resolved
      const expectedCode = document.createElement('code')
      expectedCode.textContent = expectedOwner
      setContent([
        '⚠ Resolved to a different address:',
        document.createElement('br'),
        resolvedCode, document.createElement('br'),
        'Expected: ', expectedCode,
      ])
    }
  } catch (e) {
    resultEl.className = 'verify-result fail'
    resultEl.textContent = `Error: ${(e as Error).message}`
  } finally {
    if (btn) btn.disabled = false
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  // Show root domain
  const rootDomainEl = byId('rootDomain')
  if (rootDomainEl) {
    rootDomainEl.textContent = config.rootDomain || '(root domain not configured)'
  }

  // Show chain immediately if MetaMask is already present
  const eth = (window as any).ethereum
  if (eth) {
    readChainId().then(updateChainDisplay).catch(() => {})

    // Update chain display whenever user switches networks in MetaMask
    eth.on('chainChanged', (hexChainId: string) => {
      const id = parseInt(hexChainId, 16)
      updateChainDisplay(id)
      // Reset connect state so user re-connects on correct chain
      connectedAddress = null
      const addrEl = byId('connectedAddress')
      if (addrEl) addrEl.textContent = ''
      const connectBtn = byId<HTMLButtonElement>('connectBtn')
      if (connectBtn) { connectBtn.textContent = 'Connect MetaMask'; connectBtn.disabled = false }
      const registerBtn = byId<HTMLButtonElement>('registerBtn')
      if (registerBtn) registerBtn.disabled = true
    })
  }

  // Switch chain button
  const switchChainBtn = byId<HTMLButtonElement>('switchChainBtn')
  switchChainBtn?.addEventListener('click', async () => {
    try {
      await switchToRequiredChain()
    } catch (e) {
      setResult((e as Error)?.message ?? String(e), 'error')
    }
  })

  // Initialise parent input default
  const parentInputEl = byId<HTMLInputElement>('parentInput')
  if (parentInputEl && !parentInputEl.value) {
    parentInputEl.value = config.rootDomain
  }

  // Live preview — update when label or parent changes
  const labelInput = byId<HTMLInputElement>('labelInput')
  const previewEl = byId('preview')
  function refreshPreview() {
    const val = labelInput?.value.trim() ?? ''
    const par = parentInputEl?.value.trim() || config.rootDomain
    if (previewEl) previewEl.textContent = val ? `${val}.${par}` : '\u00a0'
  }
  labelInput?.addEventListener('input', refreshPreview)
  parentInputEl?.addEventListener('input', refreshPreview)

  // Connect button
  const connectBtn = byId<HTMLButtonElement>('connectBtn')
  connectBtn?.addEventListener('click', async () => {
    try {
      connectedAddress = await connectWallet()
      const addrEl = byId('connectedAddress')
      if (addrEl) addrEl.textContent = `Connected: ${connectedAddress}`
      if (connectBtn) {
        connectBtn.textContent = 'Connected'
        connectBtn.disabled = true
      }
      const registerBtn = byId<HTMLButtonElement>('registerBtn')
      if (registerBtn) registerBtn.disabled = false
      // Query server for existing registration; fall back to localStorage cache
      checkExistingRegistration(connectedAddress!)
      // Refresh chain display after connect
      const id = await readChainId()
      updateChainDisplay(id)
    } catch (e) {
      setResult((e as Error)?.message ?? String(e), 'error')
    }
  })

  // Register button
  const registerBtn = byId<HTMLButtonElement>('registerBtn')
  registerBtn?.addEventListener('click', register)
})
