import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createCometENSClient, createSelfHostedProfile } from '../../sdk/index'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const fixture = 'examples/sdk-vanilla/.env.example'

describe('independent SDK demo setup', () => {
  it('commits the public .env.example referenced by the copy-and-run instructions', () => {
    expect(execFileSync('git', ['ls-files', '--error-unmatch', fixture], { cwd: repo, encoding: 'utf8' }).trim()).toBe(fixture)
    const vars = readFileSync(new URL('../../' + fixture, import.meta.url), 'utf8')
    for (const name of [
      'VITE_PARENT_NAME', 'VITE_L1_RPC_URL', 'VITE_L2_RPC_URL',
      'VITE_L1_RESOLVER_ADDRESS', 'VITE_L2_RECORDS_ADDRESS',
    ]) {
      expect(vars).toMatch(new RegExp(`^${name}=`, 'm'))
    }
    expect(readFileSync(new URL('../../examples/sdk-vanilla/README.md', import.meta.url), 'utf8'))
      .toContain('cp .env.example .env.local')
  })

  it('supports user-supplied Ethereum/OP mainnet profiles without claiming AAStar mainnet deployment', () => {
    const profile = createSelfHostedProfile({
      id: 'community-mainnet', protocol: 'v3-readonly', rootName: 'community.eth',
      l1: { chainId: 1, rpcUrl: 'https://example.org', resolverAddress: '0x1111111111111111111111111111111111111111' },
      l2: { chainId: 10, rpcUrl: 'https://example.net', recordsAddress: '0x2222222222222222222222222222222222222222' },
    })
    expect(createCometENSClient(profile).profile.mode).toBe('selfHosted')
    expect(profile.l1.chainId).toBe(1)
    expect(profile.l2.chainId).toBe(10)
  })
})
