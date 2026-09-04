import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * Commands quoted in the docs must exist.
 *
 * A guide that tells a reader to run `pnpm bootstrap:community` when that script was renamed
 * fails at exactly the moment the reader is least able to diagnose it — they have no idea
 * whether they mistyped, missed a step, or the doc is wrong. SELF-HOSTING.md's whole promise
 * is "2 hours, without contacting us", and every stale command in it is a contact.
 *
 * Nothing else covers this: markdown is not built, linted or type-checked, and the scripts it
 * names live in package.json and on disk, not in any import graph.
 */

const ROOT = resolve(__dirname, '../..')
const DOCS = join(ROOT, 'docs')

/** Root-level markdown — README is the most-read file and was outside this guard. */
function rootMarkdown(): string[] {
  return ['README.md', 'CHANGELOG.md'].map((f) => join(ROOT, f)).filter((f) => existsSync(f))
}

function markdownFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...markdownFiles(p))
    else if (e.name.endsWith('.md')) out.push(p)
  }
  return out
}

const pkgScripts = Object.keys(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts)

/**
 * `pnpm <name>` also runs a binary from node_modules/.bin, not only a package.json script —
 * `pnpm vitest run …` is a legitimate command that is not a script. Treating those as missing
 * scripts was this guard's own first false positive.
 */
const binaries = (() => {
  try {
    return readdirSync(join(ROOT, 'node_modules/.bin'))
  } catch {
    return []
  }
})()
const runnable = new Set([...pkgScripts, ...binaries])

/** `pnpm <script>` occurrences, excluding pnpm's own built-ins. */
function pnpmScriptsIn(md: string): string[] {
  const builtins = new Set(['install', 'add', 'remove', 'run', 'exec', 'dlx', 'why', 'up'])
  return [...new Set([...md.matchAll(/\bpnpm ([a-z][a-z0-9:-]*)/g)].map((m) => m[1]))].filter(
    (s) => !builtins.has(s),
  )
}

/** Repo files the docs tell the reader to execute. */
function scriptFilesIn(md: string): string[] {
  return [...new Set([...md.matchAll(/(?:bash |node |forge script )([\w/.-]+\.(?:sh|mjs|ts|sol))/g)].map((m) => m[1]))]
}

describe.each([...markdownFiles(DOCS), ...rootMarkdown()].map((f) => [f.replace(`${ROOT}/`, ''), f] as const))(
  '%s',
  (label, file) => {
    const md = readFileSync(file, 'utf8')

    it('only names pnpm scripts that exist', () => {
      const missing = pnpmScriptsIn(md).filter((s) => !runnable.has(s))
      expect(missing, `${label} tells the reader to run scripts that are not in package.json`).toEqual([])
    })

    it('only names script files that exist', () => {
      const missing = scriptFilesIn(md).filter(
        (p) => !existsSync(join(ROOT, p)) && !existsSync(join(ROOT, 'contracts', p)),
      )
      expect(missing, `${label} references files that are not in the repo`).toEqual([])
    })
  },
)

describe('the extractors actually find things (must-find controls)', () => {
  // Without these, extractors that silently match nothing would make every assertion above
  // vacuously true — the exact trap that has bitten several guards in this repo already.
  it('finds pnpm scripts', () => {
    expect(pnpmScriptsIn('run `pnpm check:chain` first')).toEqual(['check:chain'])
    expect(pnpmScriptsIn('pnpm install')).toEqual([])
  })

  it('finds script files', () => {
    expect(scriptFilesIn('bash scripts/resolve-testnet.sh alice.eth')).toEqual([
      'scripts/resolve-testnet.sh',
    ])
  })

  it('reads a non-empty set out of the real docs', () => {
    const all = [...markdownFiles(DOCS), ...rootMarkdown()].flatMap((f) => pnpmScriptsIn(readFileSync(f, 'utf8')))
    expect(all.length).toBeGreaterThan(0)
  })

  it('would flag a script that does not exist (must-fail control)', () => {
    expect(pnpmScriptsIn('pnpm definitely:not:a:script').filter((s) => !runnable.has(s))).toEqual([
      'definitely:not:a:script',
    ])
  })

  it('accepts a node_modules binary, not just a package.json script', () => {
    // Control for the exemption above: if `binaries` ever comes back empty the guard would
    // start reporting phantom failures and the exemption would look unnecessary.
    expect(binaries.length).toBeGreaterThan(0)
    expect(pnpmScriptsIn('pnpm vitest run x').filter((s) => !runnable.has(s))).toEqual([])
  })
})
