#!/usr/bin/env node
/** ENSv2 Sepolia draft only: never signs, sends or imports wallet credentials. */
import { randomBytes } from 'node:crypto'
import { open, lstat, realpath, readFile, unlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, isAbsolute, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createPublicClient, encodeAbiParameters, encodeFunctionData, http, isAddress, keccak256,
  parseAbi, parseAbiParameters } from 'viem'
import { sepolia } from 'viem/chains'

// ENS official deployments, contracts-v2 artifact commit 07e55a056f5b6a9c90119f501bdd05714e67dddd.
export const REGISTRAR = '0xf633e7fc17e2bbe0d0965d18ec1821dcb754a3d3'
export const MOCK_USDC = '0x240b0316df57887dbbe58b586508b19e633a14aa'
export const WALLET = '0xF7Bf79AcB7F3702b9DbD397d8140ac9DE6Ce642C'
const ZERO = '0x0000000000000000000000000000000000000000'
const ZERO32 = `0x${'00'.repeat(32)}`
const HEX32 = /^0x[0-9a-fA-F]{64}$/
const UINT64_MAX = (1n << 64n) - 1n
export const REG_ABI = parseAbi([
  'function makeCommitment(string label,address owner,bytes32 secret,address subregistry,address resolver,uint64 duration,bytes32 referrer) pure returns (bytes32)',
  'function commit(bytes32 commitment)',
  'function register(string label,address owner,bytes32 secret,address subregistry,address resolver,uint64 duration,address paymentToken,bytes32 referrer) returns (uint256 tokenId)',
  'function commitmentAt(bytes32 commitment) view returns (uint64)',
  'function MIN_COMMITMENT_AGE() view returns (uint64)',
  'function MAX_COMMITMENT_AGE() view returns (uint64)',
  'function MIN_REGISTER_DURATION() view returns (uint64)',
  'function isAvailable(string label) view returns (bool)',
  'function getRegisterPrice(string label,uint64 duration,address paymentToken) view returns (uint256 base,uint256 premium)',
  'function rentPriceOracle() view returns (address)',
])
const TOKEN_ABI = parseAbi(['function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)', 'function decimals() view returns (uint8)',
  'function approve(address,uint256) returns (bool)'])
const ORACLE_ABI = parseAbi(['function isPaymentToken(address) view returns (bool)'])
const COMMIT_TYPES = parseAbiParameters('string,address,bytes32,address,address,uint64,bytes32')
const fail = (reason, extra = {}) => ({ status: 'BLOCKED', reason, chainId: 11155111,
  broadcasts: false, signatures: false, nativeAuthorityVerified: false,
  registrationCompleted: false, sovereignReceipt: false, ...extra })
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()
const positive = s => typeof s === 'string' && /^(0|[1-9][0-9]*)$/.test(s)

export function validateRegistrationManifest(raw) {
  if (!raw || Object.getPrototypeOf(raw) !== Object.prototype ||
      Object.keys(raw).sort().join(',') !== 'durationSeconds,expectedRegistrarCodeHash,expectedTokenCodeHash,label,maxTotalCost,wallet' ||
      !same(raw.wallet, WALLET) || typeof raw.label !== 'string' ||
      !/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/.test(raw.label) ||
      (raw.label.length >= 4 && raw.label.slice(2, 4) === '--') ||
      !positive(raw.durationSeconds) || !positive(raw.maxTotalCost) ||
      !HEX32.test(raw.expectedRegistrarCodeHash ?? '') || !HEX32.test(raw.expectedTokenCodeHash ?? '') ||
      same(raw.expectedRegistrarCodeHash, ZERO32) || same(raw.expectedTokenCodeHash, ZERO32)) {
    throw Error('INVALID_MANIFEST')
  }
  const duration = BigInt(raw.durationSeconds)
  const maxCost = BigInt(raw.maxTotalCost)
  if (duration === 0n || duration > UINT64_MAX || maxCost === 0n) throw Error('INVALID_MANIFEST')
  return Object.freeze({ label: raw.label, wallet: WALLET, duration,
    maxCost, registrarCodeHash: raw.expectedRegistrarCodeHash.toLowerCase(),
    tokenCodeHash: raw.expectedTokenCodeHash.toLowerCase() })
}

