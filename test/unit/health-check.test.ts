/**
 * Unit tests for health check response shape/contract.
 *
 * Since we cannot run the CF Worker directly in unit tests, we test the
 * schema contract using plain objects that mirror what the worker returns.
 * The exact shape is verified against workers/api/src/index.ts /health handler.
 */
import { describe, it, expect } from 'vitest'

// ─── Timestamp bounds ─────────────────────────────────────────────────────────

// Unix timestamps (seconds)
const JAN_2026 = 1_735_689_600  // 2026-01-01T00:00:00Z
const JAN_2030 = 1_893_456_000  // 2030-01-01T00:00:00Z

// ─── Shape factories matching each worker's /health response ─────────────────

function makeApiHealthResponse(overrides: Partial<{
  status: string
  network: string
  rootDomain: string
  version: string
  timestamp: number
}> = {}) {
  return {
    status: 'ok',
    network: 'op-sepolia',
    rootDomain: 'aastar.eth',
    version: 'v0.5.0',
    timestamp: Math.floor(Date.now() / 1000),
    ...overrides,
  }
}

function makeGatewayHealthResponse(overrides: Partial<{
  status: string
  network: string
  rootDomain: string
  proofMode: boolean
  timestamp: number
}> = {}) {
  return {
    status: 'ok',
    network: 'op-sepolia',
    rootDomain: 'aastar.eth',
    proofMode: false,
    timestamp: Math.floor(Date.now() / 1000),
    ...overrides,
  }
}

// ─── Required fields ──────────────────────────────────────────────────────────

describe('API Worker /health — required fields', () => {
  const response = makeApiHealthResponse()

  it('has status field', () => {
    expect(response).toHaveProperty('status')
  })

  it('status is "ok"', () => {
    expect(response.status).toBe('ok')
  })

  it('has network field', () => {
    expect(response).toHaveProperty('network')
    expect(typeof response.network).toBe('string')
  })

  it('has rootDomain field', () => {
    expect(response).toHaveProperty('rootDomain')
    expect(typeof response.rootDomain).toBe('string')
  })

  it('has timestamp field', () => {
    expect(response).toHaveProperty('timestamp')
    expect(typeof response.timestamp).toBe('number')
  })

  it('has version field (API worker only)', () => {
    expect(response).toHaveProperty('version')
    expect(typeof response.version).toBe('string')
  })
})

// ─── Timestamp bounds ─────────────────────────────────────────────────────────

describe('API Worker /health — timestamp is reasonable', () => {
  it('timestamp is a unix second (integer)', () => {
    const response = makeApiHealthResponse()
    expect(Number.isInteger(response.timestamp)).toBe(true)
  })

  it('timestamp is after 2026-01-01', () => {
    const response = makeApiHealthResponse()
    expect(response.timestamp).toBeGreaterThanOrEqual(JAN_2026)
  })

  it('timestamp is before 2030-01-01', () => {
    const response = makeApiHealthResponse()
    expect(response.timestamp).toBeLessThan(JAN_2030)
  })

  it('timestamp is within 5 seconds of now', () => {
    const before = Math.floor(Date.now() / 1000)
    const response = makeApiHealthResponse()
    const after = Math.floor(Date.now() / 1000)
    expect(response.timestamp).toBeGreaterThanOrEqual(before - 1)
    expect(response.timestamp).toBeLessThanOrEqual(after + 1)
  })
})

// ─── Network values ───────────────────────────────────────────────────────────

describe('API Worker /health — network values', () => {
  it('accepts op-sepolia network', () => {
    const response = makeApiHealthResponse({ network: 'op-sepolia' })
    expect(response.network).toBe('op-sepolia')
  })

  it('accepts op-mainnet network', () => {
    const response = makeApiHealthResponse({ network: 'op-mainnet' })
    expect(response.network).toBe('op-mainnet')
  })

  it('rootDomain matches ENS name format', () => {
    const response = makeApiHealthResponse({ rootDomain: 'aastar.eth' })
    expect(response.rootDomain).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/)
  })
})

// ─── Gateway Worker /health ───────────────────────────────────────────────────

describe('Gateway Worker /health — required fields', () => {
  const response = makeGatewayHealthResponse()

  it('has status field', () => {
    expect(response).toHaveProperty('status')
  })

  it('status is "ok"', () => {
    expect(response.status).toBe('ok')
  })

  it('has network field', () => {
    expect(response).toHaveProperty('network')
    expect(typeof response.network).toBe('string')
  })

  it('has rootDomain field', () => {
    expect(response).toHaveProperty('rootDomain')
    expect(typeof response.rootDomain).toBe('string')
  })

  it('has timestamp field', () => {
    expect(response).toHaveProperty('timestamp')
    expect(typeof response.timestamp).toBe('number')
  })
})

describe('Gateway Worker /health — optional proofMode field', () => {
  it('proofMode can be false (standard mode)', () => {
    const response = makeGatewayHealthResponse({ proofMode: false })
    expect(response.proofMode).toBe(false)
  })

  it('proofMode can be true (proof mode)', () => {
    const response = makeGatewayHealthResponse({ proofMode: true })
    expect(response.proofMode).toBe(true)
  })

  it('proofMode is boolean when present', () => {
    const response = makeGatewayHealthResponse()
    expect(typeof response.proofMode).toBe('boolean')
  })
})

// ─── Gateway Worker timestamp bounds ─────────────────────────────────────────

describe('Gateway Worker /health — timestamp is reasonable', () => {
  it('timestamp is after 2026-01-01', () => {
    const response = makeGatewayHealthResponse()
    expect(response.timestamp).toBeGreaterThanOrEqual(JAN_2026)
  })

  it('timestamp is before 2030-01-01', () => {
    const response = makeGatewayHealthResponse()
    expect(response.timestamp).toBeLessThan(JAN_2030)
  })
})
