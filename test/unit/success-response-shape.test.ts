import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Every success response must state `ok` explicitly, never rely on a variable named `ok`.
 *
 * Seven write endpoints returned `json({ ok, action, txHash })` where no `ok` existed in scope —
 * a ReferenceError on every successful write. It arrived in #47, when
 * `const ok = await verifyTypedData(...)` was replaced by a void-returning helper and the
 * shorthand references were left behind.
 *
 * A per-endpoint test would have caught it only where someone wrote one: putting the bug back
 * into each of the seven, only `/register` went red — the one endpoint with a success assertion.
 * **They are not seven bugs; they are seven instances of one edit.** So the guard matches the
 * SHAPE, which covers the seven that exist and the eighth someone adds later.
 */
const WORKER = join(__dirname, '..', '..', 'workers', 'api', 'src', 'index.ts')

/** `json({ ok, …})` — shorthand, i.e. depending on a binding rather than stating the value. */
export const SHORTHAND_OK = /json\(\{\s*ok\s*[,}]/g

/** `json({ ok: true, …})` — the form that says what it means. */
export const EXPLICIT_OK = /json\(\{\s*ok:\s*(true|false)\b/g

describe('success responses state ok explicitly', () => {
  const source = readFileSync(WORKER, 'utf8')

  it('no response body relies on a shorthand `ok`', () => {
    expect(source.match(SHORTHAND_OK) ?? []).toEqual([])
  })

  it('the explicit form is actually in use (control)', () => {
    // Without this, deleting every `json({ ok … })` would satisfy the assertion above while
    // removing the responses entirely.
    expect((source.match(EXPLICIT_OK) ?? []).length).toBeGreaterThanOrEqual(7)
  })

  it('the shorthand matcher catches the real thing (must-fail control)', () => {
    // Synthetic, because the file is now clean — the criterion has to be runnable on the
    // present (docs/agent/practices.md「判据先约束现在」).
    expect('return json({ ok, action: "x" })'.match(SHORTHAND_OK)).toHaveLength(1)
    expect('return json({ ok })'.match(SHORTHAND_OK)).toHaveLength(1)
  })

  it('the explicit form is NOT flagged (control)', () => {
    // A matcher that also caught `ok: true` would fire on the fix and get itself deleted.
    expect('return json({ ok: true, action: "x" })'.match(SHORTHAND_OK)).toBeNull()
  })
})
