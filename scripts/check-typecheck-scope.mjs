#!/usr/bin/env node
/**
 * Pin the typecheck-scope error count so progress reports can falsify themselves.
 *
 * "113 → 6" in a task file is a claim nobody re-runs. This makes it an assertion that fails
 * the moment it stops being true — in EITHER direction:
 *
 *   above budget → a regression, or a claim that was never true
 *   below budget → progress that nobody wrote down; lower BUDGET in the same commit
 *
 * The two directions are not symmetric in severity, and the script says so: going over is a
 * failure, going under is a failure with a one-line fix. Both stop the gate, because a budget
 * that silently absorbs improvements drifts back to meaningless.
 *
 * BUDGET is a CEILING, not a pin: error counts are monotonic in the direction we want (down).
 * Contrast scripts/check-skipped.mjs, where EXPECTED_SKIPPED is a pin (a skipped test can be
 * legitimately added) and MIN_TOTAL is a floor. Which one a number gets depends on whether the
 * quantity is monotonic — see docs/agent/practices.md.
 */
import { execFileSync } from 'node:child_process'

const BUDGET = 6

/**
 * The remaining errors are ONE design decision, not six unrelated bugs: how to annotate a
 * chain-bound viem client. `let x: ReturnType<typeof createPublicClient>` is the
 * UNPARAMETERISED return type, while the real client carries chain generics, so the two are
 * unrelated types rather than super/subtype. Casting each site away would remove the errors
 * and the distinction with them, so they are left for a deliberate pass. Listed here so the
 * next person does not rediscover it.
 */
const KNOWN = [
  'sdk/CometENS.ts',
  'server/gateway/index.ts',
  'test/e2e/register-multi-root.test.ts',
  'test/e2e/transfer-subnode.test.ts',
  'test/integration/deployed.test.ts',
]

/**
 * Every worker source file must be ACCOUNTED FOR: either compiled, or listed below with a
 * reason. Derived from the filesystem rather than hand-listed, because a hand-written list
 * has the same hole it is meant to close — a third worker file added later belongs to nobody,
 * is silently not typechecked, and the list still says everything is fine. (Fourth place in
 * this repo where enumerating reality beats enumerating expectations; see #70.)
 *
 * `workers/api/src/index.ts` is compiled only because tests import it and tsc follows imports.
 * That is real coverage — but it is held up by somebody else's import statement, and it was
 * this file that carried the seven-endpoint 500 for weeks because nothing typechecked it (#72).
 *
 * HOW FRAGILE, measured rather than assumed. It survives more than I first claimed:
 *   - `describe.skip` on every importing test  → still compiled (compilation ≠ execution)
 *   - specifier hoisted to `const WP = '…'`    → still compiled (tsc follows a literal const)
 *   - no in-scope file imports it at all       → NOT compiled ← the only way it goes
 *
 * The risk is not the COUNT of imports (15 sites across 7 files) but their KIND: only 2 are
 * static top-level; the other 13 are `await import()` inside test bodies — exactly what
 * routine test refactoring rewrites, by someone who has no idea they are deciding whether a
 * production file gets typechecked. Those 13 are the loose anchor, not the 7 files.
 *
 * That fragility USED to be silent: coverage could vanish while this script still printed OK,
 * because a file nobody compiled reports zero errors exactly like a clean one. It is not
 * silent any more — that is what the check below is, and removing every import now exits 1
 * and names the file (verified by building that state with a probe config).
 */
function run(args) {
  try {
    return execFileSync('npx', ['tsc', '-p', 'tsconfig.wide.json', ...args], { encoding: 'utf8' })
  } catch (e) {
    // tsc exits non-zero WITH the diagnostics on stdout; that is the normal path here.
    return `${e.stdout ?? ''}${e.stderr ?? ''}`
  }
}

const WORKER_SOURCES = execFileSync('git', ['ls-files', 'workers/**/*.ts'], { encoding: 'utf8' })
  .split('\n')
  .filter((f) => f && !f.includes('node_modules'))

/**
 * Worker files not yet in any typecheck scope, each with the task that will fix it.
 *
 * Empty as of T1.7.2. Kept rather than deleted because the check below still has to be able
 * to say "this file is nobody's" — an empty exemption table means every worker source is
 * genuinely covered, which is a different statement from having no table.
 */
const KNOWN_UNCOVERED = {}

