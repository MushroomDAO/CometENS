/**
 * The application flow, as the applicant experiences it.
 *
 * The page used to say "register" and call `/register` directly. That was never what this
 * system does: subdomains are GRANTED — automatically by an upstream integration, or by an
 * operator after review. `APPROVAL_MODE` decides which, and the applicant cannot tell from
 * the outside, so the page has to say which one is in force BEFORE they sign.
 *
 * No login, no account. The wallet signature identifies the recipient; it is not a session.
 */
import type { ResultField } from './ui-state'

export type ApprovalMode = 'auto' | 'manual'

/**
 * What the page learned about the API's approval support.
 *
 * `unsupported` is its own state, and it must NOT fall back to POSTing `/register`: that
 * endpoint grants immediately, so "resilience" there would silently bypass approval — the
 * one thing manual mode exists to prevent. A deployment whose API predates applications
 * cannot serve this page honestly, so the page refuses to take a signature it cannot use.
 */
export type ModeProbe =
  | { kind: 'ok'; mode: ApprovalMode }
  | { kind: 'unsupported' }
  | { kind: 'unknown' }

/** 404 means the API has no application support at all; anything else is a transient unknown. */
export function classifyModeProbe(status: number, body: unknown): ModeProbe {
  if (status === 404) return { kind: 'unsupported' }
  if (status < 200 || status >= 300) return { kind: 'unknown' }
  const mode = (body as { mode?: string } | null)?.mode
  if (mode === 'auto' || mode === 'manual') return { kind: 'ok', mode }
  return { kind: 'unknown' }
}

/** Whether the applicant may sign. Only a positively known mode qualifies. */
export function canSubmit(probe: ModeProbe): boolean {
  return probe.kind === 'ok'
}

export function probeNotice(probe: ModeProbe): string {
  if (probe.kind === 'ok') return modeNotice(probe.mode)
  if (probe.kind === 'unsupported')
    return '这套部署的 API 还不支持申请流程(需要重新部署 API worker)。现在提交的话签名会白签,所以先停用了。'
  return '暂时读不到这个社区的审批设置,先不要提交 —— 刷新一下再试。'
}

/** The shape /apply returns — the server's `publicView` plus the mode it ran under. */
export interface ApplyResponse {
  id: string
  name: string
  owner: string
  status: 'pending' | 'approved' | 'rejected'
  mode: ApprovalMode
  txHash?: string
  reason?: string
}

/**
 * The three outcomes a submission can have. They are kept distinct because collapsing any
 * two of them tells the applicant something untrue about whether they have a name.
 */
export type Outcome = 'granted' | 'granted-unconfirmed' | 'queued' | 'rejected'

export function classifyOutcome(res: ApplyResponse): Outcome {
  if (res.status === 'rejected') return 'rejected'
  if (res.status === 'pending') return 'queued'
  return res.txHash ? 'granted' : 'granted-unconfirmed'
}

/**
 * Headline for each outcome.
 *
 * `granted-unconfirmed` exists because the API returns ok with no txHash when the writer key
 * is not configured. Showing that as a plain success would tell someone they own a name that
 * was never written to the chain — they would then hand it out and find it resolves to
 * nothing. It is a distinct, non-celebratory message on purpose.
 */
export function outcomeHeadline(outcome: Outcome): string {
  switch (outcome) {
    case 'granted':
      return '已发放 — 这个名字现在归你'
    case 'granted-unconfirmed':
      return '已批准,但没有看到链上交易'
    case 'queued':
      return '已提交,等待审批'
    case 'rejected':
      return '这次申请没有通过'
  }
}

/** Whether the applicant now has a working name. Only one outcome qualifies. */
export function isNameUsable(outcome: Outcome): boolean {
  return outcome === 'granted'
}

/** What the applicant should do next — never empty, because "now what?" always has an answer. */
export function nextStep(outcome: Outcome, res: ApplyResponse): string {
  switch (outcome) {
    case 'granted':
      return '可以直接在钱包或 dApp 里使用了。下面可以验证解析是否已经生效。'
    case 'granted-unconfirmed':
      return '申请记录已经批准,但这套部署没有配置写入密钥,链上还没有这个名字 —— 请联系运营方。'
    case 'queued':
      return `记下申请号 ${res.id},审批之后可以用它查询结果。不需要一直开着这个页面。`
    case 'rejected':
      return res.reason ? `理由:${res.reason}` : '没有给出理由,可以联系运营方询问。'
  }
}

/** Result-panel rows for a submission. */
export function describeOutcome(res: ApplyResponse): ResultField[] {
  const outcome = classifyOutcome(res)
  const rows: ResultField[] = [
    { label: '名字', value: res.name, copy: true },
    { label: '归属', value: res.owner, copy: true },
    { label: '状态', value: outcomeHeadline(outcome) },
    { label: '下一步', value: nextStep(outcome, res) },
  ]
  if (res.txHash) rows.push({ label: '交易', value: res.txHash, copy: true })
  return rows
}

/**
 * What the page promises before the applicant signs.
 *
 * Under `manual` the submit button must not say "注册" — someone who signs expecting to walk
 * away with a name, and instead lands in a queue, was misled by the button.
 */
export function submitLabel(mode: ApprovalMode): string {
  return mode === 'manual' ? '提交申请' : '申请并领取名字'
}

export function modeNotice(mode: ApprovalMode): string {
  return mode === 'manual'
    ? '这个社区开启了人工审批:提交后由管理员决定,通过之后名字才会发放。'
    : '这个社区开启了自动发放:提交之后名字立即归你,不需要等待审批。'
}

/**
 * The EIP-712 message. Field-for-field identical to `Register` by design — the two are told
 * apart only by the primaryType in the struct hash, which is what stops an Apply signature
 * being replayed as a Register.
 */
export function buildApplyMessage(
  parent: string,
  label: string,
  owner: string,
  now = Date.now(),
): { parent: string; label: string; owner: string; nonce: bigint; deadline: bigint } {
  return {
    parent: parent.trim().toLowerCase(),
    label: label.trim().toLowerCase(),
    owner,
    nonce: BigInt(now),
    deadline: BigInt(Math.floor(now / 1000) + 600),
  }
}

export function serialiseApplyMessage(m: ReturnType<typeof buildApplyMessage>) {
  return { ...m, nonce: m.nonce.toString(), deadline: m.deadline.toString() }
}
