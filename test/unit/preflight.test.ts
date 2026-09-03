import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error — plain .mjs module, no type declarations (see scripts/preflight.mjs header)
import { staticChecks, probeChain, render, summarize, addressOf, readWranglerVars, readEnvFiles, LOOKS_LIKE_KEY, KEY_ROLES, separationSeverity } from '../../scripts/preflight.mjs'

// Synthetic 32-byte keys. Deliberately NOT real or well-known test keys: this file asserts
// that key material never reaches the output, so it must not itself ship anything that a
// reader could mistake for a usable key.
const KEY_A = `0x${'11'.repeat(32)}`
const KEY_B = `0x${'22'.repeat(32)}`
const KEY_C = `0x${'33'.repeat(32)}`

const VALID = {
  L2_RECORDS_ADDRESS: '0xbA692CdfDA33916BbE8d2a1f23E80218db8ebFDc',
  ROOT_DOMAIN: 'community.eth',
  OP_SEPOLIA_RPC_URL: 'https://sepolia.optimism.io',
  WORKER_EOA_PRIVATE_KEY: KEY_A,
  PRIVATE_KEY_SUPPLIER: KEY_B,
  PRIVATE_KEY_JASON: KEY_C,
}

const find = (findings: any[], id: string | number) => findings.find((f) => String(f.id) === String(id))

describe('preflight — required configuration', () => {
  it('FAILs when required variables are missing', () => {
    const f = find(staticChecks({}), 1)
    expect(f.level).toBe('FAIL')
    expect(f.detail).toMatch(/L2_RECORDS_ADDRESS/)
    expect(f.detail).toMatch(/ROOT_DOMAIN/)
  })

  it('PASSes when they are all present', () => {
    expect(find(staticChecks(VALID), 1).level).toBe('PASS')
  })
})

describe('preflight — private key format', () => {
  it('FAILs on a malformed key and names the variable, not the value', () => {
    const bad = 'not-a-key'
    const f = find(staticChecks({ ...VALID, WORKER_EOA_PRIVATE_KEY: bad }), 2)
    expect(f.level).toBe('FAIL')
    expect(f.detail).toContain('WORKER_EOA_PRIVATE_KEY')
    expect(f.detail).not.toContain(bad)
  })

  it('PASSes on well-formed keys', () => {
    expect(find(staticChecks(VALID), 2).level).toBe('PASS')
  })

  it('addressOf returns null for absent or malformed keys', () => {
    expect(addressOf(undefined)).toBeNull()
    expect(addressOf('0xdeadbeef')).toBeNull()
    expect(addressOf(KEY_A)).toMatch(/^0x[0-9a-fA-F]{40}$/)
  })
})

describe('preflight — key exposed to the browser bundle', () => {
  // VITE_ variables are compiled into the client bundle and served to every visitor.
  // This is the single most damaging mistake this script exists to catch, so it is a FAIL.
  it('FAILs when a VITE_-prefixed variable holds a private key', () => {
    const f = find(staticChecks({ ...VALID, VITE_SECRET: KEY_A }), 3)
    expect(f.level).toBe('FAIL')
    expect(f.detail).toContain('VITE_SECRET')
    expect(f.hint).toMatch(/rotate/i)
  })

  it('PASSes when no VITE_ variable looks like a key', () => {
    expect(find(staticChecks(VALID), 3).level).toBe('PASS')
  })

  it('does not flag ordinary VITE_ values', () => {
    const f = find(staticChecks({ ...VALID, VITE_GATEWAY_URL: 'https://example.workers.dev' }), 3)
    expect(f.level).toBe('PASS')
  })
})

