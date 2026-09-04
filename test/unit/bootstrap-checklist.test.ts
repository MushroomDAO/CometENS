import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The bootstrap checklist must be self-sufficient.
 *
 * Its whole promise is "follow this and you have a working deployment, without contacting
 * us". The first version failed on its own last step: it told the reader to run the
 * resolution check, but the .env.local block it printed was missing two of the variables
 * that check reads. Following the instructions exactly produced
 * `Missing VITE_L1_SEPOLIA_RPC_URL in .env.local`.
 *
 * Nothing else catches this. The script runs fine, the dry run exits 0, and the checklist is
 * just printed text — the gap only appears when a human actually follows it.
 */

const ROOT = join(__dirname, '../..')

function checklist(): string {
  return execFileSync(
    'node',
    ['scripts/bootstrap-community.mjs', '--root', 'test.eth', '--owner', `0x${'11'.repeat(20)}`, '--dry-run'],
    { cwd: ROOT, encoding: 'utf8' },
  )
}

/** Variables the end-to-end verification script reads out of .env.local. */
function varsRequiredByVerifier(): string[] {
  const sh = readFileSync(join(ROOT, 'scripts/resolve-testnet.sh'), 'utf8')
  return [...new Set([...sh.matchAll(/load_env_var (\w+)/g)].map((m) => m[1]))]
}

describe('bootstrap checklist is followable', () => {
  const out = checklist()

  it('reads the verifier requirements at all (must-find control)', () => {
    // An empty requirement list would make the assertion below vacuously true.
    expect(varsRequiredByVerifier().length).toBeGreaterThan(0)
    expect(out.length).toBeGreaterThan(0)
  })

  it('names every variable the verification step will read', () => {
    const missing = varsRequiredByVerifier().filter((v) => !out.includes(v))
    expect(missing, 'checklist tells the reader to run a check it did not configure them for').toEqual([])
  })

  it('says where the L1 resolver comes from', () => {
    // The script deploys L2Records only. Telling someone to "set the resolver to your L1
    // resolver" without saying where that comes from leaves the biggest step undefined.
    expect(out).toMatch(/DeployHybridResolver|L1 resolver/)
  })

  it('prints the checklist in dry run too', () => {
    // Someone deciding whether to adopt this needs to see what they are signing up for
    // before spending anything.
    expect(out).toContain('DRY RUN')
    expect(out).toContain('.env.local')
  })
})
