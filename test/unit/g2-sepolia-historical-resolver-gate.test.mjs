import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../../scripts/check-ensv2-resolution.mjs', import.meta.url))

describe('Sepolia ENSv2 historical deployment is not silently treated as current', () => {
  it('fails before any RPC request when historical deployment is not acknowledged', () => {
    const result = spawnSync(process.execPath, [script, '--json'], {
      env: { PATH: process.env.PATH ?? '', HOME: '/nonexistent', SEPOLIA_RPC: 'https://127.0.0.1:1' },
      encoding: 'utf8', timeout: 5000,
    })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('obsolete 2026-07-30 Sepolia deployment')
    expect(result.stderr).not.toContain('HTTP request failed')
  })

  it('explicit historical opt-in passes the deployment gate and reaches RPC prerequisite', () => {
    const result = spawnSync(process.execPath, [script, '--historical-20260730', '--json'], {
      env: { PATH: process.env.PATH ?? '', HOME: '/nonexistent', SEPOLIA_RPC: '' },
      encoding: 'utf8', timeout: 5000,
    })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('no L1 Sepolia RPC')
    expect(result.stderr).not.toContain('obsolete 2026-07-30')
  })
})
