import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Contract addresses in docs must not silently point at a dead deployment.
 *
 * This repo has shipped that bug twice. It is nastier than a broken link: the superseded
 * L2Records at 0x9Ed5d101… STILL HAS CODE, so someone integrating against it gets no error —
 * every lookup just returns nothing, and they debug their own code for an afternoon.
 *
 * The rule is deliberately NARROW, because the first version was not and it flagged nine
 * files of legitimate content: third-party addresses (the ENS registry, unruggable's
 * verifiers), mainnet runbook constants, and history tables that are supposed to be history.
 * A guard that red for that much gets switched off, which is worse than not having one.
 *
 * So it fires only on the exact shape of the bug: a line naming one of OUR OWN contracts,
 * carrying an address this deployment does not use, with no nearby marker saying it is past.
 */
const ROOT = join(__dirname, '..', '..')

/** The one true source, per README and check:chain. */
function liveAddresses(): string[] {
  const out: string[] = []
  for (const w of ['workers/api/wrangler.toml', 'workers/gateway/wrangler.toml']) {
    const toml = readFileSync(join(ROOT, w), 'utf8')
    // Every address the deployment actually uses, whatever variable holds it — the resolver
    // lives in ALLOWED_SENDERS, not a RESOLVER_ADDRESS, and hardcoding names missed it.
    for (const m of toml.matchAll(/=\s*"(0x[0-9a-fA-F]{40})"/g)) out.push(m[1].toLowerCase())
  }
  return [...new Set(out)]
}

/**
 * The markdown section containing line `i`: from the nearest preceding heading up to the next
 * heading of the same or higher level. Falls back to the whole file when there are no headings.
 */
export function sectionAround(lines: string[], i: number): string {
  return sectionBefore(lines, i, /* upToLine */ lines.length)
}

/**
 * The part of the enclosing section from its heading down to (and including) line `i`.
 *
 * The marker must come BEFORE the address, not merely somewhere in the same section. Same
 * criterion pr-daemon applied to the landing page: what matters is not whether the qualifier
 * exists, but whether the reader meets it before forming the conclusion. It also closes the
 * one-section-per-file case — a document with a single heading would otherwise let a
 * disclaimer at the bottom excuse every address above it.
 */
