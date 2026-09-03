import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Guards the seam between the HTML and the TypeScript that drives it.
 *
 * `byId()` returns null when an element is absent, and every call site uses `?.` — so a
 * renamed or deleted id does not throw, it makes the button do NOTHING. No existing check
 * covers this: the build does not relate HTML to TS, typecheck cannot see across the seam,
 * and the unit tests only touch pure functions.
 *
 * This is not hypothetical. Rewriting admin.html for T1.1.4 dropped `l1Chain` and changed a
 * `<select>` option value from `l1` to `gateway`; the first silently disabled the L1 network
 * picker and the second made "query via L1" silently query L2 instead. Both built cleanly.
 */

const ROOT = join(__dirname, '../..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

/**
 * Strip comments before any extraction.
 *
 * Without this the checks below are wrong in both directions: a commented-out `byId('x')`
 * invents a requirement that does not exist, and — worse — a comment merely *mentioning*
 * `el.id = 'querySource'` silently exempts a genuinely missing id. Verified: renaming an id
 * made the suite fail, and adding one comment line made it pass again.
 *
 * This is the same root cause as the acceptance command that scans admin.ts for `alert(` and
 * cannot tell code from a comment describing it.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/**
 * ids the script actually looks up.
 *
 * Covers the result-panel helpers as well as raw byId: showResult/clearResult take an id and
 * do `byId(elId); if (!el) return` internally — the exact silent no-op this file guards
 * against. Matching only literal `byId(...)` left all eight result containers uncovered,
 * i.e. the guard claimed more than it verified.
 */
function referencedIds(tsRaw: string): Set<string> {
  const ts = stripComments(tsRaw)
  const ids = new Set<string>()
  const pattern = /(?:byId(?:<[^>]*>)?|getElementById|showResult|clearResult)\(\s*['"]([A-Za-z0-9_-]+)['"]/g
  for (const m of ts.matchAll(pattern)) ids.add(m[1])
  return ids
}

function declaredIds(html: string): Set<string> {
  return new Set([...html.matchAll(/id="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]))
}

/**
 * ids the script creates itself (`el.id = 'x'`) when the element is absent.
 *
 * Without this the check is WRONG, not merely strict: register.ts legitimately builds
 * `existingBanner` and `resolveCountdown` on demand, and flagging them would report a fault
 * that does not exist. Found by this test's own first run — the judge was the broken part.
 */
function selfCreatedIds(tsRaw: string): Set<string> {
  const ts = stripComments(tsRaw)
  return new Set([...ts.matchAll(/\.id\s*=\s*['"]([A-Za-z0-9_-]+)['"]/g)].map((m) => m[1]))
}

const PAGES: Array<[string, string]> = [
  ['admin.html', 'src/admin.ts'],
  ['register.html', 'src/register.ts'],
  ['box.html', 'src/main.ts'],
]

describe.each(PAGES)('%s ↔ %s wiring', (htmlPath, tsPath) => {
  const html = read(htmlPath)
  const ts = read(tsPath)

  it('every id the script looks up exists in the markup', () => {
    const declared = declaredIds(html)
    const selfMade = selfCreatedIds(ts)
    const missing = [...referencedIds(ts)].filter((id) => !declared.has(id) && !selfMade.has(id))
    // Named in the message: "missing: []" is useless when it fails at 3am.
    expect(missing, `${tsPath} looks up ids absent from ${htmlPath}`).toEqual([])
  })

  it('dynamically created ids are recognised, not flagged', () => {
    // Control for the exemption above: if selfCreatedIds ever stops matching, the check would
    // start reporting phantom faults and the exemption would look like it was never needed.
    const sample = "const n = document.createElement('div'); n.id = 'someDynamicId'"
    expect(selfCreatedIds(sample).has('someDynamicId')).toBe(true)
  })

  it('ids used via showResult/clearResult are covered too', () => {
    // These helpers hide a byId() call behind a parameter. Before this, admin.ts's eight
    // result containers were outside the guard entirely.
    if (tsPath !== 'src/admin.ts') return
    const ids = referencedIds(ts)
    expect(ids.has('registerResult')).toBe(true)
    expect(ids.has('transferSubdomainResult')).toBe(true)
  })

  it('comments cannot create or exempt a requirement', () => {
    const commented = "// byId('ghostId')\n/* clearResult('anotherGhost') */"
    expect(referencedIds(commented).size).toBe(0)
    const fakeExempt = "// this mentions el.id = 'notReallyCreated'"
    expect(selfCreatedIds(fakeExempt).size).toBe(0)
    // Control: real code is still seen after stripping.
    expect(referencedIds("byId('realId')").has('realId')).toBe(true)
    expect(selfCreatedIds("n.id = 'realCreated'").has('realCreated')).toBe(true)
  })

  it('the extractor actually finds ids (must-find control)', () => {
    // Without this, an extractor that silently matches nothing would make the check above
    // pass on any input — the vacuous-assertion trap.
    expect(referencedIds(ts).size).toBeGreaterThan(0)
    expect(declaredIds(html).size).toBeGreaterThan(0)
  })
})

describe('admin.html ↔ admin.ts option values', () => {
  // A `<select>` whose option values do not match the strings the code compares against is
  // the same silent failure one level down: the control works, it just does the wrong thing.
  const html = read('admin.html')
  const ts = read('src/admin.ts')

  it('querySource offers the value the code branches on', () => {
    expect(ts).toMatch(/querySource/)
    expect(ts).toContain("'l1'")
    expect(html).toContain('value="l1"')
  })

  it('l1Chain offers the value the code branches on', () => {
    expect(ts).toContain("'mainnet'")
    expect(html).toContain('value="mainnet"')
  })
})

describe('pages use the design system rather than their own palette', () => {
  // T1.1.1 made design-system.css the single source of styling truth. Nothing enforced it,
  // so a page could quietly reintroduce its own colours and still build.
  it.each(['index.html', 'admin.html'])('%s links the design system', (page) => {
    expect(read(page)).toContain('design-system.css')
  })

  it.each(['index.html', 'admin.html'])('%s declares no raw hex colours', (page) => {
    // Layout glue in a page <style> is fine; colour is not — that is what tokens are for.
    const styleBlocks = [...read(page).matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n')
    expect(styleBlocks.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([])
  })

  it('the hex detector works (must-find control)', () => {
    expect('color: #ff0000;'.match(/#[0-9a-fA-F]{3,8}\b/g)).not.toBeNull()
  })
})
