import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The reject-reason box must stay per-card, not a shared element in the HTML.
 *
 * `renderQueue` creates one input inside each card's loop iteration and the click handler
 * reads it through the lexical closure, so today the property holds structurally — there is no
 * shared element to collide over. What would break it is a refactor to "put a fixed id in
 * admin.html and read it with byId": one operator's typed reason would then attach to
 * whichever application they clicked second.
 *
 * So the guard targets that refactor rather than trying to test the DOM (this repo has no DOM
 * environment — FU-8). pr-daemon's framing: write down what would break the property, and
 * assert THAT.
 */
const HTML = readFileSync(join(__dirname, '..', '..', 'admin.html'), 'utf8')

function ids(): string[] {
  return [...HTML.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1])
}

describe('the reject reason has no shared element to collide over', () => {
  it('admin.html declares no id containing "reason"', () => {
    expect(ids().filter((id) => /reason/i.test(id))).toEqual([])
  })

  it('the id scan actually finds ids (control)', () => {
    // Without this, a regex that matched nothing would make the assertion above vacuous —
    // "no id contains reason" is trivially true of an empty list.
    expect(ids().length).toBeGreaterThan(20)
    expect(ids()).toContain('queueList')
  })

  it('the reason input is created in the render loop, not looked up (control)', () => {
    // The other half of the property: it must be constructed per card. If this moved to a
    // byId() lookup the assertion above would still pass, because the id could live in JS.
    const SRC = readFileSync(join(__dirname, '..', '..', 'src', 'admin-queue.ts'), 'utf8')
    expect(SRC).toMatch(/createElement\('input'\)/)
    expect(SRC).not.toMatch(/byId\([^)]*reason/i)
  })
})
