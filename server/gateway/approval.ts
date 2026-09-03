/**
 * Application → approval → grant.
 *
 * Subdomains are GRANTED, not self-registered (see docs/agent/acceptance.md). Two paths lead
 * to a grant: an upstream system calling the API, or a person applying. This module covers
 * the second, and makes the approval step configurable rather than assumed:
 *
 *   APPROVAL_MODE=auto    — approve on submission. Equivalent to the open self-service the
 *                           deployed worker does today, so this is the DEFAULT and existing
 *                           deployments behave identically after upgrading.
 *   APPROVAL_MODE=manual  — queue it; an admin decides.
 *
 * "auto" is not a lesser mode: an operator who wants to hand names to anyone freely should
 * not have to click a button per person. The point is that the choice is explicit.
 *
 * The logic here is pure so it can be tested without a Workers runtime. Storage and auth live
 * in the worker.
 */

export type ApprovalMode = 'auto' | 'manual'
export type ApplicationStatus = 'pending' | 'approved' | 'rejected'

export interface Application {
  id: string
  label: string
  parent: string
  owner: string
  status: ApplicationStatus
  createdAt: number
  /** Set when an admin decides. Absent while pending. */
  decidedAt?: number
  decidedBy?: string
  /** Free-text reason supplied on rejection. */
  reason?: string
  /** Set once the grant transaction lands. */
  txHash?: string
  name: string
}

export class ApprovalError extends Error {
  constructor(message: string, readonly status: number, readonly hint?: string) {
    super(message)
  }
}

const LABEL_RE = /^[a-z0-9-]{1,63}$/
const NAME_RE = /^([a-z0-9-]+\.)+eth$/
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

/**
 * Read the mode from the environment.
 *
 * An unrecognised value is rejected rather than silently treated as `auto`: a typo like
 * `APPROVAL_MODE=manaul` would otherwise quietly hand out every name the operator meant to
 * review, and nothing would look wrong.
 */
export function resolveMode(raw: string | undefined): ApprovalMode {
  if (raw === undefined || raw === '') return 'auto'
  if (raw === 'auto' || raw === 'manual') return raw
  throw new ApprovalError(
    `Invalid APPROVAL_MODE "${raw}"`,
    503,
    'expected "auto" or "manual" — refusing to guess, because guessing wrong hands out names you meant to review',
  )
}

/** Deterministic id, so a resubmission of the same name is recognisable as a duplicate. */
export function applicationId(parent: string, label: string): string {
  return `${label.trim().toLowerCase()}.${parent.trim().toLowerCase()}`
}

export interface SubmitInput {
  label?: string
  parent?: string
  owner?: string
}

/** Validate a submission and build the record. Throws ApprovalError with a usable message. */
export function buildApplication(input: SubmitInput, allowedParents: string[], now: number): Application {
  const label = input.label?.trim().toLowerCase() ?? ''
  const parent = input.parent?.trim().toLowerCase() ?? ''
  const owner = input.owner?.trim() ?? ''

  if (!LABEL_RE.test(label)) {
    throw new ApprovalError('Invalid label', 400, '1–63 characters, lowercase letters, digits and hyphens only')
  }
  if (!NAME_RE.test(parent)) {
    throw new ApprovalError('Invalid parent domain', 400, 'expected a lowercase .eth name, e.g. community.eth')
  }
  if (!allowedParents.map((p) => p.toLowerCase()).includes(parent)) {
    throw new ApprovalError(`Parent "${parent}" is not served by this deployment`, 400, `configured: ${allowedParents.join(', ') || '(none)'}`)
  }
  if (!ADDRESS_RE.test(owner)) {
    throw new ApprovalError('Invalid owner address', 400, 'the name will be minted to this address')
  }

  return {
    id: applicationId(parent, label),
    label,
    parent,
    owner,
    name: `${label}.${parent}`,
    status: 'pending',
    createdAt: now,
  }
}

/**
 * What to do with a freshly built application.
 *
 * Returns the action rather than performing it, so the decision is testable without a chain
 * or a KV binding.
 */
export function decideOnSubmit(mode: ApprovalMode): 'grant' | 'queue' {
  return mode === 'auto' ? 'grant' : 'queue'
}

/**
 * Guard a resubmission.
 *
 * A pending duplicate is NOT an error — telling someone "already applied" is the answer they
 * need, and returning 409 would push callers into retry loops. A decided application is
 * different: silently reopening it would undo an admin's rejection.
 */
export function checkResubmission(existing: Application | null): { ok: true } | { ok: false; error: ApprovalError } {
  if (!existing) return { ok: true }
  if (existing.status === 'pending') {
    return { ok: false, error: new ApprovalError('An application for this name is already pending', 409, 'wait for it to be reviewed') }
  }
  if (existing.status === 'approved') {
    return { ok: false, error: new ApprovalError('This name has already been granted', 409, `it belongs to ${existing.owner}`) }
  }
  return {
    ok: false,
    error: new ApprovalError('A previous application for this name was rejected', 409, existing.reason ? `reason: ${existing.reason}` : 'ask the operator to reopen it'),
  }
}

/**
 * Apply an admin decision.
 *
 * Only a pending application can be decided. Re-deciding is refused rather than tolerated:
 * flipping an approved application to rejected would leave the name already minted while the
 * record says otherwise, and the two would disagree forever.
 */
export function applyDecision(
  application: Application,
  decision: 'approve' | 'reject',
  actor: string,
  now: number,
  reason?: string,
): Application {
  if (application.status !== 'pending') {
    throw new ApprovalError(
      `Application is already ${application.status}`,
      409,
      'a decided application cannot be decided again — the on-chain state would no longer match',
    )
  }
  return {
    ...application,
    status: decision === 'approve' ? 'approved' : 'rejected',
    decidedAt: now,
    decidedBy: actor,
    ...(decision === 'reject' && reason ? { reason } : {}),
  }
}

/** KV key for an application. Namespaced so it cannot collide with the address→names registry. */
export function applicationKey(id: string): string {
  return `app:${id}`
}

/** KV key prefix for listing the queue. */
export const APPLICATION_PREFIX = 'app:'

/** Public view of an application — never leaks internal fields. */
export function publicView(a: Application): Record<string, unknown> {
  return {
    id: a.id,
    name: a.name,
    owner: a.owner,
    status: a.status,
    createdAt: a.createdAt,
    ...(a.decidedAt ? { decidedAt: a.decidedAt } : {}),
    ...(a.reason ? { reason: a.reason } : {}),
    ...(a.txHash ? { txHash: a.txHash } : {}),
  }
}

/**
 * Who may decide on an application.
 *
 * Same rule as registrar management: the contract owner, and nobody else. Kept as a pure
 * function so "an unauthorised caller cannot approve" is a unit test rather than a claim —
 * the worker still has to verify the signature before calling this, and that check lives
 * where the crypto is.
 */
export function isAuthorisedApprover(caller: string | undefined, contractOwner: string | undefined): boolean {
  if (!caller || !contractOwner) return false
  if (!ADDRESS_RE.test(caller) || !ADDRESS_RE.test(contractOwner)) return false
  return caller.toLowerCase() === contractOwner.toLowerCase()
}
