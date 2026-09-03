import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
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
/**
 * `allowIn` — files that may quote the phrase because they DOCUMENT the retraction.
 *
 * The ledger entry explaining why a claim was withdrawn has to be able to say what the claim
 * was. A blanket ban would force that explanation to be vague, which defeats the point: a
 * future reader could not tell what was retracted. Membership is verified below — an entry
 * that does not actually contain the phrase is a stale exemption waiting to cover a real one.
 */
const RETRACTED: Array<{ phrase: string; why: string; where: string; allowIn?: string[] }> = [
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
    allowIn: ['docs/agent/followups.md'],
    phrase: 'viem 重复安装',
    why: 'typecheck 的 113 个错误里 viem 类型冲突只占 1 条(sdk)。大头是 @types/node 没装。',
    where: 'PR #48 — 按目录二分:src=0 / +sdk=1 / +server=10 / +test=109',
  },
]

/**
 * Every tracked text file, from `git ls-files`.
 *
 * The first version walked a hand-listed set of ROOTS. pr-daemon falsified the claim this
 * suite makes: `.html` was in the extension list while ROOTS reached no `.html` file at all —
 * two configs that did not agree — so `admin.html`, `MANUAL.md`, `CHANGELOG.md`, `DEPLOY.md`
 * and every other top-level document were outside the scan. Dropping a retracted sentence into
 * MANUAL.md left the suite green.
 *
 * That is the worst way for THIS guard in particular to fail. Its `describe` says "anywhere in
 * the repo" — a falsifiable claim — so a hole does not merely miss something, it tells the
 * reader the question was asked. `git ls-files` removes the hand-maintained half: the file set
 * is now whatever the repo actually tracks.
 */
const TEXT_EXT = /\.(md|ts|mjs|js|html|css|toml)$/
const SKIP_SELF = 'retracted-claims.test.ts'
const REPO = join(__dirname, '..', '..')

function trackedTextFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8' })
    .split('\0')
    .filter((f) => f && TEXT_EXT.test(f) && !f.endsWith(SKIP_SELF))
    .map((f) => join(REPO, f))
}

describe('retracted claims do not survive anywhere in the repo', () => {
  const files = trackedTextFiles()

  it('the scan covers every tracked text file, including the ones the old walker missed', () => {
    // Counted PER EXTENSION rather than as one total.
    //
    // The previous version rebuilt the same filter with the same `TEXT_EXT` and `SKIP_SELF`
    // constants and compared lengths — so it caught a divergence introduced INSIDE the
    // function, but not a change to the shared input. Dropping `.html` from `TEXT_EXT` moved
    // both sides together (130 → 122) and the length line stayed green; what actually failed
    // was the by-name list below.
    //
    // Bucketing by extension does not share that input: removing `.html` takes its bucket from
    // 6 to 0 while the expected buckets are computed from the file names themselves.
    const bucket = (paths: string[]) => {
      const out: Record<string, number> = {}
      for (const f of paths) {
        const ext = f.slice(f.lastIndexOf('.'))
        out[ext] = (out[ext] ?? 0) + 1
      }
      return out
    }
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8' })
      .split('\0')
      .filter(Boolean)
      .filter((f) => !f.endsWith(SKIP_SELF))
    const scanned = bucket(files.map((f) => f.slice(REPO.length + 1)))
    const allTracked = bucket(tracked)
    for (const ext of ['.md', '.ts', '.html', '.mjs', '.css', '.toml']) {
      expect({ ext, n: scanned[ext] ?? 0 }).toEqual({ ext, n: allTracked[ext] ?? 0 })
    }

    // Named explicitly because these are exactly the files the hand-listed ROOTS could not
    // reach, and they are the ones a retracted claim is most likely to survive in.
    const names = files.map((f) => f.slice(REPO.length + 1))
    for (const f of ['MANUAL.md', 'CHANGELOG.md', 'DEPLOY.md', 'admin.html', 'README.md']) {
      expect(names).toContain(f)
    }
  })

  it('every allowIn entry actually quotes its phrase (control)', () => {
    // An exemption for a file that no longer contains the phrase is a hole standing open for
    // whatever lands in that file next — the same failure mode as a stale READ_ONLY entry.
    const stale: string[] = []
    for (const { phrase, allowIn } of RETRACTED) {
      for (const rel of allowIn ?? []) {
        if (!readFileSync(join(REPO, rel), 'utf8').includes(phrase)) stale.push(`${rel} ∌ "${phrase}"`)
      }
    }
    expect(stale).toEqual([])
  })

  for (const { phrase, why, where, allowIn } of RETRACTED) {
    it(`"${phrase.slice(0, 24)}…" appears nowhere`, () => {
      const allowed = new Set(allowIn ?? [])
      const hits = files
        .map((f) => f.slice(REPO.length + 1))
        .filter((rel) => !allowed.has(rel))
        .filter((rel) => readFileSync(join(REPO, rel), 'utf8').includes(phrase))
      expect(hits, `${why} (${where})`).toEqual([])
    })
  }

  it('the scan reads file CONTENT, not just names (positive control)', () => {
    // Not a must-fail control — it is the positive half: a string that IS present must be
    // found, so "absent" above means the content was read rather than the files being empty.
    const present = files.filter((f) => readFileSync(f, 'utf8').includes('CometENS'))
    expect(present.length).toBeGreaterThan(0)
  })
})

describe('markdown tables are not left orphaned', () => {
  // The specific breakage: a botched section replacement cut at a table separator instead of
  // the section rule, leaving `---|---|---|` with no header above it. Cheap structural check.
  it('every table separator line has a header row directly above it', () => {
    const offenders: string[] = []
    for (const f of trackedTextFiles().filter((f) => f.endsWith('.md'))) {
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