/**
 * Scopes that are typechecked by their OWN tsconfig rather than by tsconfig.wide.json.
 *
 * The gateway worker cannot join the wide scope: it needs `@cloudflare/workers-types`, and
 * putting that in a shared `types` array is global — it overrides the DOM/Node `Response` and
 * `fetch` that the rest of the repo depends on. Measured: doing that took the error count from
 * 72 to 93. A separate project is the fix, because `types` is then global only within it.
 *
 * `workers/gateway/tsconfig.json` already existed and was already correct in shape — but
 * NOTHING RAN IT, so nobody had discovered that it did not compile at all (~40 TS2300/TS2451
 * from @types/node arriving through ethers' undici-types reference; skipLibCheck was missing).
 * A config that describes an intention nobody executes is not coverage. That is the whole
 * reason this list exists here rather than in a comment somewhere.
 */
const OWN_TSCONFIG = [{ dir: 'workers/gateway', covers: ['workers/gateway/src/index.ts'] }]

for (const { dir } of OWN_TSCONFIG) {
  try {
    execFileSync('npx', ['tsc', '--noEmit'], { cwd: dir, encoding: 'utf8', stdio: 'pipe' })
    console.log(`  ${dir}: own tsconfig, 0 errors`)
  } catch (e) {
    console.error(`FAIL: ${dir} does not typecheck under its own tsconfig:`)
    console.error(`${e.stdout ?? ''}${e.stderr ?? ''}`.trim())
    console.error(`(deps: cd ${dir} && pnpm install)`)
    process.exit(1)
  }
}

// --listFiles prints one ABSOLUTE path per line, and only for files tsc actually compiled.
// Matched as a whole-line suffix rather than a substring: `includes('/workers/api/src/index.ts')`
// would also be satisfied by `/vendor/copy/workers/api/src/index.ts`, and a check that can be
// satisfied by the wrong file is not a check.
const compiled = run(['--noEmit', '--listFiles'])
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean)
const isCompiled = (f) => compiled.some((p) => p === f || p.endsWith(`/${f}`))

// The matcher must be able to say no. Without this, a bug making isCompiled always true would
// leave every assertion below passing while checking nothing.
if (isCompiled('this/file/does/not/exist.ts')) {
  console.error('FAIL: isCompiled said yes to a path that cannot exist — the matcher is broken.')
  process.exit(1)
}

if (!WORKER_SOURCES.length) {
  console.error('FAIL: found no worker sources at all. The glob broke; this check is inert.')
  process.exit(1)
}

const ownCovered = new Set(OWN_TSCONFIG.flatMap((o) => o.covers))
const lost = WORKER_SOURCES.filter(
  (f) => !isCompiled(f) && !ownCovered.has(f) && !(f in KNOWN_UNCOVERED),
)
if (lost.length) {
  console.error(`FAIL: worker source in nobody's typecheck scope: ${lost.join(', ')}`)
  console.error('Either something stopped importing it, or it is new and was never covered.')
  console.error('A file nobody compiled reports zero errors exactly like a clean one.')
  console.error('Add it to a tsconfig include, or to KNOWN_UNCOVERED with the task that will fix it.')
  process.exit(1)
}

const staleExemptions = Object.keys(KNOWN_UNCOVERED).filter((f) => isCompiled(f) || ownCovered.has(f))
if (staleExemptions.length) {
  console.error(`FAIL: covered now, but still exempted: ${staleExemptions.join(', ')}`)
  console.error('Good news with a one-line fix: drop it from KNOWN_UNCOVERED and close its task.')
  console.error('A stale exemption is how a list stops describing anything.')
  process.exit(1)
}

for (const [f, why] of Object.entries(KNOWN_UNCOVERED)) console.log(`  not covered: ${f} — ${why}`)

const out = run(['--noEmit'])

const errors = out.split('\n').filter((l) => /error TS\d+:/.test(l))
const n = errors.length
const files = [...new Set(errors.map((l) => l.split('(')[0]))].sort()

console.log(`typecheck scope (tsconfig.wide.json): ${n} error(s), budget ${BUDGET}`)
for (const f of files) console.log(`  ${f}`)

if (n > BUDGET) {
  console.error(`\nFAIL: ${n} > ${BUDGET}.`)
  console.error('Either a regression, or the budget was written down without being measured.')
  process.exit(1)
}
if (n < BUDGET) {
  console.error(`\nFAIL: ${n} < ${BUDGET} — good news, but the budget has to come with it.`)
  console.error(`Set BUDGET = ${n} in scripts/check-typecheck-scope.mjs and update T1.7.1.`)
  console.error('A budget that silently absorbs progress drifts back to meaning nothing.')
  process.exit(1)
}

const unexpected = files.filter((f) => !KNOWN.includes(f))
if (unexpected.length) {
  console.error(`\nFAIL: same count, different files — ${unexpected.join(', ')}`)
  console.error('One error was fixed and another introduced. The count alone would have missed it.')
  process.exit(1)
}
console.log('\nOK — at budget, and in the expected files.')
