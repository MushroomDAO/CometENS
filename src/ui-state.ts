/**
 * Four-state feedback for chain operations, per docs/agent/spec.md §5.
 *
 * Every on-chain action goes idle → pending → success | error. Before this module the pages
 * used `alert()` and raw text nodes: a modal that blocks the tab and tells the user nothing
 * about what is happening, or a line of unstyled text that appears with no indication that
 * anything was running. Neither survives contact with a transaction that takes 10 seconds.
 *
 * Kept framework-free and dependency-free to match the rest of this app.
 */

export type OpState = 'idle' | 'pending' | 'success' | 'error'

/** A labelled value shown in a result panel; `copy` renders a one-click copy button. */
export interface ResultField {
  label: string
  value: string
  copy?: boolean
  /** Renders as a link (transaction hash, address on an explorer). */
  href?: string
}

const EXPLORERS: Record<number, string> = {
  10: 'https://optimistic.etherscan.io',
  11155420: 'https://sepolia-optimism.etherscan.io',
  1: 'https://etherscan.io',
  11155111: 'https://sepolia.etherscan.io',
}

export function explorerTxUrl(chainId: number, hash: string): string | undefined {
  const base = EXPLORERS[chainId]
  return base ? `${base}/tx/${hash}` : undefined
}

/**
 * Turn a thrown value into something an operator can act on.
 *
 * The contract's custom errors and the wallet's rejection codes are the two things users
 * actually hit; surfacing the raw message for those means showing a hex selector or a
 * hundred-line RPC dump. Anything unrecognised is passed through rather than swallowed —
 * a wrong-but-visible message beats a confident "something went wrong".
 */
export function explainError(e: unknown): { message: string; hint?: string } {
  const err = e as any

  /**
   * Search ACROSS every field, rather than `shortMessage ?? message`.
   *
   * viem puts the decoded custom-error name on `cause.data.errorName`, and `shortMessage`
   * for a revert is just "execution reverted" — so a `??` chain short-circuits on the
   * least informative field and every contract-error branch below becomes dead code. That
   * is not hypothetical: the identical `||` short-circuit was fixed in scripts/delegate.mjs
   * one PR earlier and reintroduced here, and it self-tests as working because the three
   * wallet-level branches match on plain text and do fire.
   *
   * Errors also arrive from the API as a plain `Error(json.error)` with no shortMessage at
   * all, so both shapes have to be covered by the same matcher.
   */
  const haystack = [
    err?.cause?.data?.errorName,
    err?.data?.errorName,
    err?.shortMessage,
    err?.message,
    typeof e === 'string' ? e : undefined,
  ]
    .filter(Boolean)
    .join(' | ')

  // What gets shown when nothing matches: prefer the concise field, fall back to the rest.
  const raw = String(err?.shortMessage ?? err?.message ?? e ?? '')

  if (/User rejected|user rejected|ACTION_REJECTED|4001/.test(haystack)) {
    return { message: '你在钱包里取消了签名', hint: '没有发生任何变更,可以重新提交。' }
  }
  if (/Unauthorized/.test(haystack)) {
    return {
      message: '这个地址没有权限执行该操作',
      hint: '记录只能由该子域名的持有者修改;registrar 相关操作只有合约 owner 能做。',
    }
  }
  if (/AlreadyRegistered/.test(haystack)) {
    return { message: '这个名字已经被注册了', hint: '换一个标签,或用查询确认它当前归谁。' }
  }
  if (/QuotaExceeded/.test(haystack)) {
    return { message: 'registrar 的配额已用尽', hint: '提高该 registrar 的配额,或改用 owner 身份发放。' }
  }
  if (/RegistrarExpired/.test(haystack)) {
    return { message: 'registrar 的授权已过期', hint: '重新授权并设置一个更晚的到期时间。' }
  }
  if (/InvalidLabel|LabelMismatch/.test(haystack)) {
    return { message: '标签不合法', hint: '只能用小写字母、数字和连字符,长度 1–63。' }
  }
  if (/ZeroAddress/.test(haystack)) {
    return { message: '地址不能是全零地址', hint: '检查填入的目标地址。' }
  }
  if (/insufficient funds/i.test(haystack)) {
    return { message: '执行账户余额不足', hint: '给运营钱包充值后重试。' }
  }
  if (/deadline/i.test(haystack)) {
    return { message: '签名已过期', hint: '签名有有效期,请重新签一次。' }
  }
  // Never echo a URL back: provider keys live in RPC URL paths and this text is copied
  // into chat logs and bug reports.
  // wss:// included for the same reason as the worker-side sanitiser (#30): providers
  // issue a websocket endpoint alongside the HTTP one, carrying the same key. This is the
  // LAST redaction before text reaches a public page.
  return { message: raw.replace(/(?:https?|wss?):\/\/[^\s"']+/g, '(已隐去 URL)') || '操作失败' }
}

function el(tag: string, className?: string, text?: string): HTMLElement {
  const n = document.createElement(tag)
  if (className) n.className = className
  if (text !== undefined) n.textContent = text
  return n
}

/** Copy button that reports its own outcome — a button that silently does nothing reads as broken. */
function copyButton(value: string): HTMLElement {
  const b = el('button', 'btn btn-ghost', '复制') as HTMLButtonElement
  b.type = 'button'
  b.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(value)
      b.textContent = '已复制'
    } catch {
      // Clipboard access is refused in some contexts; say so rather than appearing to work.
      b.textContent = '复制失败'
    }
    setTimeout(() => (b.textContent = '复制'), 1500)
  })
  return b
}

