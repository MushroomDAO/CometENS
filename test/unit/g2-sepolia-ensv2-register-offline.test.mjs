import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, stat, chmod, symlink, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { decodeFunctionData, encodeAbiParameters, keccak256, parseAbiParameters, toFunctionSelector } from 'viem'
import { WALLET, REGISTRAR, MOCK_USDC, REG_ABI, commitmentFor,
  validateRegistrationManifest, loadOrCreateSalt, prepareSepoliaRegistration,
} from '../../scripts/prepare-g2-sepolia-ensv2-registration.mjs'

const h = n => `0x${n.toString(16).padStart(64, '0')}`
const TOKEN = keccak256('0x6002')
const CONTRACT = keccak256('0x6001')
const fixedSalt = Buffer.from('cd'.repeat(32), 'hex')
const manifest = () => ({ wallet: WALLET, label: 'comet-test', durationSeconds: '31536000',
  maxTotalCost: '100000000', expectedRegistrarCodeHash: CONTRACT, expectedTokenCodeHash: TOKEN })
const zero = '0x0000000000000000000000000000000000000000'
const zero32 = h(0)
const now = () => BigInt(Math.floor(Date.now() / 1000))

async function privateFixture() {
  const root = await mkdtemp(join(tmpdir(), 'cometens-ensv2-register-'))
  await chmod(root, 0o700)
  return { root, path: join(root, 'salt.json'), done: () => rm(root, { recursive: true, force: true }) }
}

function fake(config = {}) {
  const calls = []
  const unix = now()
  const publicClient = {
    async getChainId() { calls.push(['chain']); return config.wrongChain ? 1 : 11155111 },
    async getBlock(args) { calls.push(['block', args]); return { number: 200n,
      hash: config.reorg && args.blockNumber !== undefined ? h(201) : h(200),
      timestamp: config.stale ? unix - 900n : unix } },
    async getBytecode({ address, blockNumber }) { calls.push(['code', address, blockNumber]);
      if (config.badCode === address) return '0x1234'
      return address === REGISTRAR ? '0x6001' : address === MOCK_USDC ? '0x6002' : '0x'
    },
    async readContract({ address, functionName, args, blockNumber }) {
      calls.push(['read', address, functionName, args, blockNumber])
      if (config.throwRpc) throw Error('https://rpc.private.invalid/SUPERSECRET')
      switch (functionName) {
        case 'makeCommitment': return config.mismatchedHash ? h(777) :
          keccak256(encodeAbiParameters(parseAbiParameters('string,address,bytes32,address,address,uint64,bytes32'), args))
        case 'isAvailable': return config.unavailable ? false : true
        case 'MIN_REGISTER_DURATION': return config.longMinimum ? 40000000n : 30000000n
        case 'MIN_COMMITMENT_AGE': return 60n
        case 'MAX_COMMITMENT_AGE': return 86400n
        case 'commitmentAt': return config.commitmentTime ?? 0n
        case 'getRegisterPrice': return config.highCost ? [200000000n, 0n] : [8000000n, 1000000n]
        case 'rentPriceOracle': return '0x4444444444444444444444444444444444444444'
        case 'decimals': return config.wrongDecimals ? 18 : 6
        case 'balanceOf': return config.lowBalance ? 1000000n : 100000000n
        case 'allowance': return config.lowAllowance ? 1n : 100000000n
        case 'isPaymentToken': return !config.unapprovedToken
        default: throw Error(`unmatched ${functionName}`)
      }
    },
    async getBalance({ address, blockNumber }) { calls.push(['ethBalance', address, blockNumber]);
      return config.lowEth ? 50000n : 100000000000000000n },
    async simulateContract({ account, address, functionName, args, blockNumber }) {
      calls.push(['simulate', account, address, functionName, args, blockNumber])
      if (config.simulateFails) throw Error('reverted with private URL SUPERSECRET')
      return config.badSimulation ? { request: { address: zero, functionName } } :
        { request: { address, functionName } }
    },
    async estimateContractGas({ account, address, functionName, blockNumber }) {
      calls.push(['estimate', account, address, functionName, blockNumber]); return 100000n },
    async getGasPrice() { calls.push(['gasPrice']); return 1000000000n },
  }
  return { client: publicClient, calls }
}

async function draft(config = {}, phase = 'commit', altered = manifest()) {
  const tmp = await privateFixture()
  try {
    const result = await prepareSepoliaRegistration({ manifest: altered, saltFile: tmp.path,
      phase, client: fake(config).client })
    return result
  } finally { await tmp.done() }
}

