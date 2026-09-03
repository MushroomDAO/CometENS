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

  // `color:` alone is NOT a usable matcher — `border-color:` contains it, so the assertion
  // passes even when the declaration is absent. Verified by deleting the hover `color` line:
  // the naive version stayed green. Anchor on a declaration boundary instead.
  // The `\s*` must sit OUTSIDE the alternation. Written as `(^|[;{]\s*)` the `^` branch
  // demands `color` at column 0, so a declaration that is FIRST in its block — captured
  // without the opening brace — is missed. Today `.btn-primary` passes only because `color`
  // happens to come third, after a `;`. Reordering the declarations would turn this guard red
  // for no real reason, and a guard that cries wolf gets deleted.
  const COLOR_DECL = /(^|[;{])\s*color\s*:/m

  /**
   * Every rule that paints a background, DERIVED from the stylesheet.
   *
   * FU-2: this used to name `.btn-primary` and its `:hover` explicitly, so `.btn:hover` and
   * `.btn-ghost:hover` — which have the same exposure — were never checked. A hand-written
   * list guards the rules someone remembered; the bug it exists to catch is precisely the one
   * nobody remembered.
   */
  /** Selectors in scope for a given stylesheet — exported shape so the predicate is testable. */
  function inScope(css: string): string[] {
    return rulesIn(css).map((r) => r.selector)
  }

  function backgroundRules(): Array<{ selector: string; body: string }> {
    return rulesIn(CSS)
  }

  function rulesIn(source: string): Array<{ selector: string; body: string }> {
    const out: Array<{ selector: string; body: string }> = []
    // Comments must go first. A `/* … */` block sitting above a rule gets swallowed into the
    // selector capture, so `.btn-primary:hover` and `.badge` — both of which carry explanatory
    // comments — were silently absent from the derived set. Exactly the failure the control
    // exists for, and it only showed up when I checked the list against the stylesheet by eye.
    const cssNoComments = source.replace(/\/\*[\s\S]*?\*\//g, '')
    for (const m of cssNoComments.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const selector = m[1].trim()
      const body = m[2]
      // Same anchor bug as COLOR_DECL, opposite consequence: here the predicate decides
      // whether a rule is IN SCOPE, so getting it wrong selected nothing at all and the loop
      // ran zero assertions. A selection predicate fails silent; an assertion predicate fails
      // loud. The control below is what surfaced it.
      // In scope: anything that CHANGES the background, plus `:hover` — never `:focus`.
      //
      // The question is "does this rule change the background", not "is it a hover or a focus".
      // `:hover` earns its place because it has a concrete opponent: the global `a:hover` will
      // come for the foreground. `:focus-visible` has no such opponent, and most designs
      // deliberately change only the outline and inherit the base colour — demanding an
      // explicit `color` there punishes the correct way to write it.
      //
      // The false-positive side is the expensive one: a rule that keeps accusing good code
      // gets disabled, and everything it legitimately caught goes with it. Same lesson as the
      // address guard in #41, arrived at from the other direction.
      const paints = /(^|[;{])\s*background(-color)?\s*:/m.test(body)
      const isHover = /:hover/.test(selector)
      if (!paints && !isHover) continue
      // Only interactive surfaces carrying text: those are what `a:hover` can repaint.
      // Deliberately loose on the pseudo-class tail — an earlier strict pattern failed to
      // match `.btn:hover:not(:disabled)` and silently selected nothing, which the control
      // below caught. Grouped selectors are skipped: their bodies are shared, so attributing
      // a missing `color` to one of them would be arbitrary.
      if (!/^\.(btn|badge|chip)/.test(selector)) continue
      if (selector.includes(',')) continue
      // A transparent background paints nothing, so it cannot trap text against itself —
      // unless it is also a hover state, where a:hover still applies.
      if (!isHover && /transparent|none/.test(body.match(/background(-color)?\s*:([^;]*)/)?.[2] ?? '')) continue
      out.push({ selector, body })
    }
    return out
  }

  it('the derived rule set is non-empty and includes the known ones (control)', () => {
    // Without this, a selector regex that matched nothing would make the loop below vacuous —
    // zero assertions, all green.
    const selectors = backgroundRules().map((r) => r.selector)
    // A FLOOR, not a count, was the wrong assertion: `>= 2` is exactly the size of the
    // hardcoded list this derivation replaced, so degrading the prefix predicate back to
    // `^\.btn-primary|^\.btn:hover` left the suite fully green while `.btn-ghost:hover` —
    // the rule FU-2 was filed to cover — dropped silently out of scope. pr-daemon measured it:
    // 27 passed on that mutation. And `>= 2` was dead anyway, implied by the toContain lines.
    //
    // Pinning the exact count means any change to what is covered has to be acknowledged here.
    expect(selectors).toHaveLength(9)
    expect(selectors).toContain('.btn-primary')
    // Named explicitly because these two were the ones the comment-stripping bug hid, and
    // FU-2's whole point is that a hand-picked list misses what nobody remembered.
    expect(selectors).toContain('.btn-primary:hover:not(:disabled)')
    expect(selectors).toContain('.btn:hover:not(:disabled)')
  })

  it.each(backgroundRules().map((r) => r.selector))(
    '%s states its own foreground',
    (selector) => {
      // If a painted surface omits `color`, the global `a:hover` rule (specificity 0,1,1) takes
      // over and the label disappears against the new background.
      const rule = backgroundRules().find((r) => r.selector === selector)!
      expect(rule.body).toMatch(COLOR_DECL)
    },
  )

  // pr-daemon's two rows for the focus question. The first is the load-bearing one: it is the
  // only input on which "flag every interactive state" and "flag whatever changes the
  // background" give DIFFERENT answers. The second gives the same answer either way, so on its
  // own it cannot tell the two rules apart — which is exactly why it is here as a pair.
  it('a focus rule that only changes the outline is NOT in scope', () => {
    const css = '.btn:focus-visible { outline: 2px solid var(--c-ring); }'
    expect(inScope(css)).toEqual([])
  })

  it('a focus rule that DOES change the background IS in scope (control)', () => {
    const css = '.btn:focus-visible { background: var(--c-accent); }'
    expect(inScope(css)).toEqual(['.btn:focus-visible'])
  })

  it('a hover rule with no background is still in scope — it has a:hover to fight', () => {
    const css = '.btn:hover { color: var(--c-text); }'
    expect(inScope(css)).toEqual(['.btn:hover'])
  })

  it('the matcher rejects a block that only has border-color (control)', () => {
    expect('  background: red;\n  border-color: blue;\n').not.toMatch(COLOR_DECL)
  })
})
