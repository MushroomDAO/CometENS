/**
 * Unit tests for the upstream API signature verification scheme.
 *
 * Verifies that the canonical message format, anti-replay timestamp check,
 * and signer whitelist logic work correctly — without starting a real server.
 */
import { describe, it, expect } from 'vitest'
import {
  recoverMessageAddress,
  type Hex,
  type Address,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

// ─── Helpers (mirrors vite.config.ts /api/v1 logic) ──────────────────────────

function canonicalMessage(label: string, owner: string, timestamp: number): string {
  return `CometENS:register:${label}:${owner}:${timestamp}`
}

async function verifyUpstreamRequest(
  label: string,
  owner: string,
  timestamp: number,
  signature: Hex,
  allowedSigners: string[],
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<{ ok: boolean; signer?: Address; error?: string }> {
  const drift = Math.abs(nowSeconds - timestamp)
  if (drift > 60) return { ok: false, error: `Timestamp drift too large (${drift}s)` }

  const message = canonicalMessage(label, owner, timestamp)
  const signer = await recoverMessageAddress({ message, signature })

  if (!allowedSigners.map((a) => a.toLowerCase()).includes(signer.toLowerCase())) {
    return { ok: false, error: `Signer ${signer} not in allowed list` }
  }
  return { ok: true, signer }
}

// ─── Test wallet ──────────────────────────────────────────────────────────────

const APP_PK = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as Hex
const appAccount = privateKeyToAccount(APP_PK)

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('upstream API signature auth', () => {
  it('accepts a valid signature from an allowed signer', async () => {
    const label = 'alice'
    const owner = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
    const timestamp = Math.floor(Date.now() / 1000)

    const message = canonicalMessage(label, owner, timestamp)
    const signature = await appAccount.signMessage({ message })

    const result = await verifyUpstreamRequest(
      label, owner, timestamp, signature,
      [appAccount.address],
    )
    expect(result.ok).toBe(true)
    expect(result.signer?.toLowerCase()).toBe(appAccount.address.toLowerCase())
  })

  it('rejects a signature from an address not in the allowed list', async () => {
    const label = 'bob'
    const owner = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
    const timestamp = Math.floor(Date.now() / 1000)

    const message = canonicalMessage(label, owner, timestamp)
    const signature = await appAccount.signMessage({ message })

    const result = await verifyUpstreamRequest(
      label, owner, timestamp, signature,
      ['0x0000000000000000000000000000000000000001'], // different address
    )
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/not in allowed list/)
  })

  it('rejects a timestamp older than 60 seconds (anti-replay)', async () => {
    const label = 'carol'
    const owner = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
    const staleTimestamp = Math.floor(Date.now() / 1000) - 90 // 90s ago

    const message = canonicalMessage(label, owner, staleTimestamp)
    const signature = await appAccount.signMessage({ message })

    const result = await verifyUpstreamRequest(
      label, owner, staleTimestamp, signature,
      [appAccount.address],
    )
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/Timestamp drift/)
  })

  it('rejects a signature over tampered label (wrong message)', async () => {
    const owner = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
    const timestamp = Math.floor(Date.now() / 1000)

    // Sign for "dave" but claim to register "evil"
    const message = canonicalMessage('dave', owner, timestamp)
    const signature = await appAccount.signMessage({ message })

    const result = await verifyUpstreamRequest(
      'evil', owner, timestamp, signature,
      [appAccount.address],
    )
    // Recovered address won't match because message was tampered
    expect(result.ok).toBe(false)
  })

  it('recovers the same signer regardless of address casing in whitelist', async () => {
    const label = 'frank'
    const owner = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
    const timestamp = Math.floor(Date.now() / 1000)

    const message = canonicalMessage(label, owner, timestamp)
    const signature = await appAccount.signMessage({ message })

    // Whitelist contains uppercase address
    const result = await verifyUpstreamRequest(
      label, owner, timestamp, signature,
      [appAccount.address.toUpperCase()],
    )
    expect(result.ok).toBe(true)
  })
})