describe('preflight — key role separation', () => {
  it('WARNs when one key serves several roles', () => {
    const reused = { ...VALID, WORKER_EOA_PRIVATE_KEY: KEY_A, PRIVATE_KEY_SUPPLIER: KEY_A, PRIVATE_KEY_JASON: KEY_A }
    const f = find(staticChecks(reused), '3b')
    expect(f.level).toBe('WARN')
    expect(f.detail).toMatch(/3 roles/)
    // It must report the derived ADDRESS, never the key.
    expect(f.detail).toMatch(/0x[0-9a-fA-F]{40}/)
    expect(f.detail).not.toContain(KEY_A)
  })

  it('PASSes when every role has its own key', () => {
    const f = find(staticChecks(VALID), '3b')
    expect(f.level).toBe('PASS')
    expect(f.detail).toMatch(/3 distinct/)
  })

  // A PASS here must mean "checked, and they are separate" — never "only one role happened
  // to be visible". The single-visible-key case is the NORMAL shape for the recommended
  // deployment (owner cold, the rest as Workers secrets), so reporting it as separation
  // verified is a false assurance about exactly the thing under review.
  it('does NOT claim separation when only one role is visible', () => {
    const partial = { ...VALID, PRIVATE_KEY_SUPPLIER: undefined, PRIVATE_KEY_JASON: undefined }
    const f = find(staticChecks(partial), '3b')
    expect(f.level).toBe('WARN')
    expect(f.detail).toMatch(/only 1 of 3/)
    expect(f.detail).toMatch(/PRIVATE_KEY_SUPPLIER/)
    expect(f.detail).not.toMatch(/distinct/)
  })

  it('does NOT disappear when no key is visible at all', () => {
    const none = {
      ...VALID,
      WORKER_EOA_PRIVATE_KEY: undefined,
      PRIVATE_KEY_SUPPLIER: undefined,
      PRIVATE_KEY_JASON: undefined,
    }
    const f = find(staticChecks(none), '3b')
    expect(f).toBeDefined()
    expect(f.level).toBe('WARN')
    expect(f.detail).toMatch(/no signing keys visible/)
  })
})

describe('preflight — dotenv coverage matches Vite', () => {
  // Vite loads .env and .env.[mode] as well as .env.local. Reading only .env.local left the
  // detection surface narrower than the exposure surface: a VITE_-prefixed key parked in
  // .env would have been reported clean.
  it('reads a plain .env file, not just .env.local', () => {
    const dir = mkdtempSync(join(tmpdir(), 'preflight-dotenv-'))
    writeFileSync(join(dir, '.env'), `VITE_SNEAKY=${KEY_A}\n`)
    const vars = readEnvFiles(dir)
    expect(vars.VITE_SNEAKY).toBe(KEY_A)
    // Fed through the actual check, it must FAIL rather than merely be present.
    expect(find(staticChecks({ ...VALID, ...vars }), 3).level).toBe('FAIL')
  })

  it('.env.local wins over .env (Vite precedence)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'preflight-dotenv-'))
    writeFileSync(join(dir, '.env'), 'ROOT_DOMAIN=from-env.eth\n')
    writeFileSync(join(dir, '.env.local'), 'ROOT_DOMAIN=from-local.eth\n')
    expect(readEnvFiles(dir).ROOT_DOMAIN).toBe('from-local.eth')
  })
})

describe('preflight — RPC endpoint is reported, not silently defaulted', () => {
  // Folding the RPC into the required-variable list made that entry impossible to trigger
  // (there is always a public default), i.e. a check that cannot fail.
  it('says so when falling back to the public default', () => {
    const f = find(staticChecks({ ...VALID, OP_SEPOLIA_RPC_URL: undefined }), '1b')
    expect(f.detail).toMatch(/public default/)
  })
  it('says so when configured explicitly', () => {
    expect(find(staticChecks(VALID), '1b').detail).toMatch(/explicitly/)
  })
})

describe('preflight — root domain', () => {
  it('FAILs on a non-.eth name', () => {
    expect(find(staticChecks({ ...VALID, ROOT_DOMAIN: 'community.example' }), 8).level).toBe('FAIL')
  })
  it('PASSes on a valid .eth name', () => {
    expect(find(staticChecks(VALID), 8).level).toBe('PASS')
  })
})

describe('preflight — a fully valid config produces no failures', () => {
  it('reports zero FAILs', () => {
    expect(summarize(staticChecks(VALID)).fail).toBe(0)
  })
})

