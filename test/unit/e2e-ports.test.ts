import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Every e2e file must spawn anvil on a port no other file uses.
 *
 * vitest runs test files in parallel. Two files on one port means the second anvil fails to
 * bind, its client silently talks to the first file's chain, and both send transactions from
 * the same well-known accounts — `NonceTooLowError`, intermittently.
 *
 * This became worth guarding the day the suite turned into a merge gate (#58): a gate that
 * goes red at random teaches people to re-run until it is green, and that action is
 * indistinguishable from ignoring a real failure.
 *
 * "Is there a duplicate" is a question about the whole set, so the extraction has to see every
 * port — I first grepped `ANVIL_PORT = N` and missed ccip.test.ts entirely, which uses L1_PORT
 * and L2_PORT. Anchoring on the `--port` ARGUMENT is what makes the scope match the question
 * (docs/agent/practices.md「取证规程」).
 */
const E2E_DIR = join(__dirname, '..', 'e2e')

/** Ports as actually passed to anvil, resolved through the constant each file names. */
export function portsIn(source: string): number[] {
  const consts = new Map<string, number>()
  for (const m of source.matchAll(/const\s+([A-Z_][A-Z_0-9]*)\s*=\s*(\d{4,5})\b/g)) {
    consts.set(m[1], Number(m[2]))
  }
  const out: number[] = []
  for (const m of source.matchAll(/'--port',\s*(?:String\(([A-Z_][A-Z_0-9]*)\)|'?(\d{4,5})'?)/g)) {
    if (m[2]) out.push(Number(m[2]))
    else if (m[1] && consts.has(m[1])) out.push(consts.get(m[1])!)
    else out.push(NaN) // a port we could not resolve — surfaced by the test below
  }
  return out
}

const files = readdirSync(E2E_DIR).filter((f) => f.endsWith('.test.ts'))

describe('e2e anvil ports are unique across files', () => {
  const byFile = new Map(files.map((f) => [f, portsIn(readFileSync(join(E2E_DIR, f), 'utf8'))]))

  /**
   * e2e files that legitimately spawn no anvil of their own.
   *
   * Without this list the guard has a blind spot it cannot see into: a file that starts anvil
   * through a helper contains no literal `'--port'`, so it lands in neither `spawners` nor
   * `byFile` — and "no duplicates" is then vacuously true FOR THAT FILE. Membership is
   * verified below, so an entry cannot quietly cover a file that does spawn one.
   */
  const NO_ANVIL: string[] = []

  it('every e2e file either spawns anvil or is on the exempt list', () => {
    // Closes the "invisible to both halves" gap: a new file that starts anvil some other way
    // is neither scanned nor exempt, so it fails here rather than silently passing.
    const spawners = files.filter((f) => readFileSync(join(E2E_DIR, f), 'utf8').includes("'--port'"))
    const unaccounted = files.filter((f) => !spawners.includes(f) && !NO_ANVIL.includes(f))
    expect(unaccounted).toEqual([])

    // A count, not a floor. `>= 5` sat exactly at today's value of 6 — a bound equal to the
    // present cannot detect shrinkage, and this is the third time (see #48, #56).
    expect(spawners).toHaveLength(6)
  })

  it('every exempt entry really contains no --port (control)', () => {
    // A stale exemption is a hole standing open for whatever lands in that file next.
    const wrong = NO_ANVIL.filter((f) => readFileSync(join(E2E_DIR, f), 'utf8').includes("'--port'"))
    expect(wrong).toEqual([])
  })

  it('every spawning file yields at least one resolvable port (control)', () => {
    // Without this, an extraction that matched nothing would make "no duplicates" vacuous —
    // and that is exactly how the first version of this scan missed ccip.test.ts.
    const spawners = files.filter((f) => readFileSync(join(E2E_DIR, f), 'utf8').includes("'--port'"))
    for (const f of spawners) {
      expect({ f, n: byFile.get(f)!.length }).not.toMatchObject({ n: 0 })
      expect({ f, unresolved: byFile.get(f)!.filter(Number.isNaN).length }).toMatchObject({ unresolved: 0 })
    }
  })

  it('ccip.test.ts contributes its two ports (control)', () => {
    // Named because it is the file the naive `ANVIL_PORT = N` grep silently dropped: it uses
    // L1_PORT and L2_PORT. If the extraction narrows again, this is what says so.
    expect(byFile.get('ccip.test.ts')!.length).toBeGreaterThanOrEqual(2)
  })

  it('no port is used by two files', () => {
    const seen = new Map<number, string[]>()
    for (const [f, ports] of byFile) {
      for (const p of ports) seen.set(p, [...(seen.get(p) ?? []), f])
    }
    const shared = [...seen.entries()].filter(([, fs]) => new Set(fs).size > 1)
    expect(shared.map(([p, fs]) => `${p}: ${[...new Set(fs)].join(' + ')}`)).toEqual([])
  })
})