const commitArgs = (m, salt) => [m.label, WALLET, salt, ZERO, ZERO, m.duration, ZERO32]
export function commitmentFor(m, salt) {
  if (!HEX32.test(salt) || same(salt, ZERO32)) throw Error('INVALID_SALT')
  return keccak256(encodeAbiParameters(COMMIT_TYPES, commitArgs(m, salt)))
}

/** Use a pre-existing 0700 private directory OUTSIDE the repository, with atomic 0600 create. */
export async function loadOrCreateSalt(file, m, { create = false, entropy = () => randomBytes(32) } = {}) {
  if (!isAbsolute(file)) throw Error('SALT_PATH_NOT_ABSOLUTE')
  const directory = await realpath(dirname(file))
  const repo = resolve(fileURLToPath(new URL('..', import.meta.url)))
  if (directory === repo || directory.startsWith(repo + sep)) throw Error('SALT_INSIDE_REPO')
  const folder = await lstat(directory)
  if (!folder.isDirectory() || (folder.mode & 0o077) !== 0 || folder.uid !== process.getuid()) {
    throw Error('SALT_DIRECTORY_NOT_PRIVATE')
  }
  let handle
  let newlyCreated = false
  let persisted = false
  try {
    if (create) {
      try {
        handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        newlyCreated = true
        const bytes = entropy()
        if (!Buffer.isBuffer(bytes) || bytes.length !== 32) throw Error('INVALID_ENTROPY')
        const salt = `0x${bytes.toString('hex')}`
        if (same(salt, ZERO32)) throw Error('INVALID_ENTROPY')
        const content = JSON.stringify({ version: 1, label: m.label, wallet: WALLET,
          durationSeconds: String(m.duration), commitment: commitmentFor(m, salt), salt })
        await handle.writeFile(`${content}\n`, { encoding: 'utf8' })
        await handle.sync()
        persisted = true
      } catch (e) {
        if (e.code !== 'EEXIST') throw e
      } finally {
        await handle?.close()
        if (newlyCreated && !persisted) await unlink(file)
      }
    }
    const stat = await lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600 ||
        stat.uid !== process.getuid() || stat.size > 2048) throw Error('SALT_FILE_UNSAFE')
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
    const disk = JSON.parse(await handle.readFile({ encoding: 'utf8' }))
    if (!disk || Object.keys(disk).sort().join(',') !== 'commitment,durationSeconds,label,salt,version,wallet' ||
        disk.version !== 1 || disk.label !== m.label || !same(disk.wallet, WALLET) ||
        disk.durationSeconds !== String(m.duration) || !HEX32.test(disk.salt ?? '') ||
        !same(disk.commitment, commitmentFor(m, disk.salt))) throw Error('SALT_BINDING_MISMATCH')
    return Object.freeze({ salt: disk.salt, commitment: disk.commitment })
  } finally { await handle?.close() }
}

