/**
 * Public lookup — no wallet, no login, read-only.
 *
 * One input box that works out for itself whether it was given a name or an address, because
 * asking a visitor to pick the right query type first is a question they should not have to
 * answer to check whether `alice.community.eth` exists.
 *
 * The pure logic lives here and is unit-tested; DOM wiring is at the bottom.
 */
import { OpPanel, explainError, type ResultField } from './ui-state'
import { config } from './config'

export type QueryKind = 'address' | 'name' | 'empty' | 'invalid'

/** Result of classifying whatever the visitor typed. */
export interface Classified {
  kind: QueryKind
  /** Normalised form actually sent to the API; empty when kind is empty/invalid. */
  value: string
  /** Why it was rejected — shown to the visitor, so it must say what to do instead. */
  reason?: string
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
// A name we can actually look up: at least one label plus a TLD.
const NAME_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/

/**
 * Decide what the visitor typed.
 *
 * Deliberately strict about what counts as a name: accepting a bare label like "alice" and
 * silently appending a root domain would show results for a name the visitor did not ask
 * about. Better to say "add the parent domain" than to answer a different question.
 */
export function classifyQuery(raw: string): Classified {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return { kind: 'empty', value: '' }

  if (ADDRESS_RE.test(trimmed)) return { kind: 'address', value: trimmed.toLowerCase() }

  // Catch the near-miss explicitly: a 0x-prefixed string of the wrong length is a typo'd
  // address, not a domain name, and telling someone "that is not a valid name" would send
  // them looking in the wrong place.
  if (/^0x/i.test(trimmed)) {
    return {
      kind: 'invalid',
      value: '',
      reason: `这看起来是个地址,但长度不对(${trimmed.length} 个字符,应为 42)。`,
    }
  }

  const lowered = trimmed.toLowerCase()
  if (NAME_RE.test(lowered)) return { kind: 'name', value: lowered }

  if (/^[a-z0-9-]+$/.test(lowered)) {
    return { kind: 'invalid', value: '', reason: `请补上父域名,例如 ${lowered}.community.eth` }
  }
  return { kind: 'invalid', value: '', reason: '只支持完整的域名(如 alice.community.eth)或 0x 开头的地址。' }
}

/** Shape returned by GET /resolve-status. */
export interface ResolveStatus {
  name: string
  registered: boolean
  l1Resolvable?: boolean | 'unknown'
  estimatedResolvableAt?: number
  detail?: string
}

/**
 * Turn a resolve-status payload into display rows.
 *
 * `l1Resolvable` is deliberately rendered as three distinct states rather than a boolean:
 * "not yet resolvable" and "we could not determine it" are different facts, and collapsing
 * them would tell a visitor their name is broken when the gateway is merely unreachable.
 */
export function describeStatus(s: ResolveStatus): ResultField[] {
  const rows: ResultField[] = [{ label: '名字', value: s.name, copy: true }]

  if (!s.registered) {
    rows.push({ label: '状态', value: '未注册 — 这个名字还没有人拥有' })
    return rows
  }

  rows.push({ label: '状态', value: '已注册' })

  if (s.l1Resolvable === true) {
    rows.push({ label: '全网解析', value: '可解析 — 第三方钱包和工具现在就能解析它' })
  } else if (s.l1Resolvable === false) {
    const when = s.estimatedResolvableAt
      ? `约 ${new Date(s.estimatedResolvableAt * 1000).toLocaleString()} 之后`
      : '稍后'
    rows.push({ label: '全网解析', value: `尚不可用(${when})— 记录已上 L2,正在等待挑战期` })
  } else {
    rows.push({ label: '全网解析', value: `无法确定${s.detail ? ` — ${s.detail}` : ''}` })
  }
  return rows
}

/** Shape returned by GET /lookup?address=. */
export interface AddressLookup {
  found: boolean
  names?: string[]
}

export function describeAddressLookup(a: AddressLookup, address: string): ResultField[] {
  if (!a.found || !a.names?.length) return []
  return [
    { label: '地址', value: address, copy: true },
    ...a.names.map((n, i) => ({ label: i === 0 ? '名字' : '　', value: n, copy: true })),
  ]
}

// ─── DOM wiring ───────────────────────────────────────────────────────────────

function byId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null
}

async function getJson(path: string): Promise<any> {
  const res = await fetch(`${config.apiUrl}${path}`)
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json.error ?? `服务端返回 ${res.status}`)
  return json
}

async function runLookup(): Promise<void> {
  const input = byId<HTMLInputElement>('lookupInput')
  const btn = byId<HTMLButtonElement>('lookupBtn')
  const panel = new OpPanel(byId('lookupResult')!, btn, '查询')

  const q = classifyQuery(input?.value ?? '')
  if (q.kind === 'empty') return panel.empty('输入一个域名或地址开始查询。')
  if (q.kind === 'invalid') return panel.error(new Error(q.reason ?? '无法识别的输入'))

  try {
    panel.pending('查询中…')
    if (q.kind === 'address') {
      const data = (await getJson(`/lookup?address=${encodeURIComponent(q.value)}`)) as AddressLookup
      const rows = describeAddressLookup(data, q.value)
      if (!rows.length) return panel.empty(`这个地址名下没有找到任何名字。`)
      return panel.success(`找到 ${data.names?.length} 个名字`, rows)
    }
    const data = (await getJson(`/resolve-status?name=${encodeURIComponent(q.value)}`)) as ResolveStatus
    panel.success(data.registered ? '查询完成' : '查询完成', describeStatus(data))
  } catch (e) {
    panel.error(e)
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    byId<HTMLButtonElement>('lookupBtn')?.addEventListener('click', runLookup)
    byId<HTMLInputElement>('lookupInput')?.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') runLookup()
    })
    const roots = byId('rootDomainsHint')
    if (roots && config.rootDomain) roots.textContent = `本服务当前管理:${config.rootDomain}`
  })
}
