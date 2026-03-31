import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  namehash,
  isAddress,
  isHex,
  type Address,
  type Hex,
} from 'viem'
import { optimismSepolia, sepolia, optimism, mainnet } from 'viem/chains'
import { config, isTestnet } from './config'
import { buildDomain, SetAddrTypes, SetTextTypes, AddRegistrarTypes } from '../server/gateway/manage/schemas'

// ─── ABIs ─────────────────────────────────────────────────────────────────────

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
    inputs: [{ name: 'node', type: 'bytes32' }, { name: 'key', type: 'string' }],
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

const PUBLIC_RESOLVER_ABI = [
  {
    type: 'function',
    name: 'contenthash',
    stateMutability: 'view',
    inputs: [{ name: 'node', type: 'bytes32' }],
    outputs: [{ name: '', type: 'bytes' }],
  },
] as const

// ─── Clients ──────────────────────────────────────────────────────────────────

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

// ─── DOM helpers ──────────────────────────────────────────────────────────────

function byId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null
}

function showResult(elId: string, msg: string, type: 'success' | 'error' | 'info') {
  const el = byId(elId)
  if (!el) return
  el.textContent = msg
  el.className = `result-box ${type}`
}

function clearResult(elId: string) {
  const el = byId(elId)
  if (!el) return
  el.className = 'result-box hidden'
  el.textContent = ''
}

function getQuerySource(): 'l1' | 'l2' {
  const el = byId<HTMLSelectElement>('querySource')
  return el?.value === 'l1' ? 'l1' : 'l2'
}

function getL1Client() {
  const chainEl = byId<HTMLSelectElement>('l1Chain')
  return chainEl?.value === 'mainnet' ? l1MainnetClient : l1SepoliaClient
}

function toNode(value: string): `0x${string}` {
  const v = value.trim()
  if (isHex(v) && v.length === 66) return v as `0x${string}`
  return namehash(v)
}

// ─── Wallet ───────────────────────────────────────────────────────────────────

let connectedAddress: Address | null = null

function getEthereum(): any {
  const eth = (window as any).ethereum
  if (!eth) throw new Error('MetaMask not detected. Please install MetaMask.')
  return eth
}

function getL2Chain() {
  return config.network === 'op-mainnet' ? optimism : optimismSepolia
}

async function ensureConnected(): Promise<Address> {
  if (connectedAddress) return connectedAddress
  const ethereum = getEthereum()
  const wallet = createWalletClient({ chain: getL2Chain(), transport: custom(ethereum) })
  const [address] = await wallet.requestAddresses()
  connectedAddress = address
  updateWalletBar()
  return connectedAddress
}

function updateWalletBar() {
  const addrEl = byId('walletAddr')
  const connectBtn = byId<HTMLButtonElement>('connectWalletBtn')
  if (connectedAddress) {
    if (addrEl) addrEl.textContent = `Connected: ${connectedAddress}`
    if (connectBtn) {
      connectBtn.textContent = 'Connected'
      connectBtn.disabled = true
    }
  }
}

// ─── Query ────────────────────────────────────────────────────────────────────

async function queryAddr(): Promise<void> {
  clearResult('queryResult')
  const nameInput = byId<HTMLInputElement>('queryName')
  const name = nameInput?.value.trim() ?? ''
  if (!name) { showResult('queryResult', 'Please enter an ENS name.', 'error'); return }

  try {
    const source = getQuerySource()
    if (source === 'l1') {
      const l1 = getL1Client()
      const value = await l1.getEnsAddress({ name })
      showResult('queryResult', `L1 addr: ${value ?? '(null)'}`, 'info')
      return
    }
    const node = toNode(name)
    const value = await l2Client.readContract({
      address: CONTRACT,
      abi: L2_RECORDS_ABI,
      functionName: 'addr',
      args: [node],
    })
    showResult('queryResult', `L2 addr: ${value}`, 'info')
  } catch (e) {
    showResult('queryResult', `Error: ${(e as Error)?.message ?? String(e)}`, 'error')
  }
}

