import { describe, expect, it } from 'vitest'
import { liveTestOptIn } from '../integration/live-opt-in'

const configured = {
  OP_SEPOLIA_RPC_URL: 'https://testnet.example',
  PRIVATE_KEY_JASON: 'test-only-placeholder',
  COMETENS_LIVE_READ_TESTS: undefined,
  COMETENS_LIVE_WRITE_TESTS: undefined,
}

describe('live Sepolia tests require deliberate opt-in', () => {
  it('does not enable writes just because RPC and account secrets are present', () => {
    expect(liveTestOptIn(configured)).toEqual({ reads: false, writes: false })
  })

  it('read opt-in permits only read-only suites', () => {
    expect(liveTestOptIn({ ...configured, COMETENS_LIVE_READ_TESTS: '1' }))
      .toEqual({ reads: true, writes: false })
  })

  it('write opt-in alone never permits signing/broadcasting transactions', () => {
    expect(liveTestOptIn({ ...configured, COMETENS_LIVE_WRITE_TESTS: '1' }))
      .toEqual({ reads: false, writes: false })
  })

  it('requires both exact flags to permit testnet writes', () => {
    expect(liveTestOptIn({ ...configured, COMETENS_LIVE_READ_TESTS: '1', COMETENS_LIVE_WRITE_TESTS: '1' }))
      .toEqual({ reads: true, writes: true })
    expect(liveTestOptIn({ ...configured, COMETENS_LIVE_READ_TESTS: 'true', COMETENS_LIVE_WRITE_TESTS: 'true' }))
      .toEqual({ reads: false, writes: false })
  })
})