export function sectionBefore(lines: string[], i: number, upToLine = i + 1): string {
  let start = 0
  let level = 0
  for (let j = i; j >= 0; j--) {
    const m = /^(#{1,6})\s/.exec(lines[j])
    if (m) {
      start = j
      level = m[1].length
      break
    }
  }
  let end = Math.min(upToLine, lines.length)
  for (let j = start + 1; j < end; j++) {
    const m = /^(#{1,6})\s/.exec(lines[j])
    if (m && m[1].length <= level) {
      end = j
      break
    }
  }
  return lines.slice(start, end).join('\n')
}

function docFiles(): string[] {
  const files = ['README.md']
  for (const d of ['docs', 'docs/agent']) {
    for (const f of readdirSync(join(ROOT, d))) {
      if (f.endsWith('.md')) files.push(`${d}/${f}`)
    }
  }
  return files
}

/** Our own contracts. A third-party address on a line that never names one is not our claim. */
export const OURS = /L2Records|L2RecordsV[23]|HybridResolver|OPResolver|OffchainResolver/i

/**
 * Phrases that actually say "this address is past", not words that merely tend to appear near
 * one. The first version accepted a bare 旧 / 历史 / 此前 / 当时, and pr-daemon showed that
 * "我们从**旧**版工具链迁移过来" next to a stale address made the guard pass — those words are
 * too ordinary in Chinese technical prose to carry the claim.
 *
 * Tightening it and re-running is also how you check whether the current exemptions are
 * EARNED: the corpus stayed green under the stricter list, so nothing was hiding behind the
 * loose one.
 */
export const HISTORY_MARKER =
  /旧地址|旧的部署|已被取代|已废弃|不是现值|不再使用|早已不是|当时的部署|当时的地址|历史记录|superseded|deprecated|no longer (?:in )?use|not current/i

describe('docs never present a superseded contract address as current', () => {
  const live = liveAddresses()

  it('wrangler.toml actually yields addresses (control)', () => {
    // Without this, a parsing failure would make every check below vacuously pass.
    expect(live.length).toBeGreaterThan(0)
    expect(live.every((a) => /^0x[0-9a-f]{40}$/.test(a))).toBe(true)
  })

  for (const file of docFiles()) {
    const text = readFileSync(join(ROOT, file), 'utf8')
    const lines = text.split('\n')
    const addressed = lines
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => /0x[0-9a-fA-F]{40}/.test(line) && OURS.test(line))
    if (!addressed.length) continue

    it(`${file} marks every non-live address as historical`, () => {
      const offenders: string[] = []
      for (const { line, i } of addressed) {
        for (const m of line.matchAll(/0x[0-9a-fA-F]{40}/g)) {
          const addr = m[0].toLowerCase()
          if (live.includes(addr)) continue
          // Scope is the enclosing markdown SECTION, not a fixed line window.
          //
          // A 12-line window false-POSITIVED on a 22-line history table whose marker sits in
          // the heading: legitimate content judged a violation. That is the worse failure —
          // by the same reasoning that made the first version too broad, a guard that flags
          // correct docs gets switched off, and then the false negatives stop being caught
          // too. A section is also the unit a human actually writes the disclaimer for.
          const context = sectionBefore(lines, i)
          if (!HISTORY_MARKER.test(context)) offenders.push(`${file}:${i + 1}  ${addr}`)
        }
      }
      expect(offenders).toEqual([])
    })
  }

  it('the marker regex does NOT match ordinary prose (control)', () => {
    // Without this, a marker pattern loose enough to match anything would green the whole file.
    expect(HISTORY_MARKER.test('部署在 Ethereum Sepolia，供第三方集成使用。')).toBe(false)
  })

  it('an unmarked address on one of OUR contract lines WOULD be caught (must-fail control)', () => {
    // Proves the detection is real rather than the corpus simply being clean: this synthetic
    // line satisfies all three conditions at once.
    const fake = `0x${'ab'.repeat(20)}`
    const line = `L2Records (OP Sepolia) | \`${fake}\``
    expect(OURS.test(line)).toBe(true)
    expect(live.includes(fake.toLowerCase())).toBe(false)
    expect(HISTORY_MARKER.test(line)).toBe(false)
  })

  it('a third-party address is NOT our claim (control)', () => {
    // The ENS registry appears in the mainnet runbook and is not ours to keep current.
    expect(OURS.test('ENS Registry | 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e')).toBe(false)
  })

  it('the live set covers the resolver too (control)', () => {
    // The first version only read L2_RECORDS_ADDRESS/RESOLVER_ADDRESS and so declared the
    // HybridResolver — which README correctly presents as current — a stale address.
    expect(live).toContain('0xa54d63a6223b66eded35286522336e45f21be512')
  })
})

describe('the marker scope is the section, not a line window', () => {
  // pr-daemon's counter-example: a 22-line history table whose disclaimer sits in the heading.
  // A fixed window loses the marker and reports legitimate content as a violation.
  const longTable = [
    '# 历史部署记录',
    '',
    '> 下表是当时的部署,不是现值。',
    '',
    '| 合约 | 地址 |',
    ...Array.from({ length: 18 }, (_, n) => `| L2Records v${n} | \`0x${'cd'.repeat(20)}\` |`),
  ]

  it('finds a marker 20+ lines above the address', () => {
    expect(sectionBefore(longTable, longTable.length - 1)).toContain('不是现值')
  })

  it('a marker AFTER the address does not count (control)', () => {
    // The reader has already formed the conclusion by then — the same criterion applied to the
    // landing page in #34. It also closes the single-heading file, where one late disclaimer
    // would otherwise excuse every address above it.
    const doc = ['# 部署', 'L2Records `0xabc`', '', '> 上面的是旧地址,已被取代。']
    expect(sectionBefore(doc, 1)).not.toContain('已被取代')
    expect(sectionBefore(doc, 3)).toContain('已被取代')
  })

  it('does NOT leak into the previous section (control)', () => {
    // Without a stopping rule, "search upward until you find a marker" would let one
    // disclaimer excuse every address in the file.
    const doc = ['# 历史', '> 当时的部署,不是现值。', '', '## 现在使用的地址', '', 'L2Records `0xabc`']
    expect(sectionBefore(doc, 5)).not.toContain('不是现值')
  })

  it('a deeper subsection still sees its parent heading? no — it stops at its own (control)', () => {
    const doc = ['# 顶层', '> 不是现值。', '## 子节', 'L2Records `0xabc`']
    expect(sectionBefore(doc, 3)).not.toContain('不是现值')
  })

  it('handles a file with no headings at all', () => {
    expect(sectionBefore(['a', 'b', 'c'], 1)).toBe('a\nb')
  })
})

describe('the tightened marker list', () => {
  it('rejects the phrasing that used to slip through', () => {
    // "我们从旧版工具链迁移过来" — 旧 appears, but nothing says the ADDRESS is past.
    expect(HISTORY_MARKER.test('我们从旧版工具链迁移过来,配置如下')).toBe(false)
    expect(HISTORY_MARKER.test('历史上这个流程比较复杂')).toBe(false)
    expect(HISTORY_MARKER.test('当时我们讨论过两种方案')).toBe(false)
  })

  it('still accepts phrasings that DO say it (control)', () => {
    // Without this, a marker list that matched nothing would green every file by flagging
    // every history table — which is the false-positive failure, differently dressed.
    for (const ok of ['这是旧地址', '已被取代', '下表是当时的部署', '不是现值', 'superseded by', 'deprecated']) {
      expect(HISTORY_MARKER.test(ok)).toBe(true)
    }
  })
})