async function queryText(): Promise<void> {
  clearResult('queryResult')
  const nameInput = byId<HTMLInputElement>('queryName')
  const keyInput = byId<HTMLInputElement>('queryTextKey')
  const name = nameInput?.value.trim() ?? ''
  const key = keyInput?.value.trim() || 'com.twitter'
  if (!name) { showResult('queryResult', 'Please enter an ENS name.', 'error'); return }

  try {
    const source = getQuerySource()
    if (source === 'l1') {
      const l1 = getL1Client()
      const value = await l1.getEnsText({ name, key })
      showResult('queryResult', `L1 text(${key}): ${value ?? '(null)'}`, 'info')
      return
    }
    const node = toNode(name)
    const value = await l2Client.readContract({
      address: CONTRACT,
      abi: L2_RECORDS_ABI,
      functionName: 'text',
      args: [node, key],
    })
    showResult('queryResult', `L2 text(${key}): ${value}`, 'info')
  } catch (e) {
    showResult('queryResult', `Error: ${(e as Error)?.message ?? String(e)}`, 'error')
  }
}

async function queryContenthash(): Promise<void> {
  clearResult('queryResult')
  const nameInput = byId<HTMLInputElement>('queryName')
  const name = nameInput?.value.trim() ?? ''
  if (!name) { showResult('queryResult', 'Please enter an ENS name.', 'error'); return }

  try {
    const source = getQuerySource()
    if (source === 'l1') {
      const l1 = getL1Client()
      const resolver = await l1.getEnsResolver({ name })
      if (!resolver) { showResult('queryResult', 'L1 contenthash: (no resolver)', 'info'); return }
      const node = namehash(name)
      const value = await l1.readContract({
        address: resolver,
        abi: PUBLIC_RESOLVER_ABI,
        functionName: 'contenthash',
        args: [node],
      })
      showResult('queryResult', `L1 contenthash: ${value}`, 'info')
      return
    }
    const node = toNode(name)
    const value = await l2Client.readContract({
      address: CONTRACT,
      abi: L2_RECORDS_ABI,
      functionName: 'contenthash',
      args: [node],
    })
    showResult('queryResult', `L2 contenthash: ${value}`, 'info')
  } catch (e) {
    showResult('queryResult', `Error: ${(e as Error)?.message ?? String(e)}`, 'error')
  }
}

// ─── Set Addr ─────────────────────────────────────────────────────────────────

async function signAndSubmitSetAddr(): Promise<void> {
  clearResult('setAddrResult')

  const nameEl = byId<HTMLInputElement>('setAddrName')
  const addrEl = byId<HTMLInputElement>('setAddrAddr')
  const coinEl = byId<HTMLInputElement>('setAddrCoinType')

  const name = nameEl?.value.trim() ?? ''
  const addrVal = addrEl?.value.trim() ?? ''
  const coinType = BigInt(coinEl?.value.trim() || '60')

  if (!name) { showResult('setAddrResult', 'Please enter an ENS name.', 'error'); return }
  if (!isAddress(addrVal)) { showResult('setAddrResult', 'Invalid address.', 'error'); return }

  const setAddrBtn = byId<HTMLButtonElement>('setAddrBtn')
  try {
    if (setAddrBtn) { setAddrBtn.disabled = true; setAddrBtn.textContent = 'Signing…' }

    const from = await ensureConnected()
    const chain = getL2Chain()
    const wallet = createWalletClient({ chain, transport: custom(getEthereum()) })

    const node = toNode(name)
    const now = Math.floor(Date.now() / 1000)
    const nonce = BigInt(Date.now())
    const deadline = BigInt(now + 600)

    const domain = buildDomain(chain.id, CONTRACT)
    const message = {
      node,
      coinType,
      addr: addrVal as Hex,
      nonce,
      deadline,
    }

    const signature = await wallet.signTypedData({
      account: from,
      domain,
      primaryType: 'SetAddr',
      types: SetAddrTypes as any,
      message: message as any,
    })

    if (setAddrBtn) setAddrBtn.textContent = 'Submitting…'

    const response = await fetch('/api/manage/set-addr', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from,
        signature,
        domain: { verifyingContract: CONTRACT },
        message: {
          node: message.node,
          coinType: coinType.toString(),
          addr: message.addr,
          nonce: nonce.toString(),
          deadline: deadline.toString(),
        },
      }),
    })

    const json = await response.json()
    if (!response.ok) throw new Error(json.error ?? `Server error ${response.status}`)

    const txInfo = json.txHash ? `\nTx: ${json.txHash}` : '\n(no tx — worker key not configured)'
    showResult('setAddrResult', `SetAddr submitted for ${name}${txInfo}`, 'success')
  } catch (e) {
    showResult('setAddrResult', (e as Error)?.message ?? String(e), 'error')
  } finally {
    if (setAddrBtn) { setAddrBtn.disabled = false; setAddrBtn.textContent = 'Connect & Sign SetAddr' }
  }
}

