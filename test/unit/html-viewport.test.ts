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

describe('every shipped HTML page declares a viewport', () => {
  it('finds the pages at all (control)', () => {
    // An empty glob would make the assertion below vacuous and keep it that way.
    expect(pages.length).toBeGreaterThan(3)
  })

  it('no page is missing the meta tag', () => {
    const missing = pages.filter(
      (p) => !/<meta\s+name=["']viewport["']/i.test(readFileSync(join(ROOT, p), 'utf8')),
    )
    expect(missing, 'these pages will render at ~980px on a phone').toEqual([])
  })

  it('WOULD catch a page without one (must-fail control)', () => {
    const withoutTag = '<!DOCTYPE html><html><head><meta charset="UTF-8"></head></html>'
    expect(/<meta\s+name=["']viewport["']/i.test(withoutTag)).toBe(false)
  })

  it('accepts single or double quotes and extra attributes (control)', () => {
    // A regex pinned to one exact spelling would pass today and fail on a harmless rewrite.
    for (const tag of [
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      "<meta name='viewport' content='width=device-width'>",
      '<meta  name="viewport"  content="width=device-width" />',
    ]) {
      expect(/<meta\s+name=["']viewport["']/i.test(tag)).toBe(true)
    }
  })
})