describe('G2 ENSv2 Sepolia user-wallet offline registration drafting', () => {
  it('binds commit to independently verified ABI selectors and exact 7-parameter encode hash', async () => {
    const m = validateRegistrationManifest(manifest())
    const salt = `0x${fixedSalt.toString('hex')}`
    const parameters = [m.label, WALLET, salt, zero, zero, m.duration, zero32]
    expect(commitmentFor(m, salt)).toBe(keccak256(encodeAbiParameters(
      parseAbiParameters('string,address,bytes32,address,address,uint64,bytes32'), parameters)))
    expect(REG_ABI.find(a => a.name === 'makeCommitment').inputs.map(x => x.type))
      .toEqual(['string', 'address', 'bytes32', 'address', 'address', 'uint64', 'bytes32'])
    expect(REG_ABI.find(a => a.name === 'register').inputs.map(x => x.type))
      .toEqual(['string', 'address', 'bytes32', 'address', 'address', 'uint64', 'address', 'bytes32'])
    // Frozen selectors cross-checked against official Sepolia deployed artifact ABI.
    expect(REG_ABI.find(a => a.name === 'commit').inputs.map(x => x.type)).toEqual(['bytes32'])
    expect(REG_ABI.find(a => a.name === 'getRegisterPrice').inputs.map(x => x.type))
      .toEqual(['string', 'uint64', 'address'])
    for (const [name, selector] of Object.entries({
      makeCommitment: '0x1e966f07', register: '0xcff3e7c2',
      commitmentAt: '0x16a92535', getRegisterPrice: '0x61907b12',
    })) expect(toFunctionSelector(REG_ABI.find(a => a.name === name))).toBe(selector)
    const f = await privateFixture()
    try {
      const r = await prepareSepoliaRegistration({ manifest: manifest(), saltFile: f.path, phase: 'commit' })
      expect(r).toMatchObject({ status: 'BLOCKED', reason: 'RPC_NOT_CONFIGURED', signatures: false,
        broadcasts: false, registrationCompleted: false, sovereignReceipt: false })
      expect(r.commitDraft.data.slice(0, 10)).toBe('0xf14fcbc8')
      expect(decodeFunctionData({ abi: REG_ABI, data: r.commitDraft.data }).args).toEqual([r.commitment])
      expect(JSON.stringify(r)).not.toContain(salt)
      const a = await stat(f.path)
      expect(a.mode & 0o777).toBe(0o600)
      const disk = JSON.parse(await readFile(f.path, 'utf8'))
      expect(disk.salt).toBeTruthy()
      expect(r.commitment).toBe(disk.commitment)
      const second = await prepareSepoliaRegistration({ manifest: manifest(), saltFile: f.path, phase: 'commit' })
      expect(second.commitment).toBe(r.commitment)
      expect(JSON.parse(await readFile(f.path, 'utf8')).salt).toBe(disk.salt)
    } finally { await f.done() }
  })

  it('requires exact wallet and rejects manifest injections before salt creation', async () => {
    const f = await privateFixture()
    try {
      for (const mutate of [m => { m.wallet = '0x3333333333333333333333333333333333333333' },
        m => { m.privateKey = 'SECRET' }, m => { m.label = 'xn--abc' },
        m => { m.durationSeconds = '-1' }, m => { m.maxTotalCost = '0' },
        m => { m.expectedRegistrarCodeHash = h(0) }, m => { m.label = 'abc.eth' }]) {
        const m = manifest(); mutate(m)
        const res = await prepareSepoliaRegistration({ manifest: m, saltFile: f.path, phase: 'commit' })
        expect(res.reason).toBe('INVALID_MANIFEST')
        expect(JSON.stringify(res)).not.toContain('SECRET')
      }
      await expect(stat(f.path)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await f.done() }
  })

  it('rejects unsafe salt directory, symlink, weaker file mode, mismatched label and tamper', async () => {
    const f = await privateFixture()
    try {
      const m = validateRegistrationManifest(manifest())
      await chmod(f.root, 0o755)
      await expect(loadOrCreateSalt(f.path, m, { create: true })).rejects.toThrow('SALT_DIRECTORY_NOT_PRIVATE')
      await chmod(f.root, 0o700)
      await expect(loadOrCreateSalt(f.path, m, { create: true,
        entropy: () => Buffer.alloc(31) })).rejects.toThrow('INVALID_ENTROPY')
      await expect(stat(f.path)).rejects.toMatchObject({ code: 'ENOENT' })
      const salt = await loadOrCreateSalt(f.path, m, { create: true, entropy: () => fixedSalt })
      expect(salt.commitment).toBe(commitmentFor(m, `0x${fixedSalt.toString('hex')}`))
      await chmod(f.path, 0o644)
      await expect(loadOrCreateSalt(f.path, m)).rejects.toThrow('SALT_FILE_UNSAFE')
      await chmod(f.path, 0o600)
      const wrong = validateRegistrationManifest({ ...manifest(), label: 'another-label' })
      await expect(loadOrCreateSalt(f.path, wrong)).rejects.toThrow('SALT_BINDING_MISMATCH')
      const content = JSON.parse(await readFile(f.path, 'utf8'))
      await writeFile(f.path, JSON.stringify({ ...content, commitment: h(5) }), { mode: 0o600 })
      await expect(loadOrCreateSalt(f.path, m)).rejects.toThrow('SALT_BINDING_MISMATCH')
      const symlinkPath = join(f.root, 'link.json')
      await symlink(f.path, symlinkPath)
      await expect(loadOrCreateSalt(symlinkPath, m)).rejects.toThrow('SALT_FILE_UNSAFE')
    } finally { await f.done() }
  })

  it('produces read-only simulated commit after pinned chain, price, token and gas checks', async () => {
    const f = await privateFixture()
    try {
      const { client, calls } = fake()
      const r = await prepareSepoliaRegistration({ manifest: manifest(), saltFile: f.path,
        phase: 'commit', client })
      expect(r).toMatchObject({ reason: 'EXTERNAL_WALLET_ACTION_REQUIRED', simulated: true,
        quoteBase: '8000000', quotePremium: '1000000', totalCost: '9000000',
        signatures: false, broadcasts: false, nativeAuthorityVerified: false })
      expect(r.commitDraft.data.slice(0, 10)).toBe('0xf14fcbc8')
      expect(calls.filter(c => c[0] === 'code')).toHaveLength(2)
      expect(calls.filter(c => c[0] === 'simulate')).toHaveLength(1)
      expect(calls.every(c => c[0] !== 'write' && c[0] !== 'send' && c[0] !== 'sign')).toBe(true)
      expect(calls.filter(c => ['read','code','ethBalance','simulate','estimate'].includes(c[0]))
        .every(c => c.at(-1) === 200n)).toBe(true)
    } finally { await f.done() }
  })

  it('reveal keeps salt local until fully authorized and simulates correct register calldata', async () => {
    const f = await privateFixture()
    try {
      const m = validateRegistrationManifest(manifest())
      const saved = await loadOrCreateSalt(f.path, m, { create: true, entropy: () => fixedSalt })
      const r = await prepareSepoliaRegistration({ manifest: manifest(), saltFile: f.path,
        phase: 'reveal', client: fake({ commitmentTime: now() - 100n }).client })
      expect(r).toMatchObject({ reason: 'EXTERNAL_WALLET_ACTION_REQUIRED', simulated: true,
        registrationCompleted: false, sovereignReceipt: false })
      expect(r.revealDraft.data.slice(0, 10)).toBe('0xcff3e7c2')
      const decoded = decodeFunctionData({ abi: REG_ABI, data: r.revealDraft.data })
      expect(decoded.functionName).toBe('register')
      expect(decoded.args.map((v, i) => i === 6 ? v.toLowerCase() : v))
        .toEqual([m.label, WALLET, saved.salt, zero, zero, m.duration, MOCK_USDC, zero32])
      expect(saved.commitment).toBe(commitmentFor(m, decoded.args[2]))
    } finally { await f.done() }
  })

  it.each([
    ['wrong chain', { wrongChain: true }, 'WRONG_CHAIN'],
    ['stale block', { stale: true }, 'INVALID_LIVE_BLOCK'],
    ['registrar pin', { badCode: REGISTRAR }, 'UNPINNED_RUNTIME'],
    ['token pin', { badCode: MOCK_USDC }, 'UNPINNED_RUNTIME'],
    ['makeCommitment ABI mismatch', { mismatchedHash: true }, 'COMMITMENT_ABI_MISMATCH'],
    ['unavailable', { unavailable: true }, 'NAME_NOT_AVAILABLE'],
    ['short duration', { longMinimum: true }, 'DURATION_TOO_SHORT'],
    ['oracle token not accepted', { unapprovedToken: true }, 'PAYMENT_TOKEN_UNVERIFIED'],
    ['token decimals changed', { wrongDecimals: true }, 'PAYMENT_TOKEN_UNVERIFIED'],
    ['payment limit exceeded', { highCost: true }, 'COST_EXCEEDS_CAP'],
    ['USDC insufficient', { lowBalance: true }, 'INSUFFICIENT_MOCK_USDC'],
    ['existing commitment', { commitmentTime: now() - 100n }, 'COMMITMENT_ALREADY_LIVE'],
    ['simulation rejected', { simulateFails: true }, 'RPC_OR_SIMULATION_FAILED'],
    ['misleading simulation', { badSimulation: true }, 'SIMULATION_UNVERIFIED'],
    ['gas reserve insufficient', { lowEth: true }, 'INSUFFICIENT_GAS_RESERVE'],
    ['head drift', { reorg: true }, 'CHAIN_OR_BLOCK_DRIFT'],
    ['provider error redacted', { throwRpc: true }, 'RPC_OR_SIMULATION_FAILED'],
  ])('commit guards %s', async (_, config, reason) => {
    const r = await draft(config)
    expect(r.reason).toBe(reason)
    expect(r).not.toHaveProperty('revealDraft')
    expect(JSON.stringify(r)).not.toContain('SUPERSECRET')
  })

  it.each([
    ['no commitment', {}, 'COMMITMENT_NOT_IN_WINDOW'],
    ['too new', { commitmentTime: now() - 30n }, 'COMMITMENT_NOT_IN_WINDOW'],
    ['too old', { commitmentTime: now() - 86500n }, 'COMMITMENT_NOT_IN_WINDOW'],
    ['low allowance', { commitmentTime: now() - 100n, lowAllowance: true }, 'ALLOWANCE_TOO_LOW'],
    ['simulation revert', { commitmentTime: now() - 100n, simulateFails: true }, 'RPC_OR_SIMULATION_FAILED'],
  ])('reveal guards %s without exposing salt', async (_, options, reason) => {
    const f = await privateFixture()
    try {
      await loadOrCreateSalt(f.path, validateRegistrationManifest(manifest()),
        { create: true, entropy: () => fixedSalt })
      const r = await prepareSepoliaRegistration({ manifest: manifest(), saltFile: f.path,
        phase: 'reveal', client: fake(options).client })
      expect(r.reason).toBe(reason)
      expect(r).not.toHaveProperty('revealDraft')
      expect(JSON.stringify(r)).not.toContain(fixedSalt.toString('hex'))
      if (reason === 'ALLOWANCE_TOO_LOW') {
        const d = decodeFunctionData({ abi: [
          { type: 'function', name: 'approve', stateMutability: 'nonpayable',
            inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] }],
          data: r.approveDraft.data })
        expect(d.args[0].toLowerCase()).toBe(REGISTRAR)
        expect(d.args[1]).toBe(9000000n)
      }
    } finally { await f.done() }
  })

  it('CLI requires 6 explicit arguments, holds salt in restricted dir, stays blocked and never prints secret', async () => {
    const f = await privateFixture()
    try {
      const mf = join(f.root, 'manifest.json')
      await writeFile(mf, JSON.stringify(manifest()))
      const args = ['scripts/prepare-g2-sepolia-ensv2-registration.mjs', '--manifest', mf,
        '--salt-file', f.path, '--phase', 'commit']
      const env = { ...process.env, COMETENS_SEPOLIA_RPC_URL: '' }
      const run = spawnSync(process.execPath, args, { encoding: 'utf8', env, timeout: 5000 })
      expect(run.status).toBe(2)
      expect(JSON.parse(run.stdout)).toMatchObject({ status: 'BLOCKED', reason: 'RPC_NOT_CONFIGURED' })
      const file = JSON.parse(await readFile(f.path, 'utf8'))
      expect(run.stdout).not.toContain(file.salt)
      const invalid = spawnSync(process.execPath, args.concat('--broadcast'),
        { encoding: 'utf8', env, timeout: 5000 })
      expect(invalid.status).toBe(2)
      expect(invalid.stdout).toBe('')
      expect(invalid.stderr).not.toContain(file.salt)
    } finally { await f.done() }
  })

  it('does not create reveal secrets or calldata without an existing persisted commit salt', async () => {
    const f = await privateFixture()
    try {
      const r = await prepareSepoliaRegistration({ manifest: manifest(), saltFile: f.path,
        phase: 'reveal', client: fake({ commitmentTime: now() - 100n }).client })
      expect(r).toMatchObject({ status: 'BLOCKED', reason: 'SALT_PERSISTENCE_FAILED' })
      expect(r).not.toHaveProperty('revealDraft')
      await expect(stat(f.path)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await f.done() }
  })
})