describe('preflight — chain probe (stubbed, no network)', () => {
  const stub = (over: Record<string, any> = {}) => () => ({
    getChainId: async () => 11155420,
    getCode: async () => '0x60006000',
    readContract: async () => '0x1111111111111111111111111111111111111111',
    getBalance: async () => 1000000000000000n,
    ...over,
  })

  it('PASSes against a healthy chain', async () => {
    const f = await probeChain(VALID, 'testnet', stub())
    expect(find(f, 4).level).toBe('PASS')
    expect(find(f, 5).level).toBe('PASS')
    expect(find(f, 6).level).toBe('PASS')
  })

  it('FAILs when the RPC is on the wrong chain', async () => {
    const f = await probeChain(VALID, 'testnet', stub({ getChainId: async () => 1 }))
    expect(find(f, 4).level).toBe('FAIL')
    expect(find(f, 4).detail).toMatch(/expected 11155420/)
  })

  it('FAILs when the address holds no contract', async () => {
    const f = await probeChain(VALID, 'testnet', stub({ getCode: async () => '0x' }))
    expect(find(f, 5).level).toBe('FAIL')
  })

  it('WARNs (not FAILs) on a zero balance', async () => {
    const f = await probeChain(VALID, 'testnet', stub({ getBalance: async () => 0n }))
    expect(find(f, 7).level).toBe('WARN')
    expect(summarize(f).fail).toBe(0)
  })
})

describe('preflight — never emits key material', () => {
  // The hard rule from spec.md §1. Asserted on the rendered output rather than on individual
  // fields, because rendering is what actually reaches a terminal, a CI log or a pasted report.
  const hostile = {
    ...VALID,
    WORKER_EOA_PRIVATE_KEY: KEY_A,
    PRIVATE_KEY_SUPPLIER: KEY_A,
    VITE_LEAKED: KEY_B,
    ROOT_DOMAIN: 'bad domain',
  }

  it('text output contains no 64-hex string', () => {
    const out = render(staticChecks(hostile), false)
    expect(LOOKS_LIKE_KEY.test(out)).toBe(false)
  })

  it('json output contains no 64-hex string', () => {
    const out = render(staticChecks(hostile), true)
    expect(LOOKS_LIKE_KEY.test(out)).toBe(false)
  })

  it('the leak detector itself works (must-leak control)', () => {
    // Without this, "no 64-hex found" and "the matcher is broken" look identical.
    expect(LOOKS_LIKE_KEY.test(`prefix ${KEY_A} suffix`)).toBe(true)
  })
})

describe('preflight — wrangler.toml block boundary', () => {
  // Regression guard for the defect found reviewing PR #22 in the sibling check-chain.mjs:
  // an `indexOf('\n[')` scan does not stop at an INDENTED section header (valid TOML), so
  // the block absorbs the next env's values and the caller silently gets the wrong chain's
  // configuration. Two spaces separated a correct answer from a wrong one.
  const write = (content: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'preflight-toml-'))
    writeFileSync(join(dir, 'wrangler.toml'), content)
    return join(dir, 'wrangler.toml')
  }

  const TESTNET_OWN = [
    '[env.testnet.vars]',
    'L2_RECORDS_ADDRESS = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"',
    '',
    '[env.production.vars]',
    'L2_RECORDS_ADDRESS = "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"',
  ].join('\n')

  const INDENTED_NEXT = [
    '[env.testnet.vars]',
    'NETWORK = "op-sepolia"',
    '',
    '  [env.production.vars]',
    '  L2_RECORDS_ADDRESS = "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"',
  ].join('\n')

  it('reads the requested block', () => {
    const vars = readWranglerVars(write(TESTNET_OWN), 'testnet')
    expect(vars.L2_RECORDS_ADDRESS).toBe('0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
  })

  it('does NOT leak the next env past an indented section header', () => {
    const vars = readWranglerVars(write(INDENTED_NEXT), 'testnet')
    expect(vars.L2_RECORDS_ADDRESS).toBeUndefined()
  })

  it('does not leak past a column-0 header either (control)', () => {
    const flat = INDENTED_NEXT.replace(/^ {2}/gm, '')
    expect(readWranglerVars(write(flat), 'testnet').L2_RECORDS_ADDRESS).toBeUndefined()
  })

  it('returns {} for a missing file or absent section', () => {
    expect(readWranglerVars('/nonexistent/wrangler.toml', 'testnet')).toEqual({})
    expect(readWranglerVars(write(TESTNET_OWN), 'staging')).toEqual({})
  })
})

