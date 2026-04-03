/**
 * NonceStore — Durable Object for atomic nonce consumption.
 *
 * Fixes the KV TOCTOU race condition: two concurrent requests with the same
 * nonce could both pass a KV get() check before either put() landed.
 * Durable Object storage is strongly consistent, so check+insert is atomic.
 *
 * Protocol:
 *   POST /consume  { "key": "nonce:0x...:123", "ttl": 3600 }
 *   → 200 { "ok": true }   — nonce accepted and stored
 *   → 200 { "ok": false }  — nonce already used (replay)
 */

export class NonceStore {
  private state: DurableObjectState

  constructor(state: DurableObjectState) {
    this.state = state
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === 'POST' && url.pathname === '/consume') {
      let body: { key: string; ttl: number }
      try {
        body = await request.json() as { key: string; ttl: number }
      } catch {
        return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      const { key, ttl } = body
      if (!key || typeof key !== 'string' || key.length > 512) {
        return new Response(JSON.stringify({ error: 'Missing or invalid key' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl < 60 || ttl > 86_400) {
        return new Response(JSON.stringify({ error: 'ttl must be a finite number between 60 and 86400' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      // Use blockConcurrencyWhile to make check-and-insert atomic.
      // CF DO input gate already serializes requests, but this makes the intent
      // explicit and prevents any future concurrency model changes from introducing
      // a TOCTOU window.
      const ok = await this.state.blockConcurrencyWhile(async () => {
        const existing = await this.state.storage.get<number>(key)
        if (existing !== undefined) return false
        await this.state.storage.put(key, 1, { expirationTtl: ttl })
        return true
      })

      return new Response(JSON.stringify({ ok }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    return new Response('Not found', { status: 404 })
  }
}
