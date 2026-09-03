import { describe, it, expect } from 'vitest'
import {
  classifyOutcome, outcomeHeadline, isNameUsable, nextStep, describeOutcome,
  submitLabel, modeNotice, buildApplyMessage, serialiseApplyMessage,
  classifyModeProbe, canSubmit, probeNotice,
  type ApplyResponse,
} from '../../src/apply-flow'

const res = (over: Partial<ApplyResponse> = {}): ApplyResponse => ({
  id: 'app-1',
  name: 'alice.community.eth',
  owner: `0x${'11'.repeat(20)}`,
  status: 'approved',
  mode: 'auto',
  txHash: '0xdead',
  ...over,
})

describe('classifyOutcome — three outcomes that must not collapse', () => {
  it('approved with a tx is granted', () => {
    expect(classifyOutcome(res())).toBe('granted')
  })

  it('approved WITHOUT a tx is not the same thing', () => {
    // The API returns ok with no txHash when the writer key is unset. Treating it as a plain
    // success tells someone they own a name that was never written to the chain.
    expect(classifyOutcome(res({ txHash: undefined }))).toBe('granted-unconfirmed')
  })

  it('pending is queued', () => {
    expect(classifyOutcome(res({ status: 'pending', txHash: undefined }))).toBe('queued')
  })

  it('rejected is rejected even if a txHash somehow came back', () => {
    expect(classifyOutcome(res({ status: 'rejected' }))).toBe('rejected')
  })

  it('all four outcomes have DIFFERENT headlines (control)', () => {
    // Without this, an implementation that returned one cheerful message for everything would
    // pass every assertion above — each of them only checks one branch in isolation.
    const heads = (['granted', 'granted-unconfirmed', 'queued', 'rejected'] as const).map(outcomeHeadline)
    expect(new Set(heads).size).toBe(4)
  })
})

describe('isNameUsable — exactly one outcome means you have a name', () => {
  it('only granted', () => {
    expect(isNameUsable('granted')).toBe(true)
  })

  it('queued and unconfirmed do NOT count', () => {
    // These are the two that look like success from a distance and are not.
    expect(isNameUsable('queued')).toBe(false)
    expect(isNameUsable('granted-unconfirmed')).toBe(false)
    expect(isNameUsable('rejected')).toBe(false)
  })
})

describe('nextStep — never leaves the applicant without an action', () => {
  it('gives a non-empty instruction for every outcome (control)', () => {
    for (const o of ['granted', 'granted-unconfirmed', 'queued', 'rejected'] as const) {
      expect(nextStep(o, res()).length).toBeGreaterThan(0)
    }
  })

  it('tells a queued applicant their application id', () => {
    // Without the id they have no way to ask about it later, and there is no account to log in to.
    expect(nextStep('queued', res({ id: 'xyz-9', status: 'pending' }))).toContain('xyz-9')
  })

  it('surfaces the rejection reason when there is one', () => {
    expect(nextStep('rejected', res({ status: 'rejected', reason: '保留名' }))).toContain('保留名')
  })

  it('says something useful when a rejection has no reason', () => {
    expect(nextStep('rejected', res({ status: 'rejected' }))).toMatch(/联系/)
  })

  it('the unconfirmed step says the chain does NOT have the name', () => {
    // The headline alone is ambiguous; this is the line that prevents someone handing the
    // name out and discovering it resolves to nothing.
    expect(nextStep('granted-unconfirmed', res({ txHash: undefined }))).toMatch(/链上还没有/)
  })
})

describe('describeOutcome', () => {
  it('always carries name, owner, status and next step', () => {
    expect(describeOutcome(res()).map((r) => r.label)).toEqual(
      expect.arrayContaining(['名字', '归属', '状态', '下一步']),
    )
  })

  it('omits the tx row when there is no transaction', () => {
    expect(describeOutcome(res({ txHash: undefined })).some((r) => r.label === '交易')).toBe(false)
  })
})

describe('the page states the mode BEFORE the signature', () => {
  it('manual does not promise a name on the button', () => {
    // Someone who signs expecting to walk away with a name, and lands in a queue instead,
    // was misled by the button.
    expect(submitLabel('manual')).not.toMatch(/领取/)
    expect(submitLabel('manual')).toContain('申请')
  })

  it('auto and manual differ in both button and notice (control)', () => {
    expect(submitLabel('auto')).not.toBe(submitLabel('manual'))
    expect(modeNotice('auto')).not.toBe(modeNotice('manual'))
  })

  it('the manual notice says approval is required', () => {
    expect(modeNotice('manual')).toMatch(/审批/)
  })
})

describe('buildApplyMessage — matches the Apply typed-data schema', () => {
  it('normalises parent and label to lowercase', () => {
    const m = buildApplyMessage('  Community.ETH ', ' Alice ', '0xabc')
    expect(m.parent).toBe('community.eth')
    expect(m.label).toBe('alice')
  })

  it('has exactly the five fields Apply declares (control)', () => {
    // Apply and Register are field-for-field identical; they are told apart only by the
    // primaryType in the struct hash. A missing field breaks verification silently.
    expect(Object.keys(buildApplyMessage('p', 'l', '0x1')).sort()).toEqual(
      ['deadline', 'label', 'nonce', 'owner', 'parent'].sort(),
    )
  })

  it('serialises bigints for transport, and the raw form does not (control)', () => {
    const m = buildApplyMessage('p', 'l', '0x1')
    expect(() => JSON.stringify(m)).toThrow()
    expect(() => JSON.stringify(serialiseApplyMessage(m))).not.toThrow()
  })
})

describe('an API without application support must not silently fall back', () => {
  // The live testnet API returns 404 for /apply and /approval-mode today: the frontend can
  // ship before the worker is redeployed. Falling back to /register would "work" — and would
  // grant immediately, bypassing the approval this page exists to route through.
  it('404 is unsupported, not unknown', () => {
    expect(classifyModeProbe(404, null)).toEqual({ kind: 'unsupported' })
  })

  it('a 5xx or network failure is unknown, not unsupported', () => {
    // Different facts: one says "this deployment cannot do it", the other "we could not tell".
    expect(classifyModeProbe(503, null).kind).toBe('unknown')
  })

  it('a 200 with an unrecognised mode is unknown, not a default', () => {
    expect(classifyModeProbe(200, { mode: 'whatever' }).kind).toBe('unknown')
  })

  it('reads a valid mode', () => {
    expect(classifyModeProbe(200, { mode: 'manual' })).toEqual({ kind: 'ok', mode: 'manual' })
  })

  it('ONLY a known mode allows submitting (control)', () => {
    // Without this, defaulting unsupported/unknown to 'manual' would look safe while still
    // letting the applicant sign something the API cannot accept.
    expect(canSubmit({ kind: 'ok', mode: 'manual' })).toBe(true)
    expect(canSubmit({ kind: 'unsupported' })).toBe(false)
    expect(canSubmit({ kind: 'unknown' })).toBe(false)
  })

  it('each probe state explains itself differently (control)', () => {
    const notices = [
      probeNotice({ kind: 'ok', mode: 'auto' }),
      probeNotice({ kind: 'unsupported' }),
      probeNotice({ kind: 'unknown' }),
    ]
    expect(new Set(notices).size).toBe(3)
    expect(notices.every((n) => n.length > 0)).toBe(true)
  })

  it('the unsupported notice says the signature would be wasted', () => {
    expect(probeNotice({ kind: 'unsupported' })).toMatch(/白签|无法|不支持/)
  })
})