describe('preflight — third-party error strings are scrubbed', () => {
  // viem puts the full RPC URL in error.message, and provider keys live in that URL's path.
  // Safety must not depend on shortMessage always being present (a viem property, not ours).
  it('redacts a credential-bearing URL from an error that only has .message', async () => {
    const secret = 'SENTINEL_KEY_abcdef123456'
    const boom = { message: `HTTP request failed: https://opt-sepolia.g.alchemy.com/v2/${secret}` }
    const f = await probeChain(VALID, 'testnet', () => ({
      getChainId: async () => { throw boom },
    }))
    expect(find(f, 4).level).toBe('FAIL')
    expect(find(f, 4).detail).not.toContain(secret)
    expect(find(f, 4).detail).toContain('(redacted)')
  })

  it('the sentinel would be detectable if it were not scrubbed (must-leak control)', () => {
    // Without this, "secret absent" and "the assertion is vacuous" look identical.
    expect(`prefix SENTINEL_KEY_abcdef123456 suffix`).toContain('SENTINEL_KEY_abcdef123456')
  })
})

describe('preflight — repo example values are not reported as your configuration', () => {
  // On a fresh clone the committed wrangler.toml carries the REFERENCE deployment, so
  // preflight used to report "7 passed, 0 failures" with OUR root domain, OUR contract and
  // OUR owner — to someone who had configured nothing. That is step 1 of SELF-HOSTING.md,
  // and false confidence there propagates through every later step.
  const REPO_DEFAULTS = { ROOT_DOMAIN: 'aastar.eth', L2_RECORDS_ADDRESS: '0xbA692CdfDA33916BbE8d2a1f23E80218db8ebFDc' }
  const asRepoShipped = { ...VALID, ...REPO_DEFAULTS }

  it('WARNs when the values are still the repo examples', () => {
    const f = find(staticChecks(asRepoShipped, 'testnet', REPO_DEFAULTS), 1)
    expect(f.level).toBe('WARN')
    expect(f.detail).toMatch(/example value/)
    expect(f.hint).toMatch(/not yours/)
  })

  it('names the root domain as an example too', () => {
    const f = find(staticChecks(asRepoShipped, 'testnet', REPO_DEFAULTS), 8)
    expect(f.level).toBe('WARN')
    expect(f.detail).toContain('not yours')
  })

  it('PASSes once the operator sets their own values (control)', () => {
    // Without this the fix could degrade into "always WARN", which is equally useless.
    const own = { ...VALID, ROOT_DOMAIN: 'mycommunity.eth', L2_RECORDS_ADDRESS: `0x${'de'.repeat(20)}` }
    expect(find(staticChecks(own, 'testnet', REPO_DEFAULTS), 1).level).toBe('PASS')
    expect(find(staticChecks(own, 'testnet', REPO_DEFAULTS), 8).level).toBe('PASS')
  })

  it('names only the field still holding an example (partial control)', () => {
    const half = { ...asRepoShipped, ROOT_DOMAIN: 'mycommunity.eth' }
    const f = find(staticChecks(half, 'testnet', REPO_DEFAULTS), 1)
    expect(f.level).toBe('WARN')
    expect(f.detail).toContain('L2_RECORDS_ADDRESS')
    expect(f.detail).not.toContain('ROOT_DOMAIN')
  })

  it('does not warn when the defaults are unknown (git unavailable)', () => {
    // null/undefined means "could not check", and inventing a warning from that would be
    // the same false confidence in the other direction.
    expect(find(staticChecks(asRepoShipped, 'testnet', undefined), 1).level).toBe('PASS')
  })
})

