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
 * Files that MUST end up in the compiled set, even though `include` never names them.
 *
 * `workers/api/src/index.ts` is covered only because unit tests import it and tsc follows
 * imports. That is real coverage — an injected type error in it does fail this check, verified
 * by probe — but it is coverage held up by somebody else's import statement. Delete the last
 * test that imports the worker and the coverage disappears with it, silently, while this
 * script still prints "OK": zero errors in a file nobody compiled looks exactly like zero
 * errors in a clean one.
 *
 * That matters more here than anywhere else in the repo: this is the file that carried the
 * seven-endpoint 500 for weeks precisely because nothing typechecked it (#72).
 *
 * So the coverage is asserted directly rather than assumed from the include list.
 *
 * HOW FRAGILE, measured rather than assumed — my first description of this was too alarming:
 *   - `describe.skip` on every importing test    → still compiled. Compilation is
 *                                                  independent of execution.
 *   - specifier hoisted to `const WP = '…'`      → still compiled. tsc follows a
 *                                                  literal-typed const through `import(WP)`.
 *   - no in-scope file imports it at all         → NOT compiled. This is the only way it
 *                                                  goes, and it is what this check catches.
 * The control below uses `workers/gateway/src/index.ts`, which is genuinely in that last
 * state today — so the matcher is known to be able to answer "no", not just "yes".
 */
const MUST_BE_COMPILED = ['workers/api/src/index.ts']

function run(args) {
  try {
    return execFileSync('npx', ['tsc', '-p', 'tsconfig.wide.json', ...args], { encoding: 'utf8' })
  } catch (e) {
    // tsc exits non-zero WITH the diagnostics on stdout; that is the normal path here.
    return `${e.stdout ?? ''}${e.stderr ?? ''}`
  }
}

// --listFiles prints one ABSOLUTE path per line, and only for files tsc actually compiled.
// Matched as a whole-line suffix rather than a substring: `includes('/workers/api/src/index.ts')`
// would also be satisfied by `/vendor/copy/workers/api/src/index.ts`, and a check that can be
// satisfied by the wrong file is not a check. (The first version of this had a second clause
// testing the same string with a trailing newline — dead, since the substring test subsumed it.)
const compiled = new Set(
  run(['--noEmit', '--listFiles'])
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean),
)
const isCompiled = (f) => [...compiled].some((p) => p === f || p.endsWith(`/${f}`))
const missing = MUST_BE_COMPILED.filter((f) => !isCompiled(f))

// The matcher must be able to say no. Without this, a bug that made isCompiled always true
// would leave every assertion below passing while checking nothing.
if (isCompiled('workers/gateway/src/index.ts')) {
  console.error('FAIL: the gateway worker IS compiled now — good, but this control assumed it was not.')
  console.error('Move it into MUST_BE_COMPILED and pick another known-absent file for the control.')
  process.exit(1)
}
if (isCompiled('this/file/does/not/exist.ts')) {
  console.error('FAIL: isCompiled returned true for a path that cannot exist — the matcher is broken.')
  process.exit(1)
}

if (missing.length) {
  console.error(`FAIL: not in the compiled set: ${missing.join(', ')}`)
  console.error('Whatever used to import it stopped. Add it to an include, or restore the import —')
  console.error('an uncompiled file reports zero errors exactly like a clean one.')
  process.exit(1)
}

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
