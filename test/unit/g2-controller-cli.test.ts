import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { keccak256, namehash, type Address, type Hex, type PublicClient } from 'viem'
import { V4ControllerAdapter, type V4ControllerProfile } from '../../sdk/v4'
import { parseV4Args, runV4Cli } from '../../scripts/v4-controller-cli.mjs'

const controller = '0x1111111111111111111111111111111111111111' as const
const pending = '0x2222222222222222222222222222222222222222' as const
const operator = '0x3333333333333333333333333333333333333333' as const
const contract = '0x4444444444444444444444444444444444444444' as const
const code = '0x6001600055' as const
const hash = ('0x' + 'ab'.repeat(32)) as Hex
const profile: V4ControllerProfile = {
  parentName: 'community.eth', contract, chainId: 11155420, expectedCodeHash: keccak256(code),
}

function mockReader(overrides: { chain?: number; bytecode?: Hex; to?: Address; rpcFailure?: boolean } = {}) {
  const methods: string[] = []
  let chainReads = 0
  const reader = {
    async getChainId() { methods.push('eth_chainId'); chainReads++; return overrides.chain ?? 11155420 },
    async getBytecode() { methods.push('eth_getCode'); return overrides.bytecode ?? code },
    async readContract({ functionName }: { functionName: string }) {
      methods.push(functionName)
      if (overrides.rpcFailure) throw new Error('provider token https://rpc.test/v2/SECRET')
      switch (functionName) {
        case 'parentNode': return namehash(profile.parentName)
        case 'rootController': return controller
        case 'pendingController': return pending
        case 'l1OwnershipVerified': return false
        case 'controllerEpoch': return 4n
        case 'operators': return [3n, 12n, BigInt(Math.floor(Date.now() / 1000) + 600), 4n]
        case 'operatorActive': return true
      }
      throw new Error('unexpected method')
    },
    async getTransactionReceipt() {
      methods.push('eth_getTransactionReceipt')
      if (overrides.rpcFailure) throw new Error('provider token https://rpc.test/v2/SECRET')
      return { transactionHash: hash, blockNumber: 123n, status: 'success',
        from: controller, to: overrides.to ?? contract }
    },
  }
  return { reader: reader as unknown as PublicClient, methods, get chainReads() { return chainReads } }
}

