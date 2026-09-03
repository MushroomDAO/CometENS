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

export function readFrontendSources() {
  const dir = join(REPO_ROOT, 'src')
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
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
  if (getStatus === null && postStatus === null) return 'unknown'
  if (getStatus === 404 && postStatus === 404) return 'missing'
  return 'present'
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

  const required = requiredEndpoints(readFrontendSources())
  if (required.length === 0) {
    const msg = 'derived zero required endpoints from src/ — the scan is broken, refusing to report success'
    if (asJson) console.log(JSON.stringify({ ok: false, error: msg }, null, 2))
    else console.error(`check-deploy-order: ${msg}`)
    process.exit(2)
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
    console.log(JSON.stringify({ ok: missing.length === 0 && unknown.length === 0, api: redact(base), required, missing, unknown }, null, 2))
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
