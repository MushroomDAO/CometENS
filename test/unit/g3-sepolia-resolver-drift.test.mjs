import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { getAddress, toFunctionSelector } from 'viem'
import {
  PROBES, PUBLIC_CHAINS, SELECTOR, categoryFor, classifyBytecode, main, parseArgs,
} from '../../scripts/check-sepolia-resolver-drift.mjs'

const script = fileURLToPath(new URL('../../scripts/check-sepolia-resolver-drift.mjs', import.meta.url))
const address = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

function push(names) {
  return `0x${names.map((name) => `63${SELECTOR[name]}`).join('')}`
}

async function withFixture(entries, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'resolver-drift-'))
  const file = join(dir, 'fixture.json')
  await writeFile(file, JSON.stringify({ entries }))
  try {
    return await fn(file)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('Sepolia resolver bytecode drift classifier', () => {
  it('pins the three probe selectors independently of the script constants', () => {
    for (const [name, signature] of Object.entries(PROBES)) {
      expect(SELECTOR[name]).toBe(toFunctionSelector(`function ${signature}`).slice(2))
    }
    expect(SELECTOR).toEqual({
      gatewayUrl: '8bf165d9',
      verifier: '2b7ac3f3',
      resolveWithProof: 'f4d4d2f8',
    })
  })

  it('classifies the three known shapes and nothing else', () => {
    expect(classifyBytecode(push(['gatewayUrl', 'verifier']))).toMatchObject({
      category: 'HybridResolver', healthy: true, reason: 'recognized-selector-shape',
      selectors: { gatewayUrl: true, verifier: true, resolveWithProof: false },
    })
    expect(classifyBytecode(push(['verifier']))).toMatchObject({
      category: 'OPResolver', healthy: true,
      selectors: { gatewayUrl: false, verifier: true, resolveWithProof: false },
    })
    expect(classifyBytecode(push(['gatewayUrl', 'resolveWithProof']))).toMatchObject({
      category: 'OffchainResolver', healthy: true,
      selectors: { gatewayUrl: true, verifier: false, resolveWithProof: true },
    })
  })

  it('classifies empty and unrecognized bytecode as unknown and not healthy', () => {
    for (const bytecode of ['0x', '0X', '', push([]), '0xdeadbeef', '600160005260206000f3']) {
      const report = classifyBytecode(bytecode === push([]) ? '0x' : bytecode)
      expect(report.category).toBe('unknown')
      expect(report.healthy).toBe(false)
      expect(report.category).not.toBe('HybridResolver')
    }
    expect(classifyBytecode('0x')).toMatchObject({ reason: 'empty-bytecode', healthy: false })
    expect(classifyBytecode('0xdeadbeef')).toMatchObject({
      reason: 'unrecognized-selector-shape', healthy: false, category: 'unknown',
    })
    expect(classifyBytecode('0xzz')).toMatchObject({
      category: 'unknown', healthy: false, reason: 'invalid-bytecode',
    })
    expect(classifyBytecode(null).category).toBe('unknown')
  })

  it('does not call a superset or a partial shape HybridResolver', () => {
    const notHybrid = [
      { gatewayUrl: false, verifier: false, resolveWithProof: false },
      { gatewayUrl: true, verifier: false, resolveWithProof: false },
      { gatewayUrl: false, verifier: true, resolveWithProof: true },
      { gatewayUrl: true, verifier: true, resolveWithProof: true },
      { gatewayUrl: true, verifier: false, resolveWithProof: true },
      {},
      null,
    ]
    for (const selectors of notHybrid) {
      const category = categoryFor(selectors)
      if (!(selectors?.gatewayUrl === true && selectors?.verifier === true && selectors?.resolveWithProof !== true) &&
          !(selectors?.verifier === true && selectors?.gatewayUrl !== true && selectors?.resolveWithProof !== true) &&
          !(selectors?.gatewayUrl === true && selectors?.resolveWithProof === true && selectors?.verifier !== true)) {
        expect(category).toBe('unknown')
      }
      if (selectors?.resolveWithProof === true || selectors?.gatewayUrl !== true || selectors?.verifier !== true) {
        expect(category).not.toBe('HybridResolver')
      }
    }
    expect(classifyBytecode(push(['gatewayUrl', 'verifier', 'resolveWithProof']))).toMatchObject({
      category: 'unknown', healthy: false,
    })
    expect(categoryFor({ gatewayUrl: false, verifier: false, resolveWithProof: false })).not.toBe('HybridResolver')
  })

  it('fixture mode reports known shapes without calling a live reader or claiming acceptance', async () => {
    const liveReader = () => { throw new Error('live reader must not run') }
    const lines = []
    const code = await withFixture([
      { address, bytecode: push(['gatewayUrl', 'verifier']) },
      { bytecode: push(['verifier']) },
      { address: getAddress(address), bytecode: push(['gatewayUrl', 'resolveWithProof']) },
    ], (file) => main(['--fixture', file], { liveReader, writeOut: (text) => lines.push(text), writeErr: () => {} }))
    expect(code).toBe(0)
    const report = JSON.parse(lines.join(''))
    expect(report).toMatchObject({
      mode: 'fixture', inventoryOnly: true, g3Unblocked: false, acceptance: false,
      deploymentHealthy: false, liveReconciliation: 'unrun', chainId: null, blockNumber: null,
    })
    expect(report.entries.map((entry) => entry.category)).toEqual([
      'HybridResolver', 'OPResolver', 'OffchainResolver',
    ])
    expect(report.entries.every((entry) => entry.healthy)).toBe(true)
    expect(report.entries[0].address).toBe(getAddress(address))
    expect(report.entries[1].address).toBeNull()
  })

  it('an unknown fixture entry is not healthy and fails the process', async () => {
    const lines = []
    const code = await withFixture([
      { address, bytecode: '0x' },
      { address, bytecode: '0xdeadbeef' },
    ], (file) => main(['--fixture', file], { writeOut: (text) => lines.push(text), writeErr: () => {} }))
    expect(code).toBe(1)
    const report = JSON.parse(lines.join(''))
    expect(report.g3Unblocked).toBe(false)
    expect(report.deploymentHealthy).toBe(false)
    expect(report.liveReconciliation).toBe('unrun')
    for (const entry of report.entries) {
      expect(entry.category).toBe('unknown')
      expect(entry.healthy).toBe(false)
    }
    expect(JSON.stringify(report)).not.toContain('HybridResolver')
  })

  it('refuses a missing fixture, a live flag without being asked, and secret-bearing failures', async () => {
    const errs = []
    expect(await main(['--live', '--address', address], {
      liveReader: async () => { throw new Error('https://evil.example/v2/secret-token?api-key=abc') },
      writeOut: () => {},
      writeErr: (text) => errs.push(text),
    })).toBe(2)
    expect(errs).toEqual(['live read failed'])
    expect(errs.join('')).not.toContain('secret-token')

    errs.length = 0
    expect(await main([], { writeErr: (text) => errs.push(text), writeOut: () => {} })).toBe(2)
    expect(parseArgs(['--fixture', 'x.json', '--live', '--address', address]).error).toBe('choose-fixture-or-live')
    expect(parseArgs(['--chain', 'op-sepolia']).error).toBe('missing-mode')
    expect(parseArgs(['--fixture', 'x.json', '--chain', 'op-sepolia']).error).toBe('chain-requires-live')
    expect(PUBLIC_CHAINS['ethereum-sepolia'].rpc).toBe('https://ethereum-sepolia-rpc.publicnode.com')
    expect(PUBLIC_CHAINS['op-sepolia'].rpc).toBe('https://sepolia.optimism.io')
  })

  it('live mode records only the injected chain id, block, and category', async () => {
    const lines = []
    const code = await main(['--live', '--chain', 'op-sepolia', '--address', address], {
      liveReader: async (chain, addresses) => {
        expect(chain).toBe('op-sepolia')
        expect(addresses).toEqual([getAddress(address)])
        return { chainId: 11155420, blockNumber: '42', entries: [{ address: getAddress(address), bytecode: '0x' }] }
      },
      writeOut: (text) => lines.push(text),
      writeErr: () => {},
    })
    expect(code).toBe(1)
    expect(JSON.parse(lines.join(''))).toMatchObject({
      mode: 'live', chainId: 11155420, blockNumber: '42', g3Unblocked: false,
      acceptance: false, deploymentHealthy: false, liveReconciliation: 'read',
      entries: [{ address: getAddress(address), category: 'unknown', healthy: false, reason: 'empty-bytecode' }],
    })
  })

  it('the CLI fixture path does not read the environment and fails unknown bytecode', async () => {
    const source = await readFile(script, 'utf8')
    expect(source).not.toMatch(/process\.env/)
    expect(source).not.toMatch(/\.env/)
    const code = await withFixture([{ bytecode: '0x' }], (file) => {
      const result = spawnSync(process.execPath, [script, '--fixture', file], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '', HOME: '/nonexistent', SEPOLIA_RPC_URL: 'https://keyed.example/secret-token' },
      })
      expect(result.stdout).not.toContain('secret-token')
      expect(result.stderr).not.toContain('secret-token')
      const report = JSON.parse(result.stdout)
      expect(report.entries[0]).toMatchObject({ category: 'unknown', healthy: false })
      expect(report.g3Unblocked).toBe(false)
      return result.status
    })
    expect(code).toBe(1)
  })
})
