/**
 * Admin approval queue.
 *
 * `APPROVAL_MODE=manual` puts applications in a queue; without this surface an operator who
 * turns manual on has no way to act on them except by hand-crafting signed API calls. The
 * mode was shipped in T1.6.1 — this is the half that makes it usable.
 *
 * Pure logic lives at the top and is unit-tested; DOM wiring is at the bottom.
 */
import type { ResultField } from './ui-state'

export type ApplicationStatus = 'pending' | 'approved' | 'rejected'

/** The public shape returned by GET /applications — deliberately narrow. */
export interface QueuedApplication {
  id: string
  name: string
  owner: string
  status: ApplicationStatus
  createdAt: number
  decidedAt?: number
  reason?: string
  txHash?: string
}

/**
 * Applications awaiting a decision, oldest first.
 *
 * Oldest-first because a queue an operator works through top-down should not let a name
 * languish just because newer ones keep arriving.
 */
export function pendingFirst(apps: QueuedApplication[]): QueuedApplication[] {
  return apps.filter((a) => a.status === 'pending').sort((a, b) => a.createdAt - b.createdAt)
}

/** Everything already decided, newest first — recent decisions are the ones worth re-reading. */
export function decided(apps: QueuedApplication[]): QueuedApplication[] {
  return apps
    .filter((a) => a.status !== 'pending')
    .sort((a, b) => (b.decidedAt ?? b.createdAt) - (a.decidedAt ?? a.createdAt))
}

/** Human summary of one application, for the result panel after a decision. */
export function describeApplication(a: QueuedApplication): ResultField[] {
  const rows: ResultField[] = [
    { label: '名字', value: a.name, copy: true },
    { label: '授予给', value: a.owner, copy: true },
    { label: '状态', value: statusLabel(a) },
  ]
  if (a.reason) rows.push({ label: '理由', value: a.reason })
  if (a.txHash) rows.push({ label: '交易', value: a.txHash, copy: true })
  return rows
}

export function statusLabel(a: QueuedApplication): string {
  if (a.status === 'pending') return '待审批'
  if (a.status === 'approved') return a.txHash ? '已批准并发放' : '已批准(未见交易哈希)'
  return '已拒绝'
}

/**
 * The EIP-712 message for a decision.
 *
 * `reason` is always a string — the typed-data schema declares it, so omitting it would
 * change the struct hash and make the signature unverifiable. An empty string is the
 * "no reason given" value, not a missing field.
 */
export function buildApproveMessage(
  id: string,
  decision: 'approve' | 'reject',
  reason: string | undefined,
  now = Date.now(),
): { id: string; decision: string; reason: string; nonce: bigint; deadline: bigint } {
  return {
    id,
    decision,
    reason: reason ?? '',
    nonce: BigInt(now),
    deadline: BigInt(Math.floor(now / 1000) + 600),
  }
}

/** Serialise for JSON transport — bigints do not survive JSON.stringify. */
export function serialiseApproveMessage(m: ReturnType<typeof buildApproveMessage>) {
  return { ...m, nonce: m.nonce.toString(), deadline: m.deadline.toString() }
}

// ─── DOM wiring ───────────────────────────────────────────────────────────────

function byId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null
}

/**
 * Render the queue.
 *
 * Exported and DOM-free in its decision-making so the ordering above stays testable; the
 * element construction below is intentionally dumb.
 */
export function renderQueue(
  container: HTMLElement,
  apps: QueuedApplication[],
  onDecide: (id: string, decision: 'approve' | 'reject') => void,
): void {
  container.textContent = ''
  const pending = pendingFirst(apps)

  if (!pending.length) {
    const empty = document.createElement('div')
    empty.className = 'empty-state'
    empty.textContent =
      apps.length > 0 ? '没有待审批的申请(下面是已处理的)。' : '还没有任何申请。'
    container.appendChild(empty)
  }

  for (const app of pending) {
    const card = document.createElement('div')
    card.className = 'card'
    card.dataset.appId = app.id

    const title = document.createElement('strong')
    title.className = 'break-all mono'
    title.textContent = app.name
    card.appendChild(title)

    const meta = document.createElement('div')
    meta.className = 'muted break-all'
    meta.textContent = `授予给 ${app.owner} · 申请于 ${new Date(app.createdAt * 1000).toLocaleString()}`
    card.appendChild(meta)

    const actions = document.createElement('div')
    actions.className = 'row'
    actions.style.marginTop = 'var(--sp-3)'
    for (const [decision, label, cls] of [
      ['approve', '批准并发放', 'btn btn-primary'],
      ['reject', '拒绝', 'btn'],
    ] as const) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = cls
      b.textContent = label
      b.addEventListener('click', () => onDecide(app.id, decision))
      actions.appendChild(b)
    }
    card.appendChild(actions)
    container.appendChild(card)
  }

  for (const app of decided(apps)) {
    const row = document.createElement('div')
    row.className = 'row muted'
    row.style.marginTop = 'var(--sp-2)'
    row.textContent = `${app.name} — ${statusLabel(app)}${app.reason ? ` (${app.reason})` : ''}`
    container.appendChild(row)
  }
}

export { byId as __byIdForWiring }
