#!/usr/bin/env node
/**
 * Does the deployed API worker support what the frontend about to ship needs?
 *
 * The frontend and the API worker deploy independently, so the frontend can ship first and
 * call endpoints that do not exist yet. That already happened: `/apply` and `/approval-mode`
 * shipped in the frontend while the worker still 404s them, and the only thing standing
 * between an applicant and a wasted signature is a fail-closed check inside the page (FU-7).
 *
 * The required list is DERIVED FROM THE FRONTEND SOURCE, not written out here. A hand-written
 * list would only cover the endpoints someone remembered — and the whole failure mode is
 * "someone added a call and forgot".
 *
 * Exit codes: 0 all present · 1 something missing · 2 could not check (never a silent pass).
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Endpoints the frontend calls, read out of `${config.apiUrl}/...` template literals. */
export function requiredEndpoints(sources) {
  const found = new Set()
  for (const src of sources) {
    for (const m of src.matchAll(/apiUrl\}(\/[a-z0-9-]+)/g)) found.add(m[1])
  }
  return [...found].sort()
}

/** Raw path hits, NOT deduplicated — the like-for-like counterpart to countApiMentions. */
export function countPathHits(sources) {
  let n = 0
  for (const src of sources) n += [...src.matchAll(/apiUrl\}(\/[a-z0-9-]+)/g)].length
  return n
}

/**
 * How many times the frontend mentions the API base at all — counted a DIFFERENT way.
 *
 * `requiredEndpoints` recognises one spelling. "Derived zero" is already a hard failure, but
 * "derived SOME of them" was still silent, and that shape has now bitten three times (the
 * handleManage enumeration in #47, the tautological partition control in #49, and this).
 *
 * The fix is not a better regex — it is a second measurement that cannot be wrong in the same
 * way. This counts occurrences of `apiUrl}` with no opinion about what follows; the other
 * extracts paths. A call written in a form the path pattern cannot read still gets counted
 * here, so the two disagree. It deliberately does NOT derive from `requiredEndpoints`: a
 * number computed from the first would be an identity, green forever.
 */
export function countApiMentions(sources) {
  let n = 0
  for (const src of sources) n += [...src.matchAll(/\bapiUrl\b/g)].length
  return n
}

/**
 * The call sites the path pattern cannot read, with context.
 *
 * There is one today and it is legitimate: `fetch(`${config.apiUrl}${path}`)`, where the path
 * is a parameter and cannot be resolved statically. A hard failure on any gap would block
 * correct code forever, so these are REPORTED instead — the check says what it could not read
 * rather than presenting a partial list as complete. The unit tests pin the current count, so
 * a new unreadable spelling changes the number and fails there.
 */
export function unreadableCallSites(sources) {
  const out = []
  for (const src of sources) {
    // Anchored on `apiUrl`, NOT `apiUrl}`. The narrow anchor shared a blind spot with every
    // other function here: `config.apiUrl + '/zz'` contains no `apiUrl}` at all, so a
    // string-concatenated call was invisible to all four AT ONCE — it did not even register as
    // "a call site I could not read". Two instruments that go blind on the same input are one
    // instrument.
    for (const m of src.matchAll(/.{0,50}\bapiUrl\b.{0,30}/gs)) {
      if (!/apiUrl\}\/[a-z0-9-]/.test(m[0])) out.push(m[0].trim().replace(/\s+/g, ' '))
    }
  }
  return out
}

/**
 * The frontend modules that CALL the API — `config.ts` excluded.
 *
 * config.ts is where `apiUrl` is declared and assigned; its two mentions are the definition,
 * not call sites. Counting them would put a constant offset into every comparison below and
 * break the identity that makes the two-instrument check readable
 * (mentions − pathHits === unreadable call sites).
 */
export const DEFINITION_MODULE = 'config.ts'

export function readFrontendSources() {
  const dir = join(REPO_ROOT, 'src')
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && f !== DEFINITION_MODULE)
    .map((f) => readFileSync(join(dir, f), 'utf8'))
}

/**
 * Present, missing, or unknown — three states, never two.
 *
 * A route that 404s on BOTH verbs is absent. Anything else (400 for a bad body, 401 for no
 * signature, 200) means the route exists. A transport failure is `unknown`: reporting it as
 * "present" would greenlight a deploy against a worker nobody could reach, and reporting it as
 * "missing" would block a deploy over a flaky network.
 */
export function classify(getStatus, postStatus) {
  const seen = [getStatus, postStatus].filter((s) => s !== null)
  if (seen.length === 0) return 'unknown'
  // Any non-404 proves the route exists — it answered, it just rejected the probe.
  if (seen.some((s) => s !== 404)) return 'present'
  // Only 404s left. Two of them mean absent; ONE means we learned nothing.
  //
  // A write endpoint answers 404 to a GET, exactly like a route that does not exist —
  // measured on the live worker: GET /register, /set-addr, /transfer-subnode all 404, and so
  // does GET /__nope__. That is the entire reason for probing two verbs, so treating a lone
  // 404 as "present" throws away the only thing that made the probe informative.
  //
  // The earlier version returned 'present' here, reasoning "resolve toward the evidence we
  // have". That principle holds for (null, 200) — a 200 proves existence — and fails for
  // (404, null), where the evidence we have is precisely the reading that cannot tell the two
  // apart. They look like one rule and are two.
  //
  // It also removed an asymmetry: the sentinel check fails safe on a transient fault while a
  // real endpoint failed OPEN, so the same blip either blocked the whole run or greenlit a
  // deploy depending on which request it hit.
  if (seen.length === 2) return 'missing'
  return 'unknown'
}