describe('preflight 3b — three roles, three keys', () => {
  const K = {
    writer: `0x${'11'.repeat(32)}`,
    gateway: `0x${'22'.repeat(32)}`,
    owner: `0x${'33'.repeat(32)}`,
  }
  const base = {
    NETWORK: 'testnet',
    L2_RECORDS_ADDRESS: `0x${'ab'.repeat(20)}`,
    ROOT_DOMAIN: 'community.eth',
  }
  const check3b = (env) => staticChecks({ ...base, ...env }).find((c) => String(c.id) === '3b')

  it('three distinct keys PASS', () => {
    const c = check3b({ WRITER_KEY: K.writer, GATEWAY_SIGNER_KEY: K.gateway, OWNER_KEY: K.owner })
    expect(c.level).toBe('PASS')
  })

  it('one key for all three roles WARNs by default', () => {
    // Self-hosting starts this way and that is a reasonable place to begin — failing here
    // would block a first deployment over a risk the operator may knowingly accept.
    const c = check3b({ WRITER_KEY: K.writer, GATEWAY_SIGNER_KEY: K.writer, OWNER_KEY: K.writer })
    expect(c.level).toBe('WARN')
    expect(c.detail).toMatch(/3 roles/)
  })

  it('the SAME finding FAILs under PREFLIGHT_KEY_SEPARATION=strict', () => {
    // A delegated deployment holds other communities' names; the same finding is disqualifying.
    const c = check3b({
      WRITER_KEY: K.writer, GATEWAY_SIGNER_KEY: K.writer, OWNER_KEY: K.writer,
      PREFLIGHT_KEY_SEPARATION: 'strict',
    })
    expect(c.level).toBe('FAIL')
  })

  it('strict does NOT turn a clean config into a failure (control)', () => {
    // Without this, "always FAIL when strict" would pass the assertion above.
    const c = check3b({
      WRITER_KEY: K.writer, GATEWAY_SIGNER_KEY: K.gateway, OWNER_KEY: K.owner,
      PREFLIGHT_KEY_SEPARATION: 'strict',
    })
    expect(c.level).toBe('PASS')
  })

  it('an unrecognised PREFLIGHT_KEY_SEPARATION value stops the run', () => {
    // This test used to assert WARN, and that was the wrong property to pin. It checked that a
    // typo does not silently mean STRICT — but the dangerous direction is the other one: a
    // typo silently meaning WARN leaves a delegated operator believing the gate is on. The
    // assertion was true and useless, which is worse than absent.
    expect(() =>
      check3b({
        WRITER_KEY: K.writer, GATEWAY_SIGNER_KEY: K.writer, OWNER_KEY: K.writer,
        PREFLIGHT_KEY_SEPARATION: 'yes',
      }),
    ).toThrow(/Refusing to guess/)
  })

  it('legacy names still resolve, and are reported separately from separation', () => {
    const checks = staticChecks({
      ...base,
      WORKER_EOA_PRIVATE_KEY: K.writer,
      PRIVATE_KEY_SUPPLIER: K.gateway,
      PRIVATE_KEY_JASON: K.owner,
    })
    expect(checks.find((c) => c.id === '3b').level).toBe('PASS')
    const nudge = checks.find((c) => String(c.id) === '3c')
    expect(nudge.level).toBe('WARN')
    expect(nudge.detail).toContain('WORKER_EOA_PRIVATE_KEY')
  })

  it('a clean modern config produces NO legacy nudge (control)', () => {
    // Without this, always emitting 3c would pass the assertion above.
    const checks = staticChecks({ ...base, WRITER_KEY: K.writer, GATEWAY_SIGNER_KEY: K.gateway, OWNER_KEY: K.owner })
    expect(checks.find((c) => String(c.id) === '3c')).toBeUndefined()
  })

  it('two names for one role with DIFFERENT keys is a FAIL, whatever the severity setting', () => {
    // The workers refuse to start on this. Reporting it as a separation warning would bury the
    // finding that stops the deployment dead — and it fails even without strict.
    const c = check3b({ GATEWAY_SIGNER_KEY: K.gateway, PRIVATE_KEY_SUPPLIER: K.owner })
    expect(c.level).toBe('FAIL')
    expect(c.detail).toContain('GATEWAY_SIGNER_KEY')
    expect(c.detail).toContain('PRIVATE_KEY_SUPPLIER')
  })

  it('two names for one role with the SAME key is not a conflict (control)', () => {
    // That is what a careful migration looks like; refusing it would break the safe path.
    const c = check3b({ GATEWAY_SIGNER_KEY: K.gateway, PRIVATE_KEY_SUPPLIER: K.gateway, WRITER_KEY: K.writer, OWNER_KEY: K.owner })
    expect(c.level).toBe('PASS')
  })

  it('no keys visible is still "not verified", not PASS', () => {
    expect(check3b({}).level).toBe('WARN')
    expect(check3b({}).detail).toMatch(/not verified/)
  })

  it('never prints key material (control: the sentinel is detectable)', () => {
    const checks = staticChecks({ ...base, WRITER_KEY: K.writer, GATEWAY_SIGNER_KEY: K.gateway, OWNER_KEY: K.owner })
    const blob = JSON.stringify(checks)
    expect(blob).not.toContain(K.writer)
    expect(`x${K.writer}x`).toContain(K.writer)
  })
})

