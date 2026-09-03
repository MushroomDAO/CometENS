import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The index in tasks.md must list every protocol in practices.md — exactly once, by the same name.
 *
 * The index exists because `pilot run` selects tasks out of tasks.md, so a rule written only in
 * practices.md does not reach whoever is executing. That makes "the index is complete" a
 * correctness property, not tidiness.
 *
 * It already failed once, three PRs after the index was created: #70 added two protocols to
 * practices.md and the index did not follow. The criterion in place at the time constrained
 * the CONTENT of a row ("adding a requirement to a protocol must not force this row to change")
 * and said nothing about the SET of rows — so adding a whole new protocol did not violate it,
 * it simply fell outside it. This file is the missing half, and unlike the content half it can
 * be mechanised: it is a set comparison.
 *
 * Names must match verbatim. The alternative — an explicit mapping from heading to row — would
 * itself be a thing that drifts, which is the failure this whole file exists to prevent.
 */
const DOCS = join(__dirname, '..', '..', 'docs', 'agent')

export function protocolHeadings(practices: string): string[] {
  return practices.split('\n').filter((l) => l.startsWith('### ')).map((l) => l.slice(4).trim())
}

/** Row names from the blockquoted index table, minus its header row. */
export function indexRows(tasks: string): string[] {
  const out: string[] = []
  for (const line of tasks.split('\n')) {
    const m = /^>\s*\|\s*([^|]+?)\s*\|\s*[^|]+\|/.exec(line)
    if (!m) continue
    const name = m[1].trim()
    if (name === '规程' || /^-+$/.test(name)) continue
    out.push(name)
  }
  return out
}

describe('the practices index is complete and exact', () => {
  const practices = readFileSync(join(DOCS, 'practices.md'), 'utf8')
  const tasks = readFileSync(join(DOCS, 'tasks.md'), 'utf8')
  const headings = protocolHeadings(practices)
  const rows = indexRows(tasks)

  it('both sides are non-empty (control)', () => {
    // Without this, two broken extractors would agree on the empty set and the comparison
    // below would pass while checking nothing.
    expect(headings.length).toBeGreaterThan(4)
    expect(rows.length).toBeGreaterThan(4)
  })

  it('every protocol has an index row', () => {
    expect(headings.filter((h) => !rows.includes(h))).toEqual([])
  })

  it('every index row names a real protocol', () => {
    // The other direction: a row for a protocol that no longer exists sends the reader to a
    // section that is not there.
    expect(rows.filter((r) => !headings.includes(r))).toEqual([])
  })

  it('no protocol is listed twice in the index', () => {
    expect(rows.length).toBe(new Set(rows).size)
  })

  it('no protocol heading appears twice in practices.md', () => {
    // The gap this guard had until a real merge exposed it: it checked the INDEX for
    // duplicates and said nothing about the source. Rebasing #71 across #70's rename split one
    // protocol into two sections with the same heading — the set comparison stayed green,
    // because `includes` is happy to match the same row twice.
    const dupes = headings.filter((h, i) => headings.indexOf(h) !== i)
    expect(dupes).toEqual([])
  })

  it('the extractors discriminate (must-fail control)', () => {
    // Synthetic inputs, because the corpus is currently consistent — per practices.md
    // 「判据先约束现在」, a criterion that cannot be run on the present is not yet a criterion.
    expect(protocolHeadings('### 甲\n\n### 乙')).toEqual(['甲', '乙'])
    expect(indexRows('> | 规程 | 一句话 |\n> |---|---|\n> | 甲 | 说明 |')).toEqual(['甲'])
    // A heading with no row, and a row with no heading, are each detected.
    expect(protocolHeadings('### 甲\n### 丙').filter((h) => !['甲'].includes(h))).toEqual(['丙'])
  })
})
