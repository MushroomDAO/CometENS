#!/usr/bin/env node
/**
 * Refuse to ship a bundle that carries a provider credential.
 *
 * `preflight` check 3a looks at the ENVIRONMENT. This looks at the ARTIFACT — at what actually
 * gets uploaded — and those come apart: the env can be clean while a stale `dist/` from an
 * earlier build still holds a key, and a build can pick up `.env.local` that nobody looked at.
 * The artifact is the thing served to visitors, so it is the thing worth checking.
 *
 * Written after building this repo with a real `.env.local` and finding two Alchemy keys in the
 * JS, minutes before a frontend deploy that would have published them. `pnpm typecheck` was 0,
 * the suite was green, and `preflight` check 3 said PASS — because it only looks for
 * private-key shapes and `https://…/v2/<key>` is not one.
 *
 * Run it between `pnpm build` and any deploy.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const DIST = process.argv[2] ?? 'dist'

/** A credential sitting in a URL path: `…/v2/<key>` or `…/v3/<key>`. */
export const PROVIDER_KEY_IN_URL = /https?:\/\/[^\s"'`]*\/(v2|v3)\/[A-Za-z0-9_-]{16,}/g

/**
 * NO private-key pattern here, deliberately.
 *
 * The first version also scanned for `\b0x[0-9a-fA-F]{64}\b`. On a CLEAN build it reported
 * **7 hits** — all of them 32-byte constants that viem ships: ENS namehashes, masks like
 * `0xffff…`. A 64-hex string in a JS bundle is overwhelmingly a hash, not a credential, so that
 * pattern has no discriminating power in this corpus: it fires on every build and would train
 * the reader to ignore this check.
 *
 * Private keys are covered where they CAN be discriminated — `preflight` check 3 looks at the
 * environment, where a 64-hex value under a `VITE_` name is unambiguous. **The same pattern is
 * decisive against one corpus and useless against another**, which is why this file scans the
 * artifact for the one shape that only makes sense as a credential: a key inside a URL path.
 */

function walk(dir) {
  const out = []
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

/**
 * Wrapped in a guard so importing this file does not run the scan.
 *
 * The first version executed at module level, and the unit test that imports
 * `PROVIDER_KEY_IN_URL` therefore ran the whole scan — including `process.exit` — which killed
 * the test run with "no tests" rather than a failure anyone could read. Same lesson as
 * check-approval-sha.mjs: the exported logic and the command must be separable.
 */
function main() {
  if (!existsSync(DIST)) {
    console.error(`FAIL: ${DIST}/ does not exist — run \`pnpm build\` first.`)
    console.error('(A missing bundle is not a clean bundle. Refusing to report "no secrets found".)')
    process.exit(1)
  }

  const files = walk(DIST).filter((f) => /\.(js|css|html|json|map)$/.test(f))
  if (!files.length) {
    console.error(`FAIL: no scannable files under ${DIST}/ — the glob found nothing, so a PASS here`)
    console.error('would mean "I looked at zero files", not "I found nothing".')
    process.exit(1)
  }

  const hits = []
  for (const f of files) {
    const src = readFileSync(f, 'utf8')
    for (const [label, re] of [['provider key in URL', PROVIDER_KEY_IN_URL]]) {
      for (const m of src.matchAll(re)) {
        // Never print the credential. Enough to locate it, not enough to use it.
        const redacted = m[0].replace(/([A-Za-z0-9_-]{6})[A-Za-z0-9_-]+$/, '$1…')
        hits.push({ file: f, label, redacted })
      }
    }
  }

  console.log(`scanned ${files.length} file(s) under ${DIST}/`)
  if (!hits.length) {
    console.log('OK — no provider credential in the bundle.')
    process.exit(0)
  }
  console.error(`\nFAIL: ${hits.length} credential(s) would be published:`)
  for (const h of hits) console.error(`  ${h.label}: ${h.redacted}   (${h.file})`)
  console.error('\nVITE_ variables are compiled into the bundle. Use a public RPC for them and keep')
  console.error('the credentialed URL in a server-side variable (or a worker secret).')
  process.exit(1)

}

if (import.meta.url === `file://${process.argv[1]}`) main()
