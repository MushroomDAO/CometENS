import { defineConfig } from 'vite'

/**
 * Phase 3: vite.config.ts is now a pure frontend build config.
 *
 * All API logic has been migrated to Cloudflare Workers:
 *   cometens-api     (workers/api/)     — write operations + lookup
 *   cometens-gateway (workers/gateway/) — CCIP-Read resolution
 *
 * Local development: set VITE_API_URL and VITE_GATEWAY_URL in .env.local
 * to point at the deployed testnet workers (or a local miniflare instance).
 * Default values in src/config.ts point to the deployed testnet workers.
 */
export default defineConfig({
  envPrefix: ['VITE_'],
  server: {
    port: 4173,
    strictPort: true,
  },
})
