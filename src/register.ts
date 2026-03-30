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
] as const

const SUBNODE_EVENT_ABI = [{
  type: 'event' as const, name: 'SubnodeOwnerSet',
  inputs: [
    { name: 'parentNode',   type: 'bytes32' as const, indexed: true },
    { name: 'labelhash',    type: 'bytes32' as const, indexed: true },
    { name: 'node',         type: 'bytes32' as const, indexed: true },
    { name: 'subnodeOwner', type: 'address' as const, indexed: false },
  ],
}]

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
      await eth.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: hexId,
          chainName: 'OP Sepolia',
          nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
          rpcUrls: ['https://sepolia.optimism.io'],
          blockExplorerUrls: ['https://sepolia-optimism.etherscan.io'],
        }],
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

const STORAGE_KEY = 'cometens_registrations'

interface RegistrationRecord {
  address: string
  label: string
  fullName: string
}

function saveRegistration(address: string, label: string, fullName: string) {
  const records: RegistrationRecord[] = getRegistrations()
  // overwrite if same address already in list
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

async function checkExistingRegistration(address: string) {
  try {
    const res = await fetch(`/api/manage/lookup?address=${encodeURIComponent(address)}`)
    if (res.ok) {
      const json = await res.json() as { found: boolean; label?: string; fullName?: string }
      if (json.found && json.label && json.fullName) {
        // Server is authoritative — save to localStorage and show banner
        saveRegistration(address, json.label, json.fullName)
        showExistingBanner({ address, label: json.label, fullName: json.fullName })
        return
      }
    }
  } catch {
    // server unreachable — fall through to localStorage cache
  }
  // Fallback: use cached localStorage entry from a previous session
  const cached = getRegistrationFor(address)
  if (cached) showExistingBanner(cached)
}

function showExistingBanner(rec: RegistrationRecord) {
  let banner = byId('existingBanner')
  if (!banner) {
    banner = document.createElement('div')
    banner.id = 'existingBanner'
    banner.style.cssText = [
      'margin-top:16px', 'padding:12px 16px', 'border-radius:6px',
      'background:#e3f2fd', 'border:1px solid #90caf9', 'color:#1565c0',
      'font-size:13px', 'line-height:1.6',
    ].join(';')
    const card = byId('verifyCard')?.parentElement ?? document.body
    // insert before the register card
    const registerCard = byId('registerBtn')?.closest('.card')
    if (registerCard) {
      registerCard.parentElement?.insertBefore(banner, registerCard)
    } else {
      card.appendChild(banner)
    }
  }
  banner.innerHTML =
    `ℹ️ This wallet already has a subdomain: ` +
    `<strong>${rec.fullName}</strong> — ` +
    `<a href="/eth.html" style="color:#0b79d0">manage records</a> · ` +
    `<a href="#" id="forceRegisterLink" style="color:#0b79d0">register another</a>`

  byId('forceRegisterLink')?.addEventListener('click', (e) => {
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

  try {
    // Pre-flight: check availability before asking MetaMask to sign
    const checkRes = await fetch(
      `/api/manage/check-label?label=${encodeURIComponent(label)}&parent=${encodeURIComponent(config.rootDomain)}`
    )
    if (checkRes.ok) {
      const checkJson = await checkRes.json() as { available: boolean; owner?: string }
      if (!checkJson.available) {
        throw new Error(`"${label}.${config.rootDomain}" is already registered to ${checkJson.owner ?? 'another address'}.`)
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
      parent: config.rootDomain,
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

    const response = await fetch('/api/manage/register', {
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
      if (json.code === 'ALREADY_REGISTERED' && connectedAddress) {
        const existing = getRegistrationFor(connectedAddress)
        const name = existing?.fullName ?? `a subdomain under ${config.rootDomain}`
        throw new Error(`This wallet already has ${name}. Use the manage page to update records.`)
      }
      throw new Error(json.error ?? `Server error ${response.status}`)
    }

    const fullName = `${label}.${config.rootDomain}`
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
  const node = namehash(fullName)
  const l2Contract = config.l2RecordsAddress
  const isTestnet = config.network === 'op-sepolia'

  const etherscanBase = isTestnet
    ? 'https://sepolia-optimism.etherscan.io'
    : 'https://optimistic.etherscan.io'
  const ensApp = isTestnet
    ? `https://app.ens.domains/${fullName}?chain=sepolia`
    : `https://app.ens.domains/${fullName}`

  linksEl.innerHTML = [
    `<a href="${etherscanBase}/address/${l2Contract}#readContract" target="_blank">L2Records on Etherscan</a>`,
    `<a href="${ensApp}" target="_blank">ENS App</a>`,
    `<a href="/eth.html" target="_blank">L2 Query Tool</a>`,
    `<a href="${etherscanBase}/tx/${(byId('result')?.textContent ?? '').match(/0x[a-f0-9]{64}/i)?.[0] ?? ''}" target="_blank">View Tx</a>`,
  ].join('')

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
    if (match) {
      resultEl.innerHTML =
        `✓ Resolved successfully<br>` +
        `<strong>${fullName}</strong><br>` +
        `→ <code>${resolved}</code>`
    } else if (resolved === '0x0000000000000000000000000000000000000000') {
      resultEl.innerHTML =
        `⚠ Not found yet — the L2 transaction may still be confirming.<br>` +
        `Wait ~10 seconds and try again.`
    } else {
      resultEl.innerHTML =
        `⚠ Resolved to a different address:<br>` +
        `<code>${resolved}</code><br>` +
        `Expected: <code>${expectedOwner}</code>`
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

  // Live preview
  const labelInput = byId<HTMLInputElement>('labelInput')
  const previewEl = byId('preview')
  labelInput?.addEventListener('input', () => {
    const val = labelInput.value.trim()
    if (previewEl) {
      previewEl.textContent = val ? `${val}.${config.rootDomain}` : '\u00a0'
    }
  })

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
