import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'

/**
 * Relative links between markdown docs must resolve.
 *
 * Docs cross-reference each other heavily — DELEGATED-HOSTING points at SELF-HOSTING for the
 * "you do not have to trust anyone" path, UPSTREAM-API points back at both. A link written
 * against a file that does not exist yet reads exactly like a working one until someone
 * clicks it, and nothing in the build or the test suite looks at markdown at all.
 *
 * Caught on its first run: two docs linked to SELF-HOSTING.md, which T1.2.3 has not written.
 */

const DOCS = resolve(__dirname, '../../docs')
const REPO = resolve(__dirname, '../..')

function markdownFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...markdownFiles(p))
    else if (entry.name.endsWith('.md')) out.push(p)
  }
  return out
}

/**
 * Strip fenced and inline code before looking for links.
 *
 * Without this the extractor reports array indexing as broken links: `arr[0](x)` and
 * `bytes[labelhashes.length](…)` inside a Solidity snippet match the markdown link pattern
 * exactly. Both showed up on this file's first run as "dangling links" in docs that are
 * perfectly fine — the judge was the broken part, not the docs.
 */
function stripCode(md: string): string {
  return md.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ')
}

/** Relative markdown links only — external URLs and anchors are out of scope here. */
function relativeLinks(mdRaw: string): string[] {
  const md = stripCode(mdRaw)
  return [...md.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)]
    .map((m) => m[1].trim())
    .filter((href) => !/^(https?:|mailto:|#)/.test(href))
    .map((href) => href.split('#')[0])
    .filter(Boolean)
}

describe('docs — relative links resolve', () => {
  const files = markdownFiles(DOCS)

  it('does not mistake code for links (control)', () => {
    // Array indexing inside a snippet matches the markdown link pattern character for
    // character; the only difference is that it lives in code.
    expect(relativeLinks('```sol\nbytes[] memory a = new bytes[](n);\n```')).toEqual([])
    expect(relativeLinks('see [guide](GUIDE.md)')).toEqual(['GUIDE.md'])
  })

  it('finds markdown files and links at all (must-find control)', () => {
    // Without this, an empty scan would make every assertion below vacuously true.
    expect(files.length).toBeGreaterThan(0)
    const total = files.reduce((n, f) => n + relativeLinks(readFileSync(f, 'utf8')).length, 0)
    expect(total).toBeGreaterThan(0)
  })

  it.each(
    markdownFiles(DOCS).map((f) => [f.replace(`${REPO}/`, ''), f] as const),
  )('%s has no dangling relative links', (_label, file) => {
    const broken = relativeLinks(readFileSync(file, 'utf8')).filter(
      (href) => !existsSync(resolve(dirname(file), href)),
    )
    expect(broken, `dangling links in ${file.replace(`${REPO}/`, '')}`).toEqual([])
  })
})
