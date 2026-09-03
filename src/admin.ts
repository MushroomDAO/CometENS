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
import { buildDomain, RegisterTypes, ApproveApplicationTypes, SetAddrTypes, SetTextTypes, SetContenthashTypes, AddRegistrarTypes, RemoveRegistrarTypes, TransferSubnodeTypes } from '../server/gateway/manage/schemas'
import { OpPanel, explainError, explorerTxUrl, type ResultField } from './ui-state'
import {
  renderQueue, describeApplication, buildApproveMessage, serialiseApproveMessage,
  type QueuedApplication,
} from './admin-queue'
import { L2RecordsV2ABI } from '../server/gateway/abi'

// ─── ABIs ─────────────────────────────────────────────────────────────────────

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

// Chain is resolved at startup so l2Client always matches config.network
const l2Client = createPublicClient({
  chain: config.network === 'op-mainnet' ? optimism : optimismSepolia,
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

/**
 * Single funnel for every result panel on this page.
 *
 * Rewriting this one function moves all eight existing forms onto the design system's alert
 * styles at once, instead of editing ~700 lines of call sites. Visibility is toggled with the
 * `hidden` property rather than a CSS class so the markup stays honest about what is shown.
 */
function showResult(elId: string, msg: string, type: 'success' | 'error' | 'info') {
  const el = byId(elId)
  if (!el) return
  el.textContent = msg
  el.className = `alert alert-${type}`
  el.hidden = false
}

function clearResult(elId: string) {
  const el = byId(elId)
  if (!el) return
  el.className = ''
  el.textContent = ''
  el.hidden = true
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
      abi: L2RecordsV2ABI,
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
      abi: L2RecordsV2ABI,
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
      abi: L2RecordsV2ABI,
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

    const response = await fetch(`${config.apiUrl}/set-addr`, {
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

// ─── Approval queue ───────────────────────────────────────────────────────────

/**
 * Load and render the queue.
 *
 * Read-only and unauthenticated: seeing who applied for what is not privileged, and making
 * the list require a wallet connection would mean an operator cannot even glance at the
 * backlog without signing something.
 */
async function loadQueue(): Promise<void> {
  const list = byId('queueList')
  const panel = new OpPanel(byId('queueResult')!, byId<HTMLButtonElement>('queueRefreshBtn'), '刷新')
  if (!list) return
  try {
    const [appsRes, modeRes] = await Promise.all([
      fetch(`${config.apiUrl}/applications`),
      fetch(`${config.apiUrl}/approval-mode`),
    ])
    const apps = ((await appsRes.json()) as any).applications as QueuedApplication[]
    const mode = ((await modeRes.json()) as any).mode as string

    const label = byId('approvalModeLabel')
    if (label) {
      label.textContent =
        mode === 'manual'
          ? '审批模式:manual — 申请进入下面的队列,需要你逐条决定。'
          : '审批模式:auto — 申请提交即发放,这个队列通常是空的。'
    }
    renderQueue(list, apps ?? [], decideOnApplication)
    panel.idle()
  } catch (e) {
    panel.error(e)
  }
}

/** Sign a decision and submit it. Only the contract owner's signature is accepted server-side. */
async function decideOnApplication(id: string, decision: 'approve' | 'reject'): Promise<void> {
  const panel = new OpPanel(byId('queueResult')!, byId<HTMLButtonElement>('queueRefreshBtn'), '刷新')
  let reason: string | undefined
  if (decision === 'reject') {
    // A rejection with no reason leaves the applicant with nothing to act on.
    reason = window.prompt('拒绝理由(会展示给申请人,可留空):') ?? undefined
  }
  try {
    panel.pending(decision === 'approve' ? '等待签名并发放…' : '等待签名…')
    const from = await ensureConnected()
    const chain = getL2Chain()
    const wallet = createWalletClient({ chain, transport: custom(getEthereum()) })

    const message = buildApproveMessage(id, decision, reason)
    const signature = await wallet.signTypedData({
      account: from,
      domain: buildDomain(chain.id, CONTRACT),
      primaryType: 'ApproveApplication',
      types: ApproveApplicationTypes as any,
      message: message as any,
    })

    panel.pending('提交中…')
    const res = await fetch(`${config.apiUrl}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from,
        signature,
        domain: { verifyingContract: CONTRACT },
        message: serialiseApproveMessage(message),
      }),
    })
    const json = await res.json()
    if (!res.ok) throw new Error(json.error ?? `服务端返回 ${res.status}`)

    const fields = describeApplication(json as QueuedApplication)
    if (json.txHash) {
      const href = explorerTxUrl(chain.id, json.txHash)
      if (href) fields.push({ label: '浏览器', value: json.txHash, href, copy: true })
    }
    panel.success(decision === 'approve' ? '已批准并发放' : '已拒绝', fields)
    await loadQueue()
  } catch (e) {
    panel.error(e)
  }
}

// ─── Grant subdomain (the console's primary action) ───────────────────────────

const LABEL_RE = /^[a-z0-9-]+$/

/**
 * Hand a subdomain to an address.
 *
 * This is the one thing a community operator opens the console to do, and it was missing
 * entirely — the page had six ways to read and edit records but no way to issue a name.
 * Uses OpPanel rather than the plain showResult funnel because the outcome carries values
 * (name, node, txHash) that the operator needs to copy elsewhere.
 */
async function signAndSubmitRegister(): Promise<void> {
  const btn = byId<HTMLButtonElement>('registerBtn')
  const panel = new OpPanel(byId('registerResult')!, btn, '签名并授予')

  const label = byId<HTMLInputElement>('registerLabel')?.value.trim().toLowerCase() ?? ''
  const parent = byId<HTMLInputElement>('registerParent')?.value.trim().toLowerCase() ?? ''
  const owner = byId<HTMLInputElement>('registerOwner')?.value.trim() ?? ''

  // Validate before asking for a signature: making someone approve a wallet prompt for a
  // request that cannot succeed is the rudest possible way to report a typo.
  if (!label) return panel.error(new Error('请填写标签'))
  if (!LABEL_RE.test(label)) return panel.error(new Error('InvalidLabel'))
  if (!parent) return panel.error(new Error('请填写父域名'))
  if (!isAddress(owner)) return panel.error(new Error('授予目标不是一个合法地址'))

  try {
    panel.pending('等待钱包签名…')
    const from = await ensureConnected()
    const chain = getL2Chain()
    const wallet = createWalletClient({ chain, transport: custom(getEthereum()) })

    const now = Math.floor(Date.now() / 1000)
    const nonce = BigInt(Date.now())
    const deadline = BigInt(now + 600)
    const message = { parent, label, owner: owner as Address, nonce, deadline }

    const signature = await wallet.signTypedData({
      account: from,
      domain: buildDomain(chain.id, CONTRACT),
      primaryType: 'Register',
      types: RegisterTypes as any,
      message: message as any,
    })

    panel.pending('提交中,等待上链…')
    const response = await fetch(`${config.apiUrl}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from,
        signature,
        domain: { verifyingContract: CONTRACT },
        message: { parent, label, owner, nonce: nonce.toString(), deadline: deadline.toString() },
      }),
    })
    const json = await response.json()
    if (!response.ok) throw new Error(json.error ?? `服务端返回 ${response.status}`)

    const fullName = `${label}.${parent}`
    const fields: ResultField[] = [
      { label: '名字', value: json.name ?? fullName, copy: true },
      { label: '归属', value: owner, copy: true },
    ]
    if (json.node) fields.push({ label: 'node', value: json.node, copy: true })
    if (json.txHash) {
      fields.push({ label: '交易', value: json.txHash, copy: true, href: explorerTxUrl(chain.id, json.txHash) })
    } else {
      // Distinguish "submitted with no tx" from success — the worker may be read-only.
      fields.push({ label: '注意', value: '服务端未返回交易哈希(worker 可能未配置写入密钥)' })
    }
    panel.success(`已授予 ${fullName}`, fields)
  } catch (e) {
    panel.error(e)
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

    const response = await fetch(`${config.apiUrl}/set-text`, {
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
    const checkRes = await fetch(`${config.apiUrl}/check-owner?contract=${config.l2RecordsAddress}`)
    if (!checkRes.ok) throw new Error(`check-owner failed: server ${checkRes.status}`)
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

    const response = await fetch(`${config.apiUrl}/add-registrar`, {
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

// ─── Query Registrar Info ─────────────────────────────────────────────────────

async function queryRegistrarInfo(): Promise<void> {
  clearResult('queryRegistrarResult')

  const parentEl = byId<HTMLInputElement>('queryRegistrarParent')
  const registrarEl = byId<HTMLInputElement>('queryRegistrarAddress')

  const parentDomain = parentEl?.value.trim() ?? ''
  const registrar = (registrarEl?.value.trim() ?? '') as `0x${string}`

  if (!parentDomain) { showResult('queryRegistrarResult', 'Please enter a parent domain.', 'error'); return }
  if (!registrar || !isAddress(registrar)) { showResult('queryRegistrarResult', 'Please enter a valid registrar address.', 'error'); return }

  try {
    const parentNode = namehash(parentDomain) as Hex
    const result = await l2Client.readContract({
      address: CONTRACT,
      abi: L2RecordsV2ABI,
      functionName: 'getRegistrarInfo',
      args: [parentNode, registrar],
    })
    const [isActive, remainingQuota, expiry] = result as [boolean, bigint, bigint]
    const MAX_UINT256 = 2n ** 256n - 1n
    const quotaStr = remainingQuota === MAX_UINT256 ? 'unlimited' : remainingQuota.toString()
    const expiryStr = expiry === 0n ? 'never' : new Date(Number(expiry) * 1000).toISOString()
    showResult(
      'queryRegistrarResult',
      `Parent:    ${parentDomain}\nRegistrar: ${registrar}\nActive:    ${isActive}\nQuota:     ${quotaStr}\nExpiry:    ${expiryStr}`,
      'info',
    )
  } catch (e) {
    showResult('queryRegistrarResult', `Error: ${(e as Error)?.message ?? String(e)}`, 'error')
  }
}

// ─── Remove Registrar ─────────────────────────────────────────────────────────

async function signAndSubmitRemoveRegistrar(): Promise<void> {
  clearResult('removeRegistrarResult')

  const parentEl = byId<HTMLInputElement>('removeRegistrarParent')
  const registrarEl = byId<HTMLInputElement>('removeRegistrarAddress')

  const parentDomain = parentEl?.value.trim() ?? ''
  const registrar = (registrarEl?.value.trim() ?? '') as `0x${string}`

  if (!parentDomain) { showResult('removeRegistrarResult', 'Please enter a parent domain.', 'error'); return }
  if (!registrar || !isAddress(registrar)) { showResult('removeRegistrarResult', 'Please enter a valid registrar address.', 'error'); return }
  if (!connectedAddress) { showResult('removeRegistrarResult', 'Please connect your wallet first.', 'error'); return }

  const removeBtn = byId<HTMLButtonElement>('removeRegistrarBtn')
  try {
    if (removeBtn) { removeBtn.disabled = true; removeBtn.textContent = 'Checking Owner...' }

    const checkRes = await fetch(`${config.apiUrl}/check-owner?contract=${config.l2RecordsAddress}`)
    if (!checkRes.ok) throw new Error(`check-owner failed: server ${checkRes.status}`)
    const ownerData = await checkRes.json() as { owner: string }
    if (ownerData.owner.toLowerCase() !== connectedAddress.toLowerCase()) {
      throw new Error(`Only contract owner (${ownerData.owner}) can remove registrars`)
    }

    if (removeBtn) removeBtn.textContent = 'Signing...'

    const ethereum = getEthereum()
    const chain = getL2Chain()
    const wallet = createWalletClient({ chain, transport: custom(ethereum) })

    const now = Math.floor(Date.now() / 1000)
    const nonce = BigInt(Date.now())
    const deadline = BigInt(now + 600)
    const parentNode = namehash(parentDomain) as Hex

    const domain = buildDomain(chain.id, config.l2RecordsAddress)
    const message = { parentNode, registrar, nonce, deadline }

    const signature = await wallet.signTypedData({
      account: connectedAddress,
      domain,
      primaryType: 'RemoveRegistrar',
      types: RemoveRegistrarTypes as any,
      message: message as any,
    })

    if (removeBtn) removeBtn.textContent = 'Submitting...'

    const response = await fetch(`${config.apiUrl}/remove-registrar`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from: connectedAddress,
        signature,
        domain: { verifyingContract: config.l2RecordsAddress },
        message: {
          parentNode,
          registrar,
          nonce: nonce.toString(),
          deadline: deadline.toString(),
        },
      }),
    })

    const json = await response.json()
    if (!response.ok) throw new Error(json.error ?? `Server error ${response.status}`)

    const txInfo = json.txHash ? `\nTx: ${json.txHash}` : '\n(no tx)'
    showResult('removeRegistrarResult', `Registrar removed for ${parentDomain}\nAddress: ${registrar}${txInfo}`, 'success')
  } catch (e) {
    showResult('removeRegistrarResult', (e as Error)?.message ?? String(e), 'error')
  } finally {
    if (removeBtn) { removeBtn.disabled = false; removeBtn.textContent = 'Connect & Sign RemoveRegistrar' }
  }
}

// ─── Set Contenthash ──────────────────────────────────────────────────────────

async function signAndSubmitSetContenthash(): Promise<void> {
  clearResult('setChResult')

  const nameEl = byId<HTMLInputElement>('setChName')
  const hashEl = byId<HTMLInputElement>('setChHash')

  const name = nameEl?.value.trim() ?? ''
  const hash = (hashEl?.value.trim() ?? '') as Hex

  if (!name) { showResult('setChResult', 'Please enter an ENS name.', 'error'); return }
  if (hash && !isHex(hash)) { showResult('setChResult', 'Contenthash must be a hex string (0x...) or empty to clear.', 'error'); return }

  const setChBtn = byId<HTMLButtonElement>('setChBtn')
  try {
    if (setChBtn) { setChBtn.disabled = true; setChBtn.textContent = 'Signing…' }

    const from = await ensureConnected()
    const chain = getL2Chain()
    const wallet = createWalletClient({ chain, transport: custom(getEthereum()) })

    const node = toNode(name)
    const now = Math.floor(Date.now() / 1000)
    const nonce = BigInt(Date.now())
    const deadline = BigInt(now + 600)

    const domain = buildDomain(chain.id, CONTRACT)
    const message = { node, hash: hash || '0x', nonce, deadline }

    const signature = await wallet.signTypedData({
      account: from,
      domain,
      primaryType: 'SetContenthash',
      types: SetContenthashTypes as any,
      message: message as any,
    })

    if (setChBtn) setChBtn.textContent = 'Submitting…'

    const response = await fetch(`${config.apiUrl}/set-contenthash`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from,
        signature,
        domain: { verifyingContract: CONTRACT },
        message: {
          node: message.node,
          hash: message.hash,
          nonce: nonce.toString(),
          deadline: deadline.toString(),
        },
      }),
    })

    const json = await response.json()
    if (!response.ok) throw new Error(json.error ?? `Server error ${response.status}`)

    const txInfo = json.txHash ? `\nTx: ${json.txHash}` : '\n(no tx — worker key not configured)'
    const action = hash ? `set to ${hash}` : 'cleared'
    showResult('setChResult', `Contenthash ${action} for ${name}${txInfo}`, 'success')
  } catch (e) {
    showResult('setChResult', (e as Error)?.message ?? String(e), 'error')
  } finally {
    if (setChBtn) { setChBtn.disabled = false; setChBtn.textContent = 'Connect & Sign SetContenthash' }
  }
}

// ─── Transfer Subdomain ───────────────────────────────────────────────────────

async function signAndSubmitTransferSubnode(): Promise<void> {
  clearResult('transferSubdomainResult')

  const subdomainEl = byId<HTMLInputElement>('transferSubdomain')
  const toEl = byId<HTMLInputElement>('transferSubdomainTo')

  const subdomain = subdomainEl?.value.trim() ?? ''
  const toAddr = (toEl?.value.trim() ?? '') as `0x${string}`

  if (!subdomain) { showResult('transferSubdomainResult', 'Please enter a subdomain.', 'error'); return }
  if (!isAddress(toAddr)) { showResult('transferSubdomainResult', 'Please enter a valid new owner address.', 'error'); return }

  const transferBtn = byId<HTMLButtonElement>('transferSubdomainBtn')
  try {
    if (transferBtn) { transferBtn.disabled = true; transferBtn.textContent = 'Signing…' }

    const from = await ensureConnected()
    const chain = getL2Chain()
    const wallet = createWalletClient({ chain, transport: custom(getEthereum()) })

    const node = namehash(subdomain) as Hex
    const now = Math.floor(Date.now() / 1000)
    const nonce = BigInt(Date.now())
    const deadline = BigInt(now + 600)

    const domain = buildDomain(chain.id, CONTRACT)
    const message = { node, to: toAddr, nonce, deadline }

    const signature = await wallet.signTypedData({
      account: from,
      domain,
      primaryType: 'TransferSubnode',
      types: TransferSubnodeTypes as any,
      message: message as any,
    })

    if (transferBtn) transferBtn.textContent = 'Submitting…'

    const response = await fetch(`${config.apiUrl}/transfer-subnode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from,
        signature,
        domain: { verifyingContract: CONTRACT },
        message: {
          node: message.node,
          to: message.to,
          nonce: nonce.toString(),
          deadline: deadline.toString(),
        },
      }),
    })

    const json = await response.json()
    if (!response.ok) throw new Error(json.error ?? `Server error ${response.status}`)

    const txInfo = json.txHash ? `\nTx: ${json.txHash}` : '\n(no tx — worker key not configured)'
    showResult('transferSubdomainResult', `Subdomain ${subdomain} transferred to ${toAddr}${txInfo}`, 'success')
  } catch (e) {
    showResult('transferSubdomainResult', (e as Error)?.message ?? String(e), 'error')
  } finally {
    if (transferBtn) { transferBtn.disabled = false; transferBtn.textContent = 'Transfer' }
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
      // Previously a blocking modal dialog, which covers the tab and shows a raw RPC string.
      // The wallet bar is where the user is looking, so the failure belongs there.
      const addrEl = byId('walletAddr')
      const { message } = explainError(e)
      if (addrEl) {
        addrEl.textContent = message
        addrEl.className = 'break-all'
        addrEl.style.color = 'var(--c-danger)'
      }
    }
  })

  // Approval queue — loaded on open so an operator sees the backlog without clicking.
  byId<HTMLButtonElement>('queueRefreshBtn')?.addEventListener('click', loadQueue)
  loadQueue()

  // Grant subdomain — the primary action
  byId<HTMLButtonElement>('registerBtn')?.addEventListener('click', signAndSubmitRegister)

  // Live preview of the resulting name, so the operator sees what they are about to create
  // rather than assembling it in their head from two separate fields.
  const syncPreview = () => {
    const label = byId<HTMLInputElement>('registerLabel')?.value.trim().toLowerCase() || 'alice'
    const parent = byId<HTMLInputElement>('registerParent')?.value.trim().toLowerCase() || config.rootDomain || '…'
    const el = byId('registerPreview')
    if (el) el.textContent = `${label}.${parent}`
  }
  byId<HTMLInputElement>('registerLabel')?.addEventListener('input', syncPreview)
  byId<HTMLInputElement>('registerParent')?.addEventListener('input', syncPreview)
  if (config.rootDomain) {
    const parentEl = byId<HTMLInputElement>('registerParent')
    if (parentEl && !parentEl.value) parentEl.value = config.rootDomain
  }
  syncPreview()

  // Query buttons
  byId<HTMLButtonElement>('queryAddrBtn')?.addEventListener('click', queryAddr)
  byId<HTMLButtonElement>('queryTextBtn')?.addEventListener('click', queryText)
  byId<HTMLButtonElement>('queryChBtn')?.addEventListener('click', queryContenthash)

  // Set addr / set text
  byId<HTMLButtonElement>('setAddrBtn')?.addEventListener('click', signAndSubmitSetAddr)
  byId<HTMLButtonElement>('setTextBtn')?.addEventListener('click', signAndSubmitSetText)

  // Add / remove registrar
  byId<HTMLButtonElement>('addRegistrarBtn')?.addEventListener('click', signAndSubmitAddRegistrar)
  byId<HTMLButtonElement>('removeRegistrarBtn')?.addEventListener('click', signAndSubmitRemoveRegistrar)

  // Query registrar info
  byId<HTMLButtonElement>('queryRegistrarBtn')?.addEventListener('click', queryRegistrarInfo)

  // Set contenthash
  byId<HTMLButtonElement>('setChBtn')?.addEventListener('click', signAndSubmitSetContenthash)

  // Transfer subdomain
  byId<HTMLButtonElement>('transferSubdomainBtn')?.addEventListener('click', signAndSubmitTransferSubnode)
})