describe('preflight and the workers must read the SAME variables', () => {
  it('KEY_ROLES matches ROLE_ENV_VARS in signer.ts', async () => {
    // preflight is plain .mjs and cannot import the .ts module the workers use, so the table is
    // duplicated. Drift would make preflight check variables nobody reads and report PASS on a
    // deployment whose real keys it never looked at — a false green, not a missing check.
    const { ROLE_ENV_VARS } = await import('../../server/gateway/signer')
    const fromPreflight = KEY_ROLES.map((r) => r.names.join(','))
    const fromSigner = Object.values(ROLE_ENV_VARS).map((n) => n.join(','))
    expect(fromPreflight).toEqual(fromSigner)
  })

  it('the comparison is not vacuous (control)', async () => {
    const { ROLE_ENV_VARS } = await import('../../server/gateway/signer')
    expect(Object.keys(ROLE_ENV_VARS).length).toBe(3)
    expect(KEY_ROLES.length).toBe(3)
  })
})

describe('separationSeverity refuses to guess, like resolveMode does', () => {
  // pr-daemon: this was inconsistent with my own approval.ts, whose comment reads "refusing to
  // guess, because guessing wrong hands out names you meant to review". That sentence applies
  // verbatim here — and the direction of a wrong guess is DOWNGRADING a safety gate.
  it('unset and empty mean the default, not an error', () => {
    expect(separationSeverity({})).toBe('WARN')
    expect(separationSeverity({ PREFLIGHT_KEY_SEPARATION: '' })).toBe('WARN')
  })

  it('accepts both explicit values, case-insensitively', () => {
    expect(separationSeverity({ PREFLIGHT_KEY_SEPARATION: 'strict' })).toBe('FAIL')
    expect(separationSeverity({ PREFLIGHT_KEY_SEPARATION: 'STRICT' })).toBe('FAIL')
    expect(separationSeverity({ PREFLIGHT_KEY_SEPARATION: 'warn' })).toBe('WARN')
  })

  it('THROWS on a typo rather than silently downgrading', () => {
    // `stict` used to yield WARN — a delegated operator would believe strict was on while
    // preflight stayed green on a shared key.
    expect(() => separationSeverity({ PREFLIGHT_KEY_SEPARATION: 'stict' })).toThrow(/Refusing to guess/)
    expect(() => separationSeverity({ PREFLIGHT_KEY_SEPARATION: '1' })).toThrow()
    expect(() => separationSeverity({ PREFLIGHT_KEY_SEPARATION: 'true' })).toThrow()
  })

  it('the error names the variable and the accepted values (control)', () => {
    try {
      separationSeverity({ PREFLIGHT_KEY_SEPARATION: 'zzz' })
    } catch (e: any) {
      expect(e.message).toContain('PREFLIGHT_KEY_SEPARATION')
      expect(e.message).toContain('strict')
      expect(e.message).toContain('warn')
    }
  })
})

