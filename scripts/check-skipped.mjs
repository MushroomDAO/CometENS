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
 * This number moves for any mechanism that stops tests running — a new modifier spelling,
 * a `skipIf` condition that quietly became always-true, a file that failed to load and was
 * swallowed. The matcher catches shapes; the count catches consequences.
 *
 * ⚠️ Interaction worth knowing before you curse this file: adding a legitimate
 * `describe.skipIf(true)` raises the count and you must change EXPECTED here too. That is
 * deliberate — it turns "skip this permanently" from one commit into two explicit edits, one
 * of which is this number.
 */
import { readFileSync } from 'node:fs'

/** Today's 9 are all in test/integration, standing down when no live RPC is configured. */
const EXPECTED = 9

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

  const n = skippedCount(report)
  if (n === EXPECTED) {
    console.log(`check-skipped: ${n} skipped of ${total}, as expected`)
    process.exit(0)
  }
  console.error(
    `check-skipped: ${n} tests skipped, expected exactly ${EXPECTED} (of ${total} total).\n` +
      (n > EXPECTED
        ? '  Something stopped tests from running. If it was deliberate (a new skipIf), update\n' +
          '  EXPECTED in scripts/check-skipped.mjs in the same commit and say why.'
        : '  Fewer skips than expected — a skipIf condition changed, or tests were removed.\n' +
          '  Either way the pinned number no longer describes this suite.'),
  )
  process.exit(1)
}
