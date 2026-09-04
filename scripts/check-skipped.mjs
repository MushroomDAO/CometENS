#!/usr/bin/env node
/**
 * How many tests the suite skipped, pinned to an exact number.
 *
 * A second instrument for the same question test/unit/test-focus.test.ts asks, taking its
 * reading from a DIFFERENT fact: that one reads source text, this one reads what the run
 * actually did. They cannot go blind together.
 *
 * Why it is worth having both: the text matcher only recognises spellings someone thought of.
 * `it.concurrent.only` got past the first version — measured, it left one file at
 * 1 passed | 35 skipped with the whole gate green. The skipped TOTAL went 9 → 44 in the same
 * run: `.only` is not silent, its mark was simply in a number nobody read.
 *
 * Two numbers, because they answer different halves and one alone overclaims:
 *
 *   skipped — tests that RAN as skipped. Catches `.only`, a new modifier spelling, a `skipIf`
 *             condition that quietly became always-true.
 *   total   — assertions the run saw at all. Catches a test FILE disappearing, which the
 *             skipped count cannot see: a file that does not run contributes no assertions, so
 *             it moves `total` and leaves `skipped` untouched. Measured — deleting
 *             design-system.test.ts took total 664 → 628 with skipped still 9 and this script
 *             still exiting 0, while 36 assertions vanished.
 *
 * The matcher catches shapes; these catch consequences — but only the consequences they can
 * each see.
 *
 * ⚠️ Interaction worth knowing before you curse this file: adding a legitimate
 * `describe.skipIf(true)` raises the count and you must change EXPECTED here too. That is
 * deliberate — it turns "skip this permanently" from one commit into two explicit edits, one
 * of which is this number.
 */
import { readFileSync } from 'node:fs'

/**
 * Today's 9 are all in test/integration, standing down when no live RPC is configured.
 *
 * Pinned exactly because `skipped` is NOT monotonic: more means something stopped running,
 * fewer means a skipIf condition changed or tests were deleted. Both directions need someone
 * to explain them.
 */
const EXPECTED_SKIPPED = 9

/**
 * A LOWER BOUND, and deliberately so — `total` only grows.
 *
 * This is not the "floor equal to today's value" mistake made in #48/#56/#59. There the
 * quantity was not monotonic and the bound sat exactly at the present, so shrinkage was
 * undetectable. Here shrinkage is precisely what a bound catches, while growth — every PR that
 * adds a test — must not require editing this file. **Whether to pin or to bound depends on
 * whether the quantity is monotonic**, not on a blanket preference for pins.
 */
const MIN_TOTAL = 664

export function skippedCount(report) {
  // vitest's json reporter marks a not-run test as "skipped" or "todo" per assertion result.
  let n = 0
  for (const file of report.testResults ?? []) {
    for (const t of file.assertionResults ?? []) {
      if (t.status === 'skipped' || t.status === 'pending' || t.status === 'todo') n++
    }
  }
  return n
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const path = process.argv[2]
  if (!path) {
    console.error('usage: check-skipped.mjs <vitest-json-report>')
    process.exit(2)
  }
  let report
  try {
    report = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    console.error(`check-skipped: could not read ${path} — ${e.message}`)
    process.exit(2)
  }

  const total = (report.testResults ?? []).reduce((a, f) => a + (f.assertionResults?.length ?? 0), 0)
  if (total === 0) {
    // Refusing to pass on an empty report: "0 skipped" would otherwise be indistinguishable
    // from "the run produced nothing", which is the failure this whole file guards against.
    console.error('check-skipped: the report contains no assertions at all — refusing to report success')
    process.exit(2)
  }

  if (total < MIN_TOTAL) {
    console.error(
      `check-skipped: the run saw ${total} assertions, fewer than the ${MIN_TOTAL} this suite had.\n` +
        '  A test file stopped being collected — deleted, renamed out of the include glob, or\n' +
        '  failing to load. That is invisible to the skipped count, which is why this check exists.\n' +
        '  If tests were removed on purpose, lower MIN_TOTAL in the same commit and say why.',
    )
    process.exit(1)
  }

  const n = skippedCount(report)
  if (n === EXPECTED_SKIPPED) {
    // Headroom on the SUCCESS path on purpose. MIN_TOTAL is an ABSOLUTE floor: tightest
    // today, looser every time a test is added. At total 900 against a floor of 664 you could
    // delete 236 assertions and still pass. Nobody goes looking for that — but a number that
    // has grown absurd gets noticed by whoever reads this line, which is the point of putting
    // a future misreading where it will actually be read.
    console.log(
      `check-skipped: ${n} skipped of ${total} (floor ${MIN_TOTAL}, headroom ${total - MIN_TOTAL}), as expected`,
    )
    process.exit(0)
  }
  console.error(
    `check-skipped: ${n} tests skipped, expected exactly ${EXPECTED_SKIPPED} (of ${total} total).\n` +
      (n > EXPECTED_SKIPPED
        ? '  Something stopped tests from running. If it was deliberate (a new skipIf), update\n' +
          '  EXPECTED_SKIPPED in scripts/check-skipped.mjs in the same commit and say why.'
        : '  Fewer skips than expected — a skipIf condition changed, or tests were removed.\n' +
          '  Either way the pinned number no longer describes this suite.'),
  )
  process.exit(1)
}
