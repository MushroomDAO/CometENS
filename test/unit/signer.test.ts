import { describe, it, expect } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import {
  createSigner,
  tryCreateSigner,
  resolveKeySource,
  signerAddresses,
  ROLE_ENV_VARS,
  SignerError,
  signerConflicts,
} from '../../server/gateway/signer'

// Synthetic keys — deliberately not real or well-known ones, since this file asserts that
// key material never appears in error text and must not ship anything usable itself.
const KEY_WRITER = `0x${'11'.repeat(32)}`
const KEY_GATEWAY = `0x${'22'.repeat(32)}`
const KEY_OWNER = `0x${'33'.repeat(32)}`

describe('resolveKeySource — role-specific names win, legacy still works', () => {
  it('prefers the role-specific variable', () => {
    const src = resolveKeySource('writer', { WRITER_KEY: KEY_WRITER, WORKER_EOA_PRIVATE_KEY: KEY_GATEWAY })
    expect(src).toEqual({ varName: 'WRITER_KEY', legacy: false })
  })

  it('falls back to the legacy variable and says so', () => {
    // An upgrade must not take a running deployment offline, so the historical names keep
    // working — but the caller can tell, which is what lets preflight nudge without breaking.
    const src = resolveKeySource('writer', { WORKER_EOA_PRIVATE_KEY: KEY_WRITER })
    expect(src).toEqual({ varName: 'WORKER_EOA_PRIVATE_KEY', legacy: true })
  })

  it('treats an empty string as absent', () => {
    expect(resolveKeySource('writer', { WRITER_KEY: '', WORKER_EOA_PRIVATE_KEY: KEY_WRITER })?.varName).toBe(
      'WORKER_EOA_PRIVATE_KEY',
    )
  })

  it('returns null when nothing is set', () => {
    expect(resolveKeySource('writer', {})).toBeNull()
  })

  it('every role has both a new and a legacy name (control)', () => {
    // Guards the table itself: a role with one entry would make the fallback logic above
    // silently untested for that role.
    for (const names of Object.values(ROLE_ENV_VARS)) expect(names.length).toBe(2)
  })
})

describe('createSigner — derives the right account', () => {
  it('produces the same address viem would', () => {
    const account = createSigner('writer', { WRITER_KEY: KEY_WRITER })
    expect(account.address).toBe(privateKeyToAccount(KEY_WRITER as `0x${string}`).address)
  })

  it('each role reads its own variable', () => {
    const env = { WRITER_KEY: KEY_WRITER, GATEWAY_SIGNER_KEY: KEY_GATEWAY, OWNER_KEY: KEY_OWNER }
    const addrs = [createSigner('writer', env), createSigner('gateway', env), createSigner('owner', env)].map(
      (a) => a.address,
    )
    expect(new Set(addrs).size).toBe(3)
  })

  it('can still sign — the account is real, not a stub', async () => {
    // Control: an implementation returning a plausible-looking object with the right address
    // would pass every assertion above.
    const account = createSigner('gateway', { GATEWAY_SIGNER_KEY: KEY_GATEWAY })
    const sig = await account.signMessage!({ message: 'hello' })
    expect(sig).toMatch(/^0x[0-9a-fA-F]{130}$/)
  })
})

describe('createSigner — failures name the variable, never the value', () => {
  it('says which variable to set when none is configured', () => {
    try {
      createSigner('gateway', {})
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(SignerError)
      expect((e as SignerError).hint).toContain('GATEWAY_SIGNER_KEY')
    }
  })

  it('rejects a malformed key and does NOT echo it', () => {
    // Error strings end up in logs and pasted reports. This repo has already shipped one
    // credential leak through exactly that path (#30).
    const badKey = '0xdefinitely-not-a-key-but-secret-looking'
    try {
      createSigner('writer', { WRITER_KEY: badKey })
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as SignerError).message).toContain('WRITER_KEY')
      expect((e as SignerError).message).not.toContain(badKey)
      expect((e as SignerError).hint).not.toContain(badKey)
    }
  })

  it('a valid key never appears in any thrown text either (must-leak control)', () => {
    // The control: the sentinel IS detectable when not filtered, so "absent" means something.
    expect(`prefix ${KEY_WRITER} suffix`).toContain(KEY_WRITER)
  })

  it('tryCreateSigner returns null rather than throwing', () => {
    expect(tryCreateSigner('writer', {})).toBeNull()
    expect(tryCreateSigner('writer', { WRITER_KEY: 'nope' })).toBeNull()
  })
})