// ─── Set Text ─────────────────────────────────────────────────────────────────

async function signAndSubmitSetText(): Promise<void> {
  clearResult('setTextResult')

  const nameEl = byId<HTMLInputElement>('setTextName')
  const keyEl = byId<HTMLInputElement>('setTextKey')
  const valueEl = byId<HTMLInputElement>('setTextValue')

  const name = nameEl?.value.trim() ?? ''
  const key = keyEl?.value.trim() ?? ''
  const value = valueEl?.value ?? ''

  if (!name) { showResult('setTextResult', 'Please enter an ENS name.', 'error'); return }
  if (!key) { showResult('setTextResult', 'Please enter a key.', 'error'); return }

  const setTextBtn = byId<HTMLButtonElement>('setTextBtn')
  try {
    if (setTextBtn) { setTextBtn.disabled = true; setTextBtn.textContent = 'Signing…' }

    const from = await ensureConnected()
    const chain = getL2Chain()
    const wallet = createWalletClient({ chain, transport: custom(getEthereum()) })

    const node = toNode(name)
    const now = Math.floor(Date.now() / 1000)
    const nonce = BigInt(Date.now())
    const deadline = BigInt(now + 600)

    const domain = buildDomain(chain.id, CONTRACT)
    const message = { node, key, value, nonce, deadline }

    const signature = await wallet.signTypedData({
      account: from,
      domain,
      primaryType: 'SetText',
      types: SetTextTypes as any,
      message: message as any,
    })

    if (setTextBtn) setTextBtn.textContent = 'Submitting…'

    const response = await fetch('/api/manage/set-text', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from,
        signature,
        domain: { verifyingContract: CONTRACT },
        message: {
          node: message.node,
          key: message.key,
          value: message.value,
          nonce: nonce.toString(),
          deadline: deadline.toString(),
        },
      }),
    })

    const json = await response.json()
    if (!response.ok) throw new Error(json.error ?? `Server error ${response.status}`)

    const txInfo = json.txHash ? `\nTx: ${json.txHash}` : '\n(no tx — worker key not configured)'
    showResult('setTextResult', `SetText submitted for ${name} (${key} = "${value}")${txInfo}`, 'success')
  } catch (e) {
    showResult('setTextResult', (e as Error)?.message ?? String(e), 'error')
  } finally {
    if (setTextBtn) { setTextBtn.disabled = false; setTextBtn.textContent = 'Connect & Sign SetText' }
  }
}

// ─── Add Registrar ────────────────────────────────────────────────────────────

