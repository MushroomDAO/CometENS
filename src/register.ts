import { createWalletClient, custom } from 'viem'
import { optimismSepolia, optimism } from 'viem/chains'
import { config } from './config'
import { RegisterTypes, buildDomain } from '../server/gateway/manage/schemas'

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

async function connectWallet(): Promise<`0x${string}`> {
  const ethereum = getEthereum()
  const wallet = createWalletClient({
    chain: getChain(),
    transport: custom(ethereum),
  })
  const [address] = await wallet.requestAddresses()
  return address
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
    registerBtn.textContent = 'Signing…'
  }

  try {
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
      throw new Error(json.error ?? `Server error ${response.status}`)
    }

    const fullName = `${label}.${config.rootDomain}`
    const txInfo = json.txHash ? `\nTx: ${json.txHash}` : '\n(no tx — worker key not configured)'
    setResult(`Registered: ${fullName}${txInfo}`, 'success')
  } catch (e) {
    setResult((e as Error)?.message ?? String(e), 'error')
  } finally {
    if (registerBtn) {
      registerBtn.disabled = !connectedAddress
      registerBtn.textContent = 'Register Subdomain'
    }
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  // Show root domain
  const rootDomainEl = byId('rootDomain')
  if (rootDomainEl) {
    rootDomainEl.textContent = config.rootDomain || '(root domain not configured)'
  }

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
    } catch (e) {
      setResult((e as Error)?.message ?? String(e), 'error')
    }
  })

  // Register button
  const registerBtn = byId<HTMLButtonElement>('registerBtn')
  registerBtn?.addEventListener('click', register)
})
