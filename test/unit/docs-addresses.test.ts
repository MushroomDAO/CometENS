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
const OURS = /L2Records|L2RecordsV[23]|HybridResolver|OPResolver|OffchainResolver/i

const HISTORY_MARKER = /历史|此前|当时|旧|superseded|historical|不是现值|早已不是/

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
          // A marker anywhere in the surrounding block is enough — history sections say it once.
          const context = lines.slice(Math.max(0, i - 12), i + 3).join('\n')
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