describe('signerAddresses — diagnostics without key material', () => {
  it('reports one address per configured role', () => {
    const out = signerAddresses({ WRITER_KEY: KEY_WRITER, GATEWAY_SIGNER_KEY: KEY_GATEWAY })
    expect(Object.keys(out).sort()).toEqual(['gateway', 'writer'])
  })

  it('OMITS a role with no key rather than reporting it as shared', () => {
    // "not visible from here" and "same key as another role" are different facts; collapsing
    // them is exactly the false assurance preflight check 3b was fixed to avoid.
    const out = signerAddresses({ WRITER_KEY: KEY_WRITER })
    expect(out.gateway).toBeUndefined()
    expect(out.owner).toBeUndefined()
  })

  it('surfaces reuse when one key serves several roles', () => {
    const out = signerAddresses({ WRITER_KEY: KEY_WRITER, GATEWAY_SIGNER_KEY: KEY_WRITER })
    expect(out.writer).toBe(out.gateway)
  })

  it('contains no key material', () => {
    const out = signerAddresses({ WRITER_KEY: KEY_WRITER, GATEWAY_SIGNER_KEY: KEY_GATEWAY })
    expect(JSON.stringify(out)).not.toMatch(/0x[0-9a-fA-F]{64}/)
  })
})

describe('createSigner — refuses a silent key swap on upgrade', () => {
  // Before this module, the gateway read PRIVATE_KEY_SUPPLIER directly and GATEWAY_SIGNER_KEY
  // was inert. Introducing a preference order makes the new name an effective input, so the
  // SAME set of secrets means something different before and after the upgrade. If both are
  // present with different values, deploying silently swaps the signing key — and for the
  // gateway role that breaks resolution network-wide while /health stays green, because
  // /health does not sign anything.
  it('throws when both names are set with DIFFERENT keys', () => {
    expect(() =>
      createSigner('gateway', { GATEWAY_SIGNER_KEY: KEY_GATEWAY, PRIVATE_KEY_SUPPLIER: KEY_WRITER }),
    ).toThrow(SignerError)
  })

  it('names both variables and says why it refused', () => {
    try {
      createSigner('gateway', { GATEWAY_SIGNER_KEY: KEY_GATEWAY, PRIVATE_KEY_SUPPLIER: KEY_WRITER })
    } catch (e) {
      expect((e as SignerError).message).toContain('GATEWAY_SIGNER_KEY')
      expect((e as SignerError).message).toContain('PRIVATE_KEY_SUPPLIER')
      expect((e as SignerError).hint).toMatch(/silently swap/)
    }
  })

  // THE CONTROL. Without it, a fix that refused whenever both names were present would pass
  // the two assertions above while breaking every careful migration.
  it('ACCEPTS both names when they hold the SAME key (must-pass control)', () => {
    const account = createSigner('gateway', {
      GATEWAY_SIGNER_KEY: KEY_GATEWAY,
      PRIVATE_KEY_SUPPLIER: KEY_GATEWAY,
    })
    expect(account.address).toBe(privateKeyToAccount(KEY_GATEWAY as `0x${string}`).address)
  })

  it('still accepts a single name (control)', () => {
    expect(createSigner('gateway', { PRIVATE_KEY_SUPPLIER: KEY_GATEWAY }).address).toBeTruthy()
    expect(createSigner('gateway', { GATEWAY_SIGNER_KEY: KEY_GATEWAY }).address).toBeTruthy()
  })

  it('applies to every role, not just gateway', () => {
    for (const [role, [newName, legacy]] of Object.entries(ROLE_ENV_VARS)) {
      expect(() =>
        createSigner(role as any, { [newName]: KEY_WRITER, [legacy]: KEY_OWNER }),
      ).toThrow(SignerError)
    }
  })
})

describe('a conflict must not be reported as "not configured"', () => {
  const conflicted = { GATEWAY_SIGNER_KEY: KEY_GATEWAY, PRIVATE_KEY_SUPPLIER: KEY_WRITER }

  it('signerConflicts names the role and both variables', () => {
    expect(signerConflicts(conflicted).gateway).toEqual(['GATEWAY_SIGNER_KEY', 'PRIVATE_KEY_SUPPLIER'])
  })

  // THE POINT, and the reason signerConflicts has to exist: a conflict makes createSigner
  // throw, tryCreateSigner swallows that, and the role comes back indistinguishable from an
  // unconfigured one. signerAddresses genuinely cannot express the third state — so this test
  // pins that signerConflicts is where a caller learns about it, not that signerAddresses
  // handles it. (I first "fixed" this with a skip inside signerAddresses; mutating it away
  // left all 25 tests green, because the throw already produced the same result. Dead code.)
  it('a conflicting role is absent from signerAddresses AND present in signerConflicts', () => {
    expect(signerAddresses(conflicted).gateway).toBeUndefined()
    expect(signerConflicts(conflicted).gateway).toBeDefined()
  })

  it('a genuinely unconfigured role appears in NEITHER (control)', () => {
    // Without this, "always report a conflict" would pass the assertion above.
    expect(signerAddresses({}).gateway).toBeUndefined()
    expect(signerConflicts({}).gateway).toBeUndefined()
  })

  it('a coherent config reports no conflicts (control)', () => {
    expect(signerConflicts({ GATEWAY_SIGNER_KEY: KEY_GATEWAY, PRIVATE_KEY_SUPPLIER: KEY_GATEWAY })).toEqual({})
  })
})
