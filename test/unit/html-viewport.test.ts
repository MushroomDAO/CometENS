import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

/**
 * Every shipped page declares a viewport.
 *
 * Without it a phone renders the page at ~980px and scales down: text too small to read, and
 * the horizontal scrolling that acceptance criterion 4 forbids. It is one line, it is invisible
 * on a desktop, and nothing else fails when it is missing — which is exactly why it survived.
 *
 * Found by re-running the M1 acceptance criteria by hand rather than trusting the last pass
 * (#52, some thirty merges ago). `box.html` had no viewport: it predates the design system and
 * is out of the acceptance scope (two main surfaces + landing), so no criterion covered it and
 * no test looked at it.
 *
 * The guard is over ALL pages rather than the three in scope, because "in scope" is what let
 * this through: a page nobody's criterion mentions is a page nobody checks.
 */
const ROOT = join(__dirname, '..', '..')

const pages = execFileSync('git', ['ls-files', '*.html'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)

/**
 * The one place the pattern is written.
 *
 * It used to appear three times — once in the filter, once in each control — so loosening the
 * filter left every control green: they were re-deriving the answer from their own copy rather
 * than checking the one in use. Measured: relaxing only the filter to `/viewport/i` gave
 * **4 passed**, with nothing red. A shared constant is what makes the controls controls.
 */
export const VIEWPORT_META = /<meta\s+name=["']viewport["']/i

describe('every shipped HTML page declares a viewport', () => {
  it('finds the pages at all (control)', () => {
    // An empty glob would make the assertion below vacuous and keep it that way.
    //
    // The bound is a FLOOR, not a pin: pages get added, not removed, so the quantity is
    // monotonic in one direction (same distinction as EXPECTED_SKIPPED vs MIN_TOTAL in
    // scripts/check-skipped.mjs). The number is 4 because that is a floor on what this repo
    // ships — it is deliberately NOT the acceptance criteria's "two main surfaces + landing",
    // because this guard covers every page and that scope is what let box.html through.
    expect(pages.length).toBeGreaterThan(4)
  })

  it('no page is missing the meta tag', () => {
    const missing = pages.filter((p) => !VIEWPORT_META.test(readFileSync(join(ROOT, p), 'utf8')))
    expect(missing, 'these pages will render at ~980px on a phone').toEqual([])
  })

  // The sample deliberately CONTAINS the word "viewport" without being a meta tag. A sample
  // that merely omits the word cannot tell a correct pattern from `/viewport/i`: both answer
  // false, so it has no power in the over-matching direction — which is the direction a
  // loosened pattern actually fails in.
  it('WOULD catch a page whose only "viewport" is not a meta tag (must-fail control)', () => {
    const decoy = '<!DOCTYPE html><html><head><style>/* viewport tweaks */</style></head></html>'
    expect(VIEWPORT_META.test(decoy)).toBe(false)
    expect(/viewport/i.test(decoy)).toBe(true) // the loose pattern WOULD accept it
  })

  it('accepts single or double quotes and extra attributes (control)', () => {
    // A regex pinned to one exact spelling would pass today and fail on a harmless rewrite.
    for (const tag of [
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      "<meta name='viewport' content='width=device-width'>",
      '<meta  name="viewport"  content="width=device-width" />',
    ]) {
      expect(VIEWPORT_META.test(tag)).toBe(true)
    }
  })
})
