import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DICT } from '../../src/i18n'

/**
 * The dictionary and the page must name the same set of keys.
 *
 * English is authored in `index.html`, not in the dictionary — so a visitor with no JavaScript
 * still reads a complete page in the default language. The cost of that choice is that the two
 * halves can drift: a new paragraph in the HTML with no `zh`/`th` entry falls back to English
 * silently, and a stale dictionary entry points at a node that no longer exists. Neither shows
 * up in a browser as anything but "some text did not switch".
 */
const HTML = readFileSync(join(__dirname, '..', '..', 'index.html'), 'utf8')

/** Keys the page asks for, from both attributes. */
export function keysInPage(html: string): string[] {
  return [...html.matchAll(/data-i18n(?:-html)?="([^"]+)"/g)].map((m) => m[1])
}

const pageKeys = keysInPage(HTML)

describe('landing page i18n — page and dictionary agree', () => {
  it('the page actually carries markers (control)', () => {
    // Without this, every assertion below passes on an index.html with no i18n at all.
    expect(pageKeys.length).toBeGreaterThan(20)
  })

  it('no duplicate keys in the page', () => {
    // A duplicated key means one of the two nodes gets the other's text.
    const dupes = pageKeys.filter((k, i) => pageKeys.indexOf(k) !== i)
    expect([...new Set(dupes)]).toEqual([])
  })

  for (const lang of ['zh', 'th'] as const) {
    it(`${lang} translates every key the page asks for`, () => {
      const missing = pageKeys.filter((k) => !(k in DICT[lang]))
      expect(missing, `${lang} is missing translations`).toEqual([])
    })

    it(`${lang} has no entry the page never asks for`, () => {
      // A stale entry is invisible in the browser but tells the next translator to keep
      // maintaining text nobody displays.
      const orphans = Object.keys(DICT[lang]).filter((k) => !pageKeys.includes(k))
      expect(orphans, `${lang} has orphaned keys`).toEqual([])
    })
  }

  it('zh and th cover exactly the same keys as each other', () => {
    expect(Object.keys(DICT.zh).sort()).toEqual(Object.keys(DICT.th).sort())
  })

  it('WOULD catch a missing translation (must-fail control)', () => {
    const fake = keysInPage('<p data-i18n="not.a.real.key">x</p>')
    expect(fake.filter((k) => !(k in DICT.zh))).toEqual(['not.a.real.key'])
  })
})

describe('landing page i18n — the two attributes stay separate', () => {
  it('only markup-bearing strings use data-i18n-html', () => {
    // `data-i18n` writes textContent, so a translation containing tags would be shown literally.
    // Any zh/th value with a tag must therefore belong to an -html key.
    const htmlKeys = new Set([...HTML.matchAll(/data-i18n-html="([^"]+)"/g)].map((m) => m[1]))
    for (const lang of ['zh', 'th'] as const) {
      const wrong = Object.entries(DICT[lang])
        .filter(([k, v]) => /<[a-z]/.test(v) && !htmlKeys.has(k))
        .map(([k]) => `${lang}:${k}`)
      expect(wrong, 'these carry markup but are bound with data-i18n').toEqual([])
    }
  })

  it('the two attributes are distinguishable at all (control)', () => {
    expect(HTML).toContain('data-i18n-html=')
    expect(HTML).toContain('data-i18n=')
  })
})