/**
 * Renders one operation's state into a container element.
 *
 * Deliberately owns the whole container: partial updates were how the old code ended up
 * showing a stale success message underneath a new error.
 */
export class OpPanel {
  constructor(
    private readonly container: HTMLElement,
    private readonly button?: HTMLButtonElement | null,
    private readonly idleLabel?: string,
  ) {
    if (button && idleLabel === undefined) this.idleLabel = button.textContent ?? ''
  }

  private clear() {
    this.container.textContent = ''
    this.container.className = ''
  }

  idle() {
    this.clear()
    this.container.hidden = true
    if (this.button) {
      this.button.disabled = false
      if (this.idleLabel) this.button.textContent = this.idleLabel
    }
  }

  /** Disables the trigger so a slow transaction cannot be submitted twice. */
  pending(message = '处理中…') {
    this.clear()
    this.container.hidden = false
    this.container.className = 'alert alert-info'
    const row = el('div', 'row')
    row.appendChild(el('span', 'skeleton', ''))
    row.appendChild(el('span', undefined, message))
    this.container.appendChild(row)
    if (this.button) {
      this.button.disabled = true
      this.button.textContent = '处理中…'
    }
  }

  success(title: string, fields: ResultField[] = []) {
    this.clear()
    this.container.hidden = false
    this.container.className = 'alert alert-success'
    this.container.appendChild(el('strong', undefined, title))
    for (const f of fields) {
      const row = el('div', 'row')
      row.appendChild(el('span', 'muted', `${f.label}:`))
      if (f.href) {
        const a = document.createElement('a')
        a.href = f.href
        a.target = '_blank'
        a.rel = 'noopener noreferrer'
        a.className = 'break-all mono'
        a.textContent = f.value
        row.appendChild(a)
      } else {
        row.appendChild(el('span', 'break-all mono', f.value))
      }
      if (f.copy) row.appendChild(copyButton(f.value))
      this.container.appendChild(row)
    }
    if (this.button) {
      this.button.disabled = false
      if (this.idleLabel) this.button.textContent = this.idleLabel
    }
  }

  error(e: unknown) {
    const { message, hint } = explainError(e)
    this.clear()
    this.container.hidden = false
    this.container.className = 'alert alert-error'
    this.container.appendChild(el('strong', undefined, message))
    if (hint) this.container.appendChild(el('div', 'muted', hint))
    if (this.button) {
      this.button.disabled = false
      if (this.idleLabel) this.button.textContent = this.idleLabel
    }
  }

  /** Distinct from success-with-no-fields: "found nothing" is not "did nothing". */
  empty(message: string) {
    this.clear()
    this.container.hidden = false
    this.container.className = 'empty-state'
    this.container.textContent = message
    if (this.button) {
      this.button.disabled = false
      if (this.idleLabel) this.button.textContent = this.idleLabel
    }
  }
}
