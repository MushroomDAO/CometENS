import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error — plain .mjs module, no type declarations (see scripts/preflight.mjs header)
import { staticChecks, probeChain, render, summarize, addressOf, readWranglerVars, readEnvFiles, LOOKS_LIKE_KEY } from '../../scripts/preflight.mjs'

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
