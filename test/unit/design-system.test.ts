import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Design-system invariants that a build cannot catch.
 *
 * `pnpm build` stayed green while every button on the landing page had invisible hover text:
 * the global `a:hover` rule (specificity 0,1,1) outranked `.btn-primary` (0,1,0) and repainted
 * the label with --c-accent-hover, which is exactly the colour the hover rule set as the
 * BACKGROUND. Contrast 1.00. Counting tokens did not see it either, because the tokens were
 * all present and correct — the defect lived in how they combined.
 *
 * So the pairings themselves are asserted here, not just the token inventory.
 */

const CSS = readFileSync(join(__dirname, '../../src/styles/design-system.css'), 'utf8')

const rootBlock = CSS.match(/^:root \{(.*?)^\}/ms)![1]
const darkBlock = CSS.match(/prefers-color-scheme: dark\) \{(.*?)\n {2}\}/s)![1]

function token(name: string, scheme: 'light' | 'dark'): string {
  const block = scheme === 'dark' ? darkBlock : rootBlock
  const inScheme = block.match(new RegExp(`${name}:\\s*([^;]+);`))
  // Dark redefines only what changes; anything else inherits the light value.
  if (inScheme) return inScheme[1].trim()
  const inRoot = rootBlock.match(new RegExp(`${name}:\\s*([^;]+);`))
  if (!inRoot) throw new Error(`token ${name} is defined in neither :root nor the dark block`)
  return inRoot[1].trim()
}

function relativeLuminance(hex: string): number {
  const h = hex.replace('#', '')
  const channels = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG 2.1 contrast ratio. */
export function contrast(a: string, b: string): number {
  const [la, lb] = [relativeLuminance(a), relativeLuminance(b)]
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

// Every foreground/background pair the stylesheet actually produces. Body text and badges
// are below 18px, so all of these are held to the 4.5:1 normal-text threshold.
const PAIRS: Array<[string, string, string]> = [
  ['body text', '--c-text', '--c-bg'],
  ['body text on surface', '--c-text', '--c-surface'],
  ['muted text', '--c-text-muted', '--c-surface'],
  ['link', '--c-accent', '--c-surface'],
  ['btn-primary (rest)', '--c-accent-fg', '--c-accent'],
  ['btn-primary (hover)', '--c-accent-fg', '--c-accent-hover'],
  ['badge-success', '--c-success', '--c-success-bg'],
  ['badge-warn', '--c-warn', '--c-warn-bg'],
  ['badge-danger', '--c-danger', '--c-danger-bg'],
]

const AA_NORMAL = 4.5

describe.each(['light', 'dark'] as const)('design system — %s scheme contrast', (scheme) => {
  it.each(PAIRS)('%s meets WCAG AA (4.5:1)', (_label, fg, bg) => {
    expect(contrast(token(fg, scheme), token(bg, scheme))).toBeGreaterThanOrEqual(AA_NORMAL)
  })
})

describe('design system — the contrast function itself is trustworthy', () => {
  // Without these controls, "every pair passed" and "the maths always returns a big number"
  // are indistinguishable — the same vacuous-assertion trap that produced the hover bug.
  it('returns 21 for black on white', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 1)
  })
  it('returns 1 for a colour against itself — the exact hover failure', () => {
    expect(contrast('#1c42a3', '#1c42a3')).toBeCloseTo(1, 5)
  })
  it('FAILS a pair that genuinely fails (must-fail control)', () => {
    expect(contrast('#999999', '#ffffff')).toBeLessThan(AA_NORMAL)
  })
})

describe('design system — token coverage', () => {
  const colourTokens = (block: string) => new Set(block.match(/--c-[a-z-]+/g) ?? [])

  it('defines no token that exists only in dark mode', () => {
    // A token defined only inside the dark media query silently resolves to nothing in light
    // mode. It is invisible in review because the dark screenshot looks correct.
    const light = colourTokens(rootBlock)
    const dark = colourTokens(darkBlock)
    expect(light.size).toBeGreaterThan(0)
    expect(dark.size).toBeGreaterThan(0)
    expect([...dark].filter((t) => !light.has(t))).toEqual([])
  })

  it('every accent surface states its own foreground', () => {
    // Guards the regression directly: if a future edit drops `color` from either accent rule,
    // `a:hover` takes over again and the label disappears on hover.
    // `color:` alone is NOT a usable matcher — `border-color:` contains it, so the assertion
    // passes even when the declaration is absent. Verified by deleting the hover `color` line:
    // the naive version stayed green. Anchor on a declaration boundary instead.
    const COLOR_DECL = /(^|[;{]\s*)color\s*:/m
    const primary = CSS.match(/\.btn-primary \{([^}]*)\}/)![1]
    const primaryHover = CSS.match(/\.btn-primary:hover:not\(:disabled\) \{([^}]*)\}/)![1]
    expect(primary).toMatch(COLOR_DECL)
    expect(primaryHover).toMatch(COLOR_DECL)
    // Control: the matcher must reject a block that only has border-color.
    expect('  background: red;\n  border-color: blue;\n').not.toMatch(COLOR_DECL)
  })
})
