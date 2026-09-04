import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
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

/**
 * Pages are DERIVED from vite.config.ts, not listed here.
 *
 * A hardcoded list means every new page starts outside the guard, and nothing says so — the
 * suite stays green while the newest page is the least checked. lookup.html was added and
 * silently fell outside exactly this way. Deriving from the build config makes coverage
 * follow the app instead of trailing it.
 */
function pagesFromViteConfig(): Array<[string, string]> {
  const cfg = readFileSync(join(ROOT, 'vite.config.ts'), 'utf8')
  const htmlFiles = [...cfg.matchAll(/['"]([a-z0-9-]+\.html)['"]/g)].map((m) => m[1])
  const pairs: Array<[string, string]> = []
  for (const html of new Set(htmlFiles)) {
    // Find the module the page actually loads, rather than guessing from the filename:
    // index.html has no script, box.html loads src/main.ts.
    const page = readFileSync(join(ROOT, html), 'utf8')
    const script = page.match(/<script[^>]*src="\/(src\/[A-Za-z0-9_.-]+\.ts)"/)
    if (script) pairs.push([html, script[1]])
  }
  return pairs
}

const PAGES: Array<[string, string]> = pagesFromViteConfig()

describe('page list is derived, not hardcoded', () => {
  it('covers every entry page that loads a module', () => {
    // Control: if the derivation silently found nothing, every wiring test below would
    // vacuously pass by never running.
    expect(PAGES.length).toBeGreaterThanOrEqual(3)
    expect(PAGES.map(([h]) => h)).toContain('admin.html')
  })
})

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

  it('the page declares ids at all (must-find control)', () => {
    // Without this, `missing` above is empty for the boring reason.
    expect(declaredIds(html).size).toBeGreaterThan(0)
  })
})

describe('the id extractor is not silently broken', () => {
  // This used to be asserted per page — `referencedIds(ts).size > 0` for EVERY entry — which
  // conflated two different claims:
  //   (a) the extractor works                     ← what the control is for
  //   (b) this particular file looks up ids       ← not required, and now false
  //
  // `src/i18n.ts` is the first entry that legitimately references none: it swaps text by
  // `data-i18n` attribute and never calls `byId`. Keeping the per-page form would have forced
  // either a fake id lookup or an exemption, and both are worse than asking the question where
  // it belongs — of the extractor, and of the corpus as a whole.

  it('finds ids in a known input', () => {
    expect(referencedIds("byId('realId')").has('realId')).toBe(true)
  })

  it('at least one page entry does look ids up', () => {
    // The corpus-level version of the old assertion: if the extractor broke, EVERY pair would
    // report zero and this goes red — while a single attribute-driven module does not.
    const total = PAGES.reduce((n, [, tsPath]) => n + referencedIds(read(tsPath)).size, 0)
    expect(total).toBeGreaterThan(0)
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
  //
  // Not every page is migrated yet. Rather than dropping the check or letting it fail, the
  // un-migrated pages are named here with the task that will fix them. The list is asserted
  // to be accurate in both directions below, so it cannot quietly hide a regression: a page
  // that HAS been migrated may not sit in it.
  const PENDING = new Set([
    'register.html', // T1.6.2 rewrites this page as the application form
    'box.html', // .box manager — out of the M1 product-isation scope
  ])
  const allPages = [...new Set(PAGES.map(([h]) => h).concat('index.html'))]
  const migrated = allPages.filter((p) => !PENDING.has(p))

  it.each(migrated)('%s links the design system', (page) => {
    expect(read(page)).toContain('design-system.css')
  })

  it.each(migrated)('%s declares no raw hex colours', (page) => {
    // Layout glue in a page <style> is fine; colour is not — that is what tokens are for.
    const styleBlocks = [...read(page).matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n')
    expect(styleBlocks.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([])
  })

  it('the pending list is accurate — no migrated page hides in it', () => {
    // Without this the list becomes a place to silence failures: adding a page here would
    // exempt it forever, including after it was migrated and then regressed.
    const wronglyPending = [...PENDING].filter((p) => read(p).includes('design-system.css'))
    expect(wronglyPending, 'these pages ARE migrated and should be removed from PENDING').toEqual([])
  })

  it('the hex detector works (must-find control)', () => {
    expect('color: #ff0000;'.match(/#[0-9a-fA-F]{3,8}\b/g)).not.toBeNull()
  })
})

describe('pages do not link to files that are not there', () => {
  // The landing page is the front door; a dead link there is the worst place to have one,
  // and nothing else looks at HTML hrefs — the build happily emits them, and docs-links only
  // covers markdown.
  const ALL_HTML = [...new Set(PAGES.map(([h]) => h).concat('index.html'))]

  /** Root-relative hrefs/srcs pointing at repo files. External URLs and anchors are skipped. */
  function localRefs(html: string): string[] {
    return [...html.matchAll(/(?:href|src)="(\/[^"#?]+)"/g)]
      .map((m) => m[1])
      .filter((h) => !h.startsWith('//'))
  }

  it.each(ALL_HTML)('%s links only to files that exist', (page) => {
    const missing = localRefs(read(page)).filter((h) => !existsSync(join(ROOT, h.replace(/^\//, ''))))
    expect(missing, `${page} points at files that are not in the repo`).toEqual([])
  })

  it('the extractor finds refs, and would flag a bad one (controls)', () => {
    // Two controls: it must see real refs, and it must reject a fabricated one — otherwise
    // "no missing links" could just mean "found nothing to check".
    expect(localRefs('<a href="/lookup.html">x</a>')).toEqual(['/lookup.html'])
    expect(localRefs('<a href="https://example.com/x">x</a>')).toEqual([])
    expect(
      localRefs('<a href="/definitely-not-here.html">x</a>').filter(
        (h) => !existsSync(join(ROOT, h.replace(/^\//, ''))),
      ),
    ).toEqual(['/definitely-not-here.html'])
  })
})