/** Public-client-only checks, with 0x-prefixed calldata returned for external user inspection. */
export async function prepareSepoliaRegistration({ manifest, saltFile, phase, client }) {
  let m
  try { m = validateRegistrationManifest(manifest) } catch { return fail('INVALID_MANIFEST') }
  if (phase !== 'commit' && phase !== 'reveal') return fail('INVALID_PHASE')
  let secret
  try { secret = await loadOrCreateSalt(saltFile, m, { create: phase === 'commit' }) }
  catch { return fail('SALT_PERSISTENCE_FAILED') }
  const { commitment, salt } = secret
  const fn = phase === 'commit' ? 'commit' : 'register'
  const args = phase === 'commit' ? [commitment] : [...commitArgs(m, salt).slice(0, 6), MOCK_USDC, ZERO32]
  const calldata = encodeFunctionData({ abi: REG_ABI, functionName: fn, args })
  // Never reveal the secret or reveal-calldata before the prerequisite reads and simulation pass.
  const blocked = (reason, extra = {}) => fail(reason, {
    phase, commitment, ...(phase === 'commit' ? { commitDraft: { to: REGISTRAR,
      from: WALLET, value: '0', data: calldata } } : {}), ...extra,
  })
  if (!client) return blocked('RPC_NOT_CONFIGURED')
  try {
    if (await client.getChainId() !== 11155111) return blocked('WRONG_CHAIN')
    const block = await client.getBlock({ blockTag: 'latest' })
    const now = BigInt(Math.floor(Date.now() / 1000))
    if (typeof block?.number !== 'bigint' || typeof block.timestamp !== 'bigint' ||
      !HEX32.test(block.hash ?? '') || block.timestamp > now + 120n ||
      now - block.timestamp > 120n) return blocked('INVALID_LIVE_BLOCK')
    const at = block.number
    for (const [address, expected] of [[REGISTRAR, m.registrarCodeHash], [MOCK_USDC, m.tokenCodeHash]]) {
      const code = await client.getBytecode({ address, blockNumber: at })
      if (!code || code === '0x' || !same(keccak256(code), expected)) return blocked('UNPINNED_RUNTIME')
    }
    const read = (address, abi, functionName, args = []) => client.readContract({
      address, abi, functionName, args, blockNumber: at })
    const [onChainCommitment, available, minDuration, minAge, maxAge, commitmentAt,
      quote, oracle, decimals, tokenBalance, allowance, ethBalance] = await Promise.all([
      read(REGISTRAR, REG_ABI, 'makeCommitment', commitArgs(m, salt)),
      read(REGISTRAR, REG_ABI, 'isAvailable', [m.label]),
      read(REGISTRAR, REG_ABI, 'MIN_REGISTER_DURATION'),
      read(REGISTRAR, REG_ABI, 'MIN_COMMITMENT_AGE'),
      read(REGISTRAR, REG_ABI, 'MAX_COMMITMENT_AGE'),
      read(REGISTRAR, REG_ABI, 'commitmentAt', [commitment]),
      read(REGISTRAR, REG_ABI, 'getRegisterPrice', [m.label, m.duration, MOCK_USDC]),
      read(REGISTRAR, REG_ABI, 'rentPriceOracle'),
      read(MOCK_USDC, TOKEN_ABI, 'decimals'),
      read(MOCK_USDC, TOKEN_ABI, 'balanceOf', [WALLET]),
      read(MOCK_USDC, TOKEN_ABI, 'allowance', [WALLET, REGISTRAR]),
      client.getBalance({ address: WALLET, blockNumber: at }),
    ])
    if (!same(onChainCommitment, commitment)) return blocked('COMMITMENT_ABI_MISMATCH')
    if (available !== true) return blocked('NAME_NOT_AVAILABLE')
    if (m.duration < BigInt(minDuration)) return blocked('DURATION_TOO_SHORT')
    if (typeof oracle !== 'string' || !isAddress(oracle) || same(oracle, ZERO) ||
        await read(oracle, ORACLE_ABI, 'isPaymentToken', [MOCK_USDC]) !== true || Number(decimals) !== 6) {
      return blocked('PAYMENT_TOKEN_UNVERIFIED')
    }
    if (!Array.isArray(quote) || quote.length !== 2) return blocked('PRICE_UNVERIFIABLE')
    const price = BigInt(quote[0]) + BigInt(quote[1])
    if (price <= 0n || price > m.maxCost) return blocked('COST_EXCEEDS_CAP')
    if (BigInt(tokenBalance) < price) return blocked('INSUFFICIENT_MOCK_USDC', { required: String(price) })
    // Registrar reprices at transaction inclusion. Keep ERC20 transferFrom's
    // actual spending allowance bounded by the wallet's explicit price cap.
    if (phase === 'reveal' && BigInt(allowance) > m.maxCost) return blocked('ALLOWANCE_EXCEEDS_CAP', {
      maxTotalCost: String(m.maxCost), approveDraft: { to: MOCK_USDC, from: WALLET, value: '0',
        data: encodeFunctionData({ abi: TOKEN_ABI, functionName: 'approve', args: [REGISTRAR, price] }) },
    })
    if (phase === 'reveal' && BigInt(allowance) < price) return blocked('ALLOWANCE_TOO_LOW', {
      required: String(price), approveDraft: { to: MOCK_USDC, from: WALLET, value: '0',
        data: encodeFunctionData({ abi: TOKEN_ABI, functionName: 'approve', args: [REGISTRAR, price] }) },
    })
    if (phase === 'commit' && BigInt(commitmentAt) !== 0n &&
        BigInt(commitmentAt) + BigInt(maxAge) > block.timestamp) return blocked('COMMITMENT_ALREADY_LIVE')
    if (phase === 'reveal' && (BigInt(commitmentAt) === 0n ||
        block.timestamp < BigInt(commitmentAt) + BigInt(minAge) ||
        block.timestamp >= BigInt(commitmentAt) + BigInt(maxAge))) return blocked('COMMITMENT_NOT_IN_WINDOW')
    const sim = await client.simulateContract({ account: WALLET, address: REGISTRAR,
      abi: REG_ABI, functionName: fn, args, blockNumber: at })
    if (!sim || !same(sim.request?.address, REGISTRAR) || sim.request?.functionName !== fn) {
      return blocked('SIMULATION_UNVERIFIED')
    }
    const gas = BigInt(await client.estimateContractGas({ account: WALLET, address: REGISTRAR,
      abi: REG_ABI, functionName: fn, args, blockNumber: at }))
    const gasPrice = BigInt(await client.getGasPrice())
    if (gas <= 0n || gasPrice <= 0n || BigInt(ethBalance) < gas * gasPrice * 2n) {
      return blocked('INSUFFICIENT_GAS_RESERVE')
    }
    if (await client.getChainId() !== 11155111 ||
        !same((await client.getBlock({ blockNumber: at })).hash, block.hash) ||
        BigInt(Math.floor(Date.now() / 1000)) - block.timestamp > 120n) {
      return blocked('CHAIN_OR_BLOCK_DRIFT')
    }
    return { ...blocked('EXTERNAL_WALLET_ACTION_REQUIRED', { quoteBase: String(quote[0]),
      quotePremium: String(quote[1]), totalCost: String(price), allowance: String(allowance),
      paymentBalance: String(tokenBalance), gasReserveWei: String(gas * gasPrice * 2n),
      ...(phase === 'reveal' ? { revealDraft: { to: REGISTRAR, from: WALLET, value: '0', data: calldata } } : {}),
    }), simulated: true, simulationBlock: { number: String(at), hash: block.hash },
    }
  } catch { return blocked('RPC_OR_SIMULATION_FAILED') }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [flagA, manifestPath, flagB, saltFile, flagC, phase] = process.argv.slice(2)
    if (process.argv.length !== 8 || flagA !== '--manifest' || flagB !== '--salt-file' ||
        flagC !== '--phase' || !['commit', 'reveal'].includes(phase)) throw Error('ARGUMENTS')
    const raw = await readFile(manifestPath)
    if (raw.length > 4096) throw Error('MANIFEST_TOO_LARGE')
    let client
    const rpc = process.env.COMETENS_SEPOLIA_RPC_URL
    if (rpc) {
      const u = new URL(rpc)
      if (u.protocol !== 'https:' || u.username || u.password) throw Error('INVALID_RPC')
      client = createPublicClient({ chain: sepolia, transport: http(rpc, { retryCount: 0 }) })
    }
    const result = await prepareSepoliaRegistration({ manifest: JSON.parse(raw), saltFile, phase, client })
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    process.exitCode = 2 // A draft is never a transaction approval.
  } catch {
    process.stderr.write('ENSv2 Sepolia offline registration BLOCKED (invalid local input); no chain write.\n')
    process.exitCode = 2
  }
}