describe('the severity knob is validated because it was SET, not because it was needed', () => {
  it('a typo is caught even when the keys are already separate', () => {
    // Called lazily it only ran when a shared key was found, so an operator whose keys happened
    // to be separate got no signal — and would meet the silent downgrade later, at the exact
    // moment a key started being shared. Found by running preflight for real; the unit tests
    // above all passed while this hole was open.
    expect(() =>
      staticChecks({
        NETWORK: 'testnet',
        L2_RECORDS_ADDRESS: `0x${'ab'.repeat(20)}`,
        ROOT_DOMAIN: 'community.eth',
        WRITER_KEY: `0x${'11'.repeat(32)}`,
        GATEWAY_SIGNER_KEY: `0x${'22'.repeat(32)}`,
        OWNER_KEY: `0x${'33'.repeat(32)}`,
        PREFLIGHT_KEY_SEPARATION: 'stict',
      }),
    ).toThrow(/Refusing to guess/)
  })

  it('and with NO keys visible at all (control)', () => {
    // The emptiest possible input still validates the knob — nothing short-circuits past it.
    expect(() =>
      staticChecks({ NETWORK: 'testnet', PREFLIGHT_KEY_SEPARATION: 'stict' }),
    ).toThrow(/Refusing to guess/)
  })

  it('a correct value never throws, in either shape (control)', () => {
    const base = { NETWORK: 'testnet', ROOT_DOMAIN: 'community.eth', L2_RECORDS_ADDRESS: `0x${'ab'.repeat(20)}` }
    expect(() => staticChecks({ ...base, PREFLIGHT_KEY_SEPARATION: 'strict' })).not.toThrow()
    expect(() => staticChecks(base)).not.toThrow()
  })
})

describe('preflight 3d — a self-hosted frontend must not silently point at us', () => {
  // Acceptance A4 is "no step needs our worker". src/config.ts falls back to OUR workers when
  // VITE_API_URL / VITE_GATEWAY_URL are unset, and SELF-HOSTING.md never mentioned either —
  // so a self-hoster following the guide built a frontend routed through our infrastructure
  // with nothing in the output saying so. I had recorded A4 as SATISFIED on the evidence that
  // our domain appears 0 times in that guide; the 0 was real and the conclusion backwards.
  const base = { NETWORK: 'testnet', L2_RECORDS_ADDRESS: `0x${'ab'.repeat(20)}`, ROOT_DOMAIN: 'community.eth' }
  const check3d = (env: Record<string, string>) =>
    staticChecks({ ...base, ...env }).find((c: any) => String(c.id) === '3d')

  it('unset means the default, and the default is us', () => {
    const c = check3d({})
    expect(c.level).toBe('WARN')
    expect(c.detail).toMatch(/unset/)
  })

  it('explicitly set to our worker is the same finding', () => {
    // Someone who copied .env from this repo has it set, not unset — the check has to look at
    // the value, not just at presence.
    expect(check3d({
      VITE_API_URL: 'https://cometens-api.jhfnetboy.workers.dev',
      VITE_GATEWAY_URL: 'https://mine.workers.dev',
    }).level).toBe('WARN')
  })

  it('both pointing elsewhere PASSes (control)', () => {
    // Without this, a check that always warned would satisfy both assertions above and tell a
    // correctly-configured self-hoster they are misconfigured — which is how guards get muted.
    expect(check3d({
      VITE_API_URL: 'https://mine.workers.dev',
      VITE_GATEWAY_URL: 'https://mine2.workers.dev',
    }).level).toBe('PASS')
  })

  it('one of the two is enough to warn (control)', () => {
    // The gateway alone routes every resolution through us even if writes go elsewhere.
    expect(check3d({
      VITE_API_URL: 'https://mine.workers.dev',
      VITE_GATEWAY_URL: 'https://cometens-gateway.jhfnetboy.workers.dev',
    }).level).toBe('WARN')
  })
})
