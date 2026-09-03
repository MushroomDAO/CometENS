import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Claims we investigated, found false, and retracted — asserted to be absent from the repo.
 *
 * The failure this exists for: a conclusion gets overturned in a review thread, the code and
 * the argument both get corrected, and a copy of the original wording survives somewhere else.
 * `docs/UPSTREAM-API.md` shipped exactly that — the corrected paragraph and a stale draft of
 * the refuted one, ten lines apart, in a document written for outside integrators.
 *
 * A retraction has to follow the claim to every place it was written down, not just to the
 * place it was argued. This file is where that list lives so the following is mechanical.
 *
 * Adding an entry is cheap; each needs the phrase, why it is false, and where that was
 * established, so a future reader can re-open the question with the evidence rather than
 * re-deriving it.
 */
const RETRACTED: Array<{ phrase: string; why: string; where: string }> = [
  {
    phrase: '这条规则是唯一能存在的守卫',
    why: 'L2RecordsV3._registerNode 有 AlreadyRegistered 状态不变量,合约层挡得住重复注册。' +
      'owner 绕过的是授权检查(onlyOwnerOrRegistrar / 配额 / 到期),不是状态不变量。',
    where: 'PR #45 — 线上 0xbA692Cdf… 字节码含 selector 0x3a81d6fc,对照:编造的 selector 不含',
  },
  {
    phrase: '上游系统可以静默转走',
    why: '同上 —— 线上部署的是 V3,重复注册会链上回滚。观测到的覆写是 V1 的性质,而 V1 只存在于当时那条 e2e 里。',
    where: 'PR #45',
  },
  {
    phrase: 'viem 重复安装',
    why: 'typecheck 的 113 个错误里 viem 类型冲突只占 1 条(sdk)。大头是 @types/node 没装。',
    where: 'PR #48 — 按目录二分:src=0 / +sdk=1 / +server=10 / +test=109',
  },
]

const ROOTS = ['docs', 'README.md', 'src', 'server', 'workers', 'scripts', 'test']
const SKIP_SELF = 'retracted-claims.test.ts'

function textFiles(): string[] {
  const out: string[] = []
  const walk = (p: string) => {
    let st
    try {
      st = statSync(p)
    } catch {
      return
    }
    if (st.isDirectory()) {
      if (/node_modules|\.git|dist|out$/.test(p)) return
      for (const e of readdirSync(p)) walk(join(p, e))
    } else if (/\.(md|ts|mjs|js|html|css|toml)$/.test(p) && !p.endsWith(SKIP_SELF)) {
      out.push(p)
    }
  }
  const repo = join(__dirname, '..', '..')
  for (const r of ROOTS) walk(join(repo, r))
  return out
}

describe('retracted claims do not survive anywhere in the repo', () => {
  const files = textFiles()

  it('the file scan is non-trivial (control)', () => {
    // Without this, a walker that returned nothing would make every claim vacuously absent.
    expect(files.length).toBeGreaterThan(40)
    expect(files.some((f) => f.endsWith('UPSTREAM-API.md'))).toBe(true)
  })

  for (const { phrase, why, where } of RETRACTED) {
    it(`"${phrase.slice(0, 24)}…" appears nowhere`, () => {
      const hits = files.filter((f) => readFileSync(f, 'utf8').includes(phrase))
      expect(hits, `${why} (${where})`).toEqual([])
    })
  }

  it('a phrase that IS present would be caught (must-fail control)', () => {
    // Proves the scan reads content rather than the corpus simply lacking these strings.
    const present = files.filter((f) => readFileSync(f, 'utf8').includes('CometENS'))
    expect(present.length).toBeGreaterThan(0)
  })
})

describe('markdown tables are not left orphaned', () => {
  // The specific breakage: a botched section replacement cut at a table separator instead of
  // the section rule, leaving `---|---|---|` with no header above it. Cheap structural check.
  it('every table separator line has a header row directly above it', () => {
    const offenders: string[] = []
    for (const f of textFiles().filter((f) => f.endsWith('.md'))) {
      const lines = readFileSync(f, 'utf8').split('\n')
      lines.forEach((l, i) => {
        if (!/^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(l.trim())) return
        const prev = (lines[i - 1] ?? '').trim()
        if (!prev.includes('|')) offenders.push(`${f.split('/').slice(-2).join('/')}:${i + 1}`)
      })
    }
    expect(offenders).toEqual([])
  })

  it('the separator matcher recognises a real one (control)', () => {
    // Without this, a pattern that matched nothing would report zero offenders forever.
    const sep = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/
    expect(sep.test('|---|---|')).toBe(true)
    expect(sep.test('---|---|---|')).toBe(true)
    expect(sep.test('| 未注册 | 正常注册 |')).toBe(false)
  })
})
