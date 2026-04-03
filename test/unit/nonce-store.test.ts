/**
 * Unit tests for NonceStore Durable Object.
 *
 * Since DO runtime types (DurableObjectState, blockConcurrencyWhile) are not
 * available in Node.js vitest, we simulate the storage interface directly and
 * instantiate NonceStore by injecting a minimal stub that matches the DO API.
 */
import { describe, it, expect } from 'vitest'

// ─── Minimal DO storage stub ──────────────────────────────────────────────────

function makeStorage(): {
  store: Map<string, unknown>
  get: <T>(key: string) => Promise<T | undefined>
  put: (key: string, value: unknown, opts?: { expirationTtl?: number }) => Promise<void>
} {
  const store = new Map<string, unknown>()
  return {
    store,
    get: async <T>(key: string) => store.get(key) as T | undefined,
    put: async (key: string, value: unknown) => { store.set(key, value) },
  }
}

function makeDurableObjectState() {
  const storage = makeStorage()
  return {
    storage,
    blockConcurrencyWhile: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
  }
}

// ─── Import NonceStore under test ─────────────────────────────────────────────

// NonceStore uses Web globals (Request, Response, URL) which ARE available in
// the vitest "node" environment (Node 18+ ships these as globals).

import { NonceStore } from '../../workers/api/src/NonceStore'

// ─── Helper: build a NonceStore instance with a fresh storage stub ─────────────

function makeStore(): NonceStore {
  const state = makeDurableObjectState() as unknown as DurableObjectState
  return new NonceStore(state)
}

// ─── Helper: call NonceStore.fetch with a JSON POST to /consume ───────────────

async function postConsume(
  store: NonceStore,
  body: unknown,
): Promise<{ status: number; json: unknown }> {
  const req = new Request('https://do/consume', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const res = await store.fetch(req)
  const json = await res.json()
  return { status: res.status, json }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('NonceStore — /consume', () => {
  it('first consume returns { ok: true }', async () => {
    const store = makeStore()
    const result = await postConsume(store, { key: 'nonce:0xabc:1', ttl: 3600 })
    expect(result.status).toBe(200)
    expect((result.json as any).ok).toBe(true)
  })

  it('duplicate key consume returns { ok: false } (replay blocked)', async () => {
    const store = makeStore()
    await postConsume(store, { key: 'nonce:0xabc:2', ttl: 3600 })
    const second = await postConsume(store, { key: 'nonce:0xabc:2', ttl: 3600 })
    expect(second.status).toBe(200)
    expect((second.json as any).ok).toBe(false)
  })

  it('different keys are independent (each returns ok: true)', async () => {
    const store = makeStore()
    const a = await postConsume(store, { key: 'nonce:0xabc:10', ttl: 3600 })
    const b = await postConsume(store, { key: 'nonce:0xabc:11', ttl: 3600 })
    expect((a.json as any).ok).toBe(true)
    expect((b.json as any).ok).toBe(true)
  })

  it('invalid JSON body returns 400', async () => {
    const store = makeStore()
    const req = new Request('https://do/consume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json{',
    })
    const res = await store.fetch(req)
    expect(res.status).toBe(400)
    const json = await res.json() as any
    expect(json.error).toMatch(/Invalid JSON/i)
  })

  it('missing key field returns 400', async () => {
    const store = makeStore()
    const result = await postConsume(store, { ttl: 3600 })
    expect(result.status).toBe(400)
    expect((result.json as any).error).toBeTruthy()
  })

  it('key as null returns 400', async () => {
    const store = makeStore()
    const result = await postConsume(store, { key: null, ttl: 3600 })
    expect(result.status).toBe(400)
  })

  it('ttl below minimum (< 60) returns 400', async () => {
    const store = makeStore()
    const result = await postConsume(store, { key: 'nonce:0xabc:20', ttl: 59 })
    expect(result.status).toBe(400)
    expect((result.json as any).error).toMatch(/ttl/i)
  })

  it('ttl above maximum (> 86400) returns 400', async () => {
    const store = makeStore()
    const result = await postConsume(store, { key: 'nonce:0xabc:21', ttl: 86401 })
    expect(result.status).toBe(400)
    expect((result.json as any).error).toMatch(/ttl/i)
  })

  it('ttl exactly at minimum boundary (60) is accepted', async () => {
    const store = makeStore()
    const result = await postConsume(store, { key: 'nonce:0xabc:22', ttl: 60 })
    expect(result.status).toBe(200)
    expect((result.json as any).ok).toBe(true)
  })

  it('ttl exactly at maximum boundary (86400) is accepted', async () => {
    const store = makeStore()
    const result = await postConsume(store, { key: 'nonce:0xabc:23', ttl: 86400 })
    expect(result.status).toBe(200)
    expect((result.json as any).ok).toBe(true)
  })

  it('ttl as non-number (string) returns 400', async () => {
    const store = makeStore()
    const result = await postConsume(store, { key: 'nonce:0xabc:24', ttl: '3600' })
    expect(result.status).toBe(400)
  })
})

describe('NonceStore — unknown paths and methods', () => {
  it('unknown path returns 404', async () => {
    const store = makeStore()
    const req = new Request('https://do/unknown-path', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'k', ttl: 3600 }),
    })
    const res = await store.fetch(req)
    expect(res.status).toBe(404)
  })

  it('GET to /consume returns 404 (only POST is handled)', async () => {
    const store = makeStore()
    const req = new Request('https://do/consume', { method: 'GET' })
    const res = await store.fetch(req)
    expect(res.status).toBe(404)
  })

  it('PUT to /consume returns 404', async () => {
    const store = makeStore()
    const req = new Request('https://do/consume', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'k', ttl: 3600 }),
    })
    const res = await store.fetch(req)
    expect(res.status).toBe(404)
  })
})