describe('G2.5 V4 controller status, receipt and CLI safety', () => {
  it('reports actual controller, pending handoff and onchain epoch', async () => {
    const { reader, methods } = mockReader()
    const sdk = new V4ControllerAdapter(profile, reader)
    expect(await sdk.getControllerStatus()).toEqual({
      controller, pendingController: pending, controllerEpoch: 4n, parentName: 'community.eth',
      contract, chainId: 11155420, l1OwnershipVerified: false, scope: 'op-application-only',
    })
    expect(await sdk.getOperator(operator)).toMatchObject({
      controller, operator, remainingQuota: 12n, epoch: 4n, canIssue: true,
      canInitialAddr: true, l1OwnershipVerified: false, scope: 'op-application-only',
    })
    expect(methods).toContain('controllerEpoch')
    expect(methods).toContain('operatorActive')
    expect(methods.some(m => m.includes('send') || m.includes('sign'))).toBe(false)
  })

  it('verifies explicit chain and codehash before status/receipt', async () => {
    await expect(new V4ControllerAdapter(profile, mockReader({ chain: 10 }).reader)
      .getControllerStatus()).rejects.toMatchObject({ kind: 'chain-mismatch' })
    await expect(new V4ControllerAdapter(profile, mockReader({ bytecode: '0x00' }).reader)
      .getReceipt(hash)).rejects.toMatchObject({ kind: 'contract-missing' })
  })

  it('reads only a mined receipt to the pinned contract, without asserting authority', async () => {
    const { reader, methods, chainReads } = mockReader()
    expect(chainReads).toBe(0)
    const receipt = await new V4ControllerAdapter(profile, reader).getReceipt(hash)
    expect(receipt).toEqual({ transactionHash: hash, blockNumber: 123n,
      status: 'success', from: controller, to: contract, chainId: 11155420,
      scope: 'op-application-only' })
    expect(methods).toEqual(expect.arrayContaining(['eth_chainId', 'eth_getCode', 'eth_getTransactionReceipt']))
    expect(methods.filter(m => m === 'eth_chainId')).toHaveLength(2)
    await expect(new V4ControllerAdapter(profile, mockReader({ to: pending }).reader)
      .getReceipt(hash)).rejects.toMatchObject({ kind: 'invalid-input' })
    await expect(new V4ControllerAdapter(profile, mockReader().reader)
      .getReceipt('0xbad')).rejects.toMatchObject({ kind: 'invalid-input' })
  })

  it('redacts provider errors for status and receipt', async () => {
    for (const action of [
      (adapter: V4ControllerAdapter) => adapter.getControllerStatus(),
      (adapter: V4ControllerAdapter) => adapter.getReceipt(hash),
    ]) {
      await expect(action(new V4ControllerAdapter(profile, mockReader({ rpcFailure: true }).reader)))
        .rejects.toMatchObject({ kind: 'rpc-unavailable' })
      try { await action(new V4ControllerAdapter(profile, mockReader({ rpcFailure: true }).reader)) }
      catch (error) { expect(String(error)).not.toContain('SECRET') }
    }
  })

  it('CLI flags are allowlisted, no signer, RPC key or broadcast parameters accepted', () => {
    expect(parseV4Args(['status', '--profile', 'profile.json', '--operator', operator]))
      .toEqual({ command: 'status', flags: { profile: 'profile.json', operator } })
    expect(parseV4Args(['prepare-revoke', '--profile', 'p.json', '--from', controller, '--operator', operator]).command)
      .toBe('prepare-revoke')
    expect(parseV4Args(['--', 'receipt', '--profile', 'p.json', '--hash', hash]).command).toBe('receipt')
    for (const args of [
      ['prepare-revoke', '--profile', 'p.json', '--from', controller, '--operator', operator, '--private-key', 'secret'],
      ['status', '--profile', 'p.json', '--rpc', 'https://example.com/v2/secret'],
      ['status', '--profile', 'p.json', '--broadcast', 'true'],
      ['status', '--profile', 'p.json', '--profile', 'duplicate'],
      ['prepare-grant', '--profile', 'p.json', '--from', controller],
    ]) expect(() => parseV4Args(args)).toThrow()
  })

  it('CLI emits only verified OP status, unsigned calldata and receipt JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cometens-g2-cli-'))
    const path = join(dir, 'profile.json')
    await writeFile(path, JSON.stringify(profile))
    const { reader, methods } = mockReader()
    const options = { rpcUrl: 'https://rpc.test', client: reader, adapterClass: V4ControllerAdapter }
    try {
      const status = JSON.parse(await runV4Cli(['--', 'status', '--profile', path, '--operator', operator], options))
      expect(status.result.controller).toMatchObject({ controller, pendingController: pending, controllerEpoch: '4', l1OwnershipVerified: false })
      expect(status.result.operator).toMatchObject({ operator, remainingQuota: '12', canIssue: true })
      expect(status.broadcast).toBe(false)
      const prepared = JSON.parse(await runV4Cli(['prepare-revoke', '--profile', path,
        '--from', controller, '--operator', operator], options))
      expect(prepared).toMatchObject({ kind: 'prepare-revoke', signed: false, broadcast: false,
        result: { from: controller, to: contract, chainId: 11155420, value: '0', ownershipScope: 'op-application-only' } })
      expect(prepared.result.data).toMatch(/^0x[0-9a-f]+$/)
      const receipt = JSON.parse(await runV4Cli(['receipt', '--profile', path, '--hash', hash], options))
      expect(receipt.result.receipt).toMatchObject({ transactionHash: hash, status: 'success', blockNumber: '123', to: contract })
      expect(receipt.broadcast).toBe(false)
      expect(methods.some(m => /send|sign|write/i.test(m))).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
