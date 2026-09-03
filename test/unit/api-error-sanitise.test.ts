import { describe, it, expect } from 'vitest'
import { sanitiseErrorMessage } from '../../workers/api/src/index'

/**
 * The deployed API worker returned provider credentials to anonymous callers.
 *
 * `GET /check-label?label=…&parent=…` against the live testnet worker came back with:
 *
 *   {"error":"JSON is not a valid request object.\n\nURL: https://opt-sepolia.g.alchemy.com/v2/<KEY>
 *    \nRequest body: {\"method\":\"eth_call\",…"}
 *
 * The worker handed viem's `error.message` straight to the caller, and viem embeds the full
 * RPC URL — key and all — in that string. `/check-owner` leaked the same way.
 *
 * These tests pin the sanitiser. The real fixture below is the shape actually observed, not
 * an invented one: a sanitiser tested only against strings someone imagined is the same
 * vacuous check that let this ship.
 */

const SENTINEL = 'dmg4SENTINELKEYvalue'
const OBSERVED_SHAPE =
  'JSON is not a valid request object.\n\n' +
  `URL: https://opt-sepolia.g.alchemy.com/v2/${SENTINEL}\n` +
  'Request body: {"method":"eth_call","params":[{"data":"0xdead","to":"0xbeef"},"latest"]}\n \n' +
  'Raw Call Arguments:\n  to:    0xbeef\n'

describe('sanitiseErrorMessage — credentials never reach a caller', () => {
  it('removes the provider key from the observed production error', () => {
    const out = sanitiseErrorMessage(OBSERVED_SHAPE)
    expect(out).not.toContain(SENTINEL)
    expect(out).toContain('(redacted)')
  })

  it('the sentinel is detectable when NOT sanitised (must-leak control)', () => {
    // Without this, "key absent" and "the assertion is vacuous" are indistinguishable.
    expect(OBSERVED_SHAPE).toContain(SENTINEL)
  })

  it('keeps the host so an operator can still tell which provider failed', () => {
    expect(sanitiseErrorMessage(OBSERVED_SHAPE)).toContain('opt-sepolia.g.alchemy.com')
  })

  it('keeps the actual reason — the message must stay useful', () => {
    expect(sanitiseErrorMessage(OBSERVED_SHAPE)).toContain('JSON is not a valid request object')
  })

  it('drops the echoed request body and raw call arguments', () => {
    const out = sanitiseErrorMessage(OBSERVED_SHAPE)
    expect(out).not.toContain('Request body')
    expect(out).not.toContain('Raw Call Arguments')
  })
})

describe('sanitiseErrorMessage — other credential shapes', () => {
  it('redacts a key in a query string', () => {
    const out = sanitiseErrorMessage('failed calling https://rpc.example.com/?apikey=SECRET123')
    expect(out).not.toContain('SECRET123')
  })

  it('redacts userinfo credentials', () => {
    const out = sanitiseErrorMessage('failed calling https://user:pw@rpc.example.com/v2/KEY')
    expect(out).not.toContain('pw@')
    expect(out).not.toContain('KEY')
  })

  it('redacts a 64-hex string that looks like a private key', () => {
    const key = `0x${'ab'.repeat(32)}`
    expect(sanitiseErrorMessage(`signing failed for ${key}`)).not.toContain(key)
  })

  it('leaves a plain message untouched', () => {
    // Control: over-aggressive scrubbing would make every error useless.
    expect(sanitiseErrorMessage('Label "alice" is already registered')).toBe(
      'Label "alice" is already registered',
    )
  })

  it('handles a bare host with no path', () => {
    expect(sanitiseErrorMessage('cannot reach https://sepolia.optimism.io')).toContain(
      'sepolia.optimism.io',
    )
  })
})

describe('sanitiseErrorMessage — websocket endpoints', () => {
  // Providers issue a wss:// endpoint alongside the HTTP one, carrying the same key.
  // Matching only https? left this shape fully exposed — found in review of this PR.
  it('redacts a key in a wss:// URL', () => {
    const secret = 'WSS_SENTINEL_KEY_123'
    const out = sanitiseErrorMessage(`socket failed: wss://opt-sepolia.g.alchemy.com/v2/${secret}`)
    expect(out).not.toContain(secret)
    expect(out).toContain('opt-sepolia.g.alchemy.com')
  })

  it('the wss sentinel is detectable unsanitised (must-leak control)', () => {
    expect('wss://h/v2/WSS_SENTINEL_KEY_123').toContain('WSS_SENTINEL_KEY_123')
  })

  it('redacts ws:// too', () => {
    expect(sanitiseErrorMessage('ws://host/v2/PLAINWS_KEY')).not.toContain('PLAINWS_KEY')
  })
})

describe('sanitiseErrorMessage — the reason survives', () => {
  // The PR description originally claimed the reason was preserved; it was not. viem puts
  // "Details:" AFTER "Raw Call Arguments:", so stripping to end-of-string took the only
  // sentence explaining the failure with it.
  const VIEM_SHAPE = [
    'JSON is not a valid request object.', '',
    'URL: https://opt-sepolia.g.alchemy.com/v2/KEYVALUE',
    'Request body: {"method":"eth_call"}', '',
    'Raw Call Arguments:', '  to: 0xabc', '',
    'Details: OPT_SEPOLIA is not enabled for this app',
    'Version: viem@2.0',
  ].join('\n')

  it('keeps the Details line that says what went wrong', () => {
    expect(sanitiseErrorMessage(VIEM_SHAPE)).toContain('OPT_SEPOLIA is not enabled')
  })

  it('still drops the internals and the key around it', () => {
    const out = sanitiseErrorMessage(VIEM_SHAPE)
    expect(out).not.toContain('Request body')
    expect(out).not.toContain('Raw Call Arguments')
    expect(out).not.toContain('KEYVALUE')
  })
})