async function signAndSubmitAddRegistrar(): Promise<void> {
  clearResult('addRegistrarResult')

  const parentEl = byId<HTMLInputElement>('addRegistrarParent')
  const registrarEl = byId<HTMLInputElement>('addRegistrarAddress')
  const quotaEl = byId<HTMLInputElement>('addRegistrarQuota')
  const expiryEl = byId<HTMLInputElement>('addRegistrarExpiry')

  const parentDomain = parentEl?.value.trim() ?? ''
  const registrar = (registrarEl?.value.trim() ?? '') as `0x${string}`
  const quota = quotaEl?.value ? BigInt(quotaEl.value) : 1000n
  const expiry = expiryEl?.value ? BigInt(expiryEl.value) : 0n

  if (!parentDomain) {
    showResult('addRegistrarResult', 'Please enter a parent domain.', 'error')
    return
  }
  if (!registrar || !isAddress(registrar)) {
    showResult('addRegistrarResult', 'Please enter a valid registrar address.', 'error')
    return
  }
  if (!connectedAddress) {
    showResult('addRegistrarResult', 'Please connect your wallet first.', 'error')
    return
  }

  const addBtn = byId<HTMLButtonElement>('addRegistrarBtn')
  if (addBtn) {
    addBtn.disabled = true
    addBtn.textContent = 'Checking Owner...'
  }

  try {
    // Check if connected wallet is the contract owner
    const checkRes = await fetch(`/api/manage/check-owner?contract=${config.l2RecordsAddress}`)
    const ownerData = await checkRes.json() as { owner: string }
    
    if (ownerData.owner.toLowerCase() !== connectedAddress.toLowerCase()) {
      throw new Error(`Only contract owner (${ownerData.owner}) can add registrars`)
    }

    if (addBtn) addBtn.textContent = 'Signing...'

    const ethereum = getEthereum()
    const chain = getL2Chain()
    const wallet = createWalletClient({ chain, transport: custom(ethereum) })

    const now = Math.floor(Date.now() / 1000)
    const nonce = BigInt(Date.now())
    const deadline = BigInt(now + 600)
    const parentNode = namehash(parentDomain) as Hex

    const domain = buildDomain(chain.id, config.l2RecordsAddress)
    const message = {
      parentNode,
      registrar,
      quota,
      expiry,
      nonce,
      deadline,
    }

    const signature = await wallet.signTypedData({
      account: connectedAddress,
      domain,
      primaryType: 'AddRegistrar',
      types: AddRegistrarTypes as any,
      message: message as any,
    })

    if (addBtn) addBtn.textContent = 'Submitting...'

    const response = await fetch('/api/manage/add-registrar', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from: connectedAddress,
        signature,
        domain: { verifyingContract: config.l2RecordsAddress },
        message: {
          parentNode,
          registrar,
          quota: quota.toString(),
          expiry: expiry.toString(),
          nonce: nonce.toString(),
          deadline: deadline.toString(),
        },
      }),
    })

    const json = await response.json()

    if (!response.ok) {
      throw new Error(json.error ?? `Server error ${response.status}`)
    }

    const txInfo = json.txHash ? `\nTx: ${json.txHash}` : '\n(no tx)'
    showResult('addRegistrarResult', `Registrar added for ${parentDomain}\nAddress: ${registrar}\nQuota: ${quota}${txInfo}`, 'success')
  } catch (e) {
    showResult('addRegistrarResult', (e as Error)?.message ?? String(e), 'error')
  } finally {
    if (addBtn) {
      addBtn.disabled = !connectedAddress
      addBtn.textContent = 'Connect & Sign AddRegistrar'
    }
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  // Root domain label
  const rootDomainEl = byId('rootDomainLabel')
  if (rootDomainEl) rootDomainEl.textContent = config.rootDomain || '(not configured)'

  // Query source toggle: show/hide L1 chain selector
  const querySourceEl = byId<HTMLSelectElement>('querySource')
  const l1ChainEl = byId<HTMLSelectElement>('l1Chain')
  querySourceEl?.addEventListener('change', () => {
    if (l1ChainEl) l1ChainEl.style.display = querySourceEl.value === 'l1' ? '' : 'none'
  })

  // Connect wallet
  byId<HTMLButtonElement>('connectWalletBtn')?.addEventListener('click', async () => {
    try {
      await ensureConnected()
    } catch (e) {
      alert((e as Error)?.message ?? String(e))
    }
  })

  // Query buttons
  byId<HTMLButtonElement>('queryAddrBtn')?.addEventListener('click', queryAddr)
  byId<HTMLButtonElement>('queryTextBtn')?.addEventListener('click', queryText)
  byId<HTMLButtonElement>('queryChBtn')?.addEventListener('click', queryContenthash)

  // Set addr / set text
  byId<HTMLButtonElement>('setAddrBtn')?.addEventListener('click', signAndSubmitSetAddr)
  byId<HTMLButtonElement>('setTextBtn')?.addEventListener('click', signAndSubmitSetText)

  // Add registrar
  byId<HTMLButtonElement>('addRegistrarBtn')?.addEventListener('click', signAndSubmitAddRegistrar)
})
