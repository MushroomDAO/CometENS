// docs/reference/ENSV2-UPSTREAM.md §3 里每一条引文,在本地镜像里都找得到吗?
//
// Usage: node scripts/check-ensv2-citations.mjs [--json]
//
// 为什么存在(来自 PR#100 评审的一条意见,以及它自己犯的同一个错):
//
// ENSV2-UPSTREAM.md §3 那张表的**全部意义**是「我们依赖的每条上游事实,带出处,可核对」。
// 但「可核对」在当时只是一个承诺 —— 没有任何东西检查那些引文真的在镜像里。
// #100 的评审指出计划书引了一句 "improved support for existing L2 solutions",
// 而它不在那张表里。他由此推断「这句只存在于计划书自己」。
//
// **他推错了一半**:那句话确实在镜像里(`src/pages/web/multichain.mdx:7`),
// 他搜的是我那份摘录、不是镜像本身。**但他指出的病是真的** —— 一条承重的引文,
// 没进那张以「可核对」为存在理由的表,于是从那份文档出发就核不到它。
//
// 而这件事最有意思的地方是:**我们两个都是靠手工 grep 得出结论的,他错了一半,我也是**
// (我最初把那句话的出处记成了 ensv2-readiness,实际在 multichain.mdx)。
// 手工核对引文这件事,双方都会出错 —— 所以它该由脚本做。
//
// ⚠️ **镜像没克隆时本脚本 exit 0,但会打印 NOT CHECKED。**
// 这是个真实的空档,不是形式:CI 里没有 vendor/ens-docs,所以 CI 跑它等于什么都没查。
// 这里照实喊出来,而不是打印一行绿字 —— 一个在缺少输入时静默通过的检查,
// 比没有检查更危险,因为它会让人以为查过了。
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const UPSTREAM_MD = join(REPO_ROOT, 'docs/reference/ENSV2-UPSTREAM.md')
const MIRROR = join(REPO_ROOT, 'vendor/ens-docs/src/pages')
const asJson = process.argv.includes('--json')

if (!existsSync(UPSTREAM_MD)) {
  console.error(`CITATIONS: ${UPSTREAM_MD} not found`)
  process.exit(2)
}

// §3 的表格行形如:  | F2 | ... **"quoted text"** ... | `src/pages/...` |
// 只抽**双引号里的**片段 —— 那些是逐字引文,是唯一需要能在上游找到的东西。
// 表格里的散文是我们自己的转述,不该拿去 grep。
const md = readFileSync(UPSTREAM_MD, 'utf8')
const section = md.slice(md.indexOf('## 3.'), md.indexOf('## 4.'))
const rows = section.split('\n').filter((l) => /^\|\s*F\d+\s*\|/.test(l))

const citations = []
for (const row of rows) {
  const id = row.match(/^\|\s*(F\d+)\s*\|/)?.[1]
  for (const m of row.matchAll(/"([^"]{12,})"/g)) citations.push({ id, quote: m[1] })
}

if (!existsSync(MIRROR)) {
  const msg = `CITATIONS: NOT CHECKED — no local mirror at vendor/ens-docs/. Run \`pnpm docs:ens\` first.\n` +
              `CITATIONS: ${citations.length} quoted citation(s) in ENSV2-UPSTREAM.md §3 were NOT verified against anything.`
  if (asJson) console.log(JSON.stringify({ checked: false, citations: citations.length }, null, 2))
  else console.log(msg)
  process.exit(0)
}

// 把镜像里所有 .mdx 读成一坨,一次性搜。页面只有几十个,不值得做索引。
const files = []
const walk = (d) => {
  for (const e of readdirSync(d)) {
    const p = join(d, e)
    if (statSync(p).isDirectory()) walk(p)
    else if (p.endsWith('.mdx') || p.endsWith('.md')) files.push(p)
  }
}
walk(MIRROR)
const corpus = files.map((f) => ({ f: 'src/pages' + f.slice(MIRROR.length), text: readFileSync(f, 'utf8') }))

const results = citations.map(({ id, quote }) => {
  // 两层归一化,缺一不可:
  //  ① 软换行 —— 上游 mdx 一句话可能跨行,不压平会假失败。
  //  ② markdown 强调标记 —— 我们的引文多半是从**渲染后的页面**抄的,
  //     渲染丢掉了源码里的 `*` `**` `_` 和反引号。上游写 `must trust *you*`,
  //     抄下来是 `must trust you`,逐字比对必然 MISS,而内容一个字没差。
  //     这不是放宽判据:去掉的都是 markup,不是内容。真抄错一个词仍然会被抓到。
  const flat = (s) => s
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const needle = flat(quote)
  const hits = corpus.filter((c) => flat(c.text).includes(needle)).map((c) => c.f)
  return { id, quote, hits }
})

const missing = results.filter((r) => r.hits.length === 0)

if (asJson) {
  console.log(JSON.stringify({ checked: true, results }, null, 2))
} else {
  console.log(`CITATIONS: ${results.length} quoted citation(s) in ENSV2-UPSTREAM.md §3, checked against ${files.length} mirrored page(s)\n`)
  for (const r of results) {
    const where = r.hits.length ? r.hits.join(', ') : 'NOT FOUND'
    console.log(`  ${r.id.padEnd(4)} ${r.hits.length ? 'ok ' : 'MISS'}  ${where}`)
    console.log(`       "${r.quote.slice(0, 88)}${r.quote.length > 88 ? '…' : ''}"`)
  }
}

if (missing.length) {
  console.error(`\nCITATIONS: FAIL — ${missing.length} citation(s) not found in the mirror.`)
  console.error('要么引文抄错了,要么上游改了措辞,要么它根本来自别处(预览部署、llms-full.txt、记忆)。')
  console.error('三种情况的处理不同,但都不该留着 —— 一条核不到的引文,和一条编出来的引文,在读者那里是一样的。')
  process.exit(1)
}
console.log('\nCITATIONS: ok — 每一条引文都在镜像里找得到。')