async function probe(base, path) {
  const one = async (init) => {
    try {
      const res = await fetch(`${base}${path}`, init)
      return res.status
    } catch {
      return null
    }
  }
  const getStatus = await one({ method: 'GET' })

  // The POST probe sends `{}` — and that is SAFE TO RUN AGAINST PRODUCTION.
  //
  // Worth stating because it looks alarming and it stopped someone: a reviewer declined to run
  // this check against the live testnet worker for exactly this reason, and lost the one probe
  // that can distinguish "POST-only endpoint, absent" from "POST-only endpoint, deployed"
  // (a GET returns 404 either way).
  //
  // The proof is not an argument here — it is test/unit/write-endpoint-401.test.ts, which
  // derives the write-endpoint list from the router and asserts that each one answers 401 to an
  // unsigned request. That is end-to-end: a body without a valid signature is rejected before
  // anything is written, whatever the internal route.
  //
  // Structurally, the endpoints THIS CHECK PROBES do share one entry: all nine of
  //   /register /apply /approve /set-addr /set-text /set-contenthash /transfer-subnode
  //   /add-registrar /remove-registrar
  // dispatch into `handleManage`, whose first statement rejects a missing `from` — measured
  // 9/9, not asserted.
  //
  // KNOWN EXCEPTION: `/v1/register` is a write endpoint that does NOT go through handleManage
  // (it has its own handler). It is not in the probe set only because `requiredEndpoints`'
  // `[a-z0-9-]+` does not match the `/` inside `v1/register`. **If that pattern is ever
  // widened, this paragraph has to be redone for it** — the reasoning above would then be
  // covering an endpoint it never examined.
  //
  // I first wrote all of this as a test, and it asserted SEVEN names. Two counts were wrong at
  // once: the probe set is nine (I had dropped the two registrar endpoints, which happen to be
  // safe — and "happen to be" is the exact thing this paragraph exists to rule out), and the
  // set of write endpoints overall is ten. A true conclusion, argued over the wrong population,
  // guarded by a hardcoded list that could not see either gap.
  //
  // So the assertion is gone and the reasoning stays here, where the person deciding whether to
  // run this is looking. The guard that actually holds it up is the 401 file — deleting that is
  // what would make this comment a lie.
  const postStatus = await one({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  return classify(getStatus, postStatus)
}

/** Scheme + host only. The API URL is not secret, but this file must never grow a leak. */
export function redact(url) {
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.host}`
  } catch {
    return '(unparseable url)'
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2)
  const asJson = argv.includes('--json')
  const i = argv.indexOf('--api-url')
  const base = (i !== -1 ? argv[i + 1] : process.env.VITE_API_URL) ?? 'https://cometens-api.jhfnetboy.workers.dev'

  const sources = readFrontendSources()
  const required = requiredEndpoints(sources)
  if (required.length === 0) {
    const msg = 'derived zero required endpoints from src/ — the scan is broken, refusing to report success'
    if (asJson) console.log(JSON.stringify({ ok: false, error: msg }, null, 2))
    else console.error(`check-deploy-order: ${msg}`)
    process.exit(2)
  }

  // The two counts measure the same population differently, so their gap is exactly the set
  // one instrument can see and the other cannot. Shown, never hidden — a partial list
  // presented as complete is the failure this whole check exists to prevent.
  const unreadable = unreadableCallSites(sources)
  if (countApiMentions(sources) !== countPathHits(sources) && !asJson) {
    console.log(`note: ${unreadable.length} call site(s) could not be read statically and are NOT covered below:`)
    for (const u of unreadable) console.log(`  ${u}`)
    console.log('')
  }

  // A path that cannot exist. If the worker answers anything but 404/404 for this, the probe
  // cannot tell present from missing and every result below is meaningless.
  const sentinel = await probe(base, '/__definitely-not-a-route__')
  if (sentinel !== 'missing') {
    const msg = `probe control failed: a nonexistent route classified as "${sentinel}" against ${redact(base)}`
    if (asJson) console.log(JSON.stringify({ ok: false, error: msg }, null, 2))
    else console.error(`check-deploy-order: ${msg}`)
    process.exit(2)
  }

  const results = []
  for (const path of required) results.push({ path, state: await probe(base, path) })

  const missing = results.filter((r) => r.state === 'missing').map((r) => r.path)
  const unknown = results.filter((r) => r.state === 'unknown').map((r) => r.path)

  if (asJson) {
    console.log(JSON.stringify({ ok: missing.length === 0 && unknown.length === 0, api: redact(base), required, missing, unknown, unreadableCallSites: unreadable }, null, 2))
  } else {
    console.log(`check-deploy-order — ${redact(base)}`)
    for (const r of results) {
      const mark = r.state === 'present' ? 'OK  ' : r.state === 'missing' ? 'MISS' : '??  '
      console.log(`  ${mark} ${r.path}`)
    }
    console.log('')
    if (missing.length) {
      console.log(`${missing.length} endpoint(s) the frontend calls do not exist on this API worker:`)
      console.log(`  ${missing.join(', ')}`)
      console.log('')
      console.log('Deploy the API worker BEFORE publishing the frontend:')
      console.log('  cd workers/api && wrangler deploy --env testnet')
    } else if (unknown.length) {
      console.log(`could not reach ${unknown.length} endpoint(s) — not a pass, retry`)
    } else {
      console.log(`all ${required.length} endpoints present`)
    }
  }
  process.exit(missing.length ? 1 : unknown.length ? 2 : 0)
}
