#!/usr/bin/env node
// Read-only ENSv2 candidate and wallet snapshot; never signs, registers or certifies availability.
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { createPublicClient, http, isAddress, keccak256, toHex, formatEther } from 'viem'
import { sepolia } from 'viem/chains'

// Current ENS docs Sepolia (October 2026), NOT archived July 2026 addresses.
export const ETH_REGISTRY = '0xd4ebcbbdf463c9c45784603db0ddd499bc44a8b4'
export const ETH_REGISTRAR = '0xf633e7fc17e2bbe0d0965d18ec1821dcb754a3d3'
export const MOCK_USDC = '0x240b0316df57887dbbe58b586508b19e633a14aa'
const HEX32 = /^0x[0-9a-fA-F]{64}$/
const ZERO = '0x0000000000000000000000000000000000000000'
const ABI = [{ type: 'function', name: 'getState', stateMutability: 'view',
  inputs: [{ type: 'uint256' }], outputs: [{ type: 'tuple', components: [
    { name: 'status', type: 'uint8' }, { name: 'expiry', type: 'uint64' },
    { name: 'latestOwner', type: 'address' }, { name: 'tokenId', type: 'uint256' },
    { name: 'resource', type: 'uint256' },
  ] }] }]
const BALANCE = [{ type: 'function', name: 'balanceOf', stateMutability: 'view',
  inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }]
const fail = reason => ({ verdict: 'BLOCKED', reason, chainId: 11155111,
  registrationAvailableVerified: false, nativeAuthorityVerified: false, sovereignReceipt: false })

export async function checkSepoliaRegistration({ client, wallet, labels }) {
  if (!isAddress(wallet) || !Array.isArray(labels) || labels.length < 1 || labels.length > 5 ||
    labels.some(s => typeof s !== 'string' || !/^[a-z0-9][a-z0-9-]{2,62}$/.test(s) ||
      s.endsWith('-') || s.includes('--'))) return fail('INVALID_INPUT')
  try {
    if (await client.getChainId() !== 11155111) return fail('WRONG_CHAIN')
    const block = await client.getBlock({ blockTag: 'finalized' })
    if (typeof block.number !== 'bigint' || !HEX32.test(block.hash ?? '') ||
      typeof block.timestamp !== 'bigint') return fail('BAD_FINALIZED_BLOCK')
    const now = BigInt(Math.floor(Date.now() / 1000))
    if (block.timestamp > now + 120n || now - block.timestamp > 7200n) return fail('STALE_FINALITY')
    const at = block.number
    for (const address of [ETH_REGISTRY, ETH_REGISTRAR, MOCK_USDC]) {
      const code = await client.getBytecode({ address, blockNumber: at })
      if (!code || code === '0x') return fail('OFFICIAL_CONTRACT_CODE_MISSING')
    }
    const [gas, usdc] = await Promise.all([
      client.getBalance({ address: wallet, blockNumber: at }),
      client.readContract({ address: MOCK_USDC, abi: BALANCE, functionName: 'balanceOf', args: [wallet], blockNumber: at }),
    ])
    const names = []
    for (const label of labels) {
      const state = await client.readContract({ address: ETH_REGISTRY, abi: ABI, functionName: 'getState',
        args: [BigInt(keccak256(toHex(label)))], blockNumber: at })
      if (!Number.isInteger(state?.status) || typeof state.expiry !== 'bigint' ||
        !isAddress(state.latestOwner)) return fail('INVALID_ENSV2_STATE')
      names.push({ name: `${label}.eth`, state: state.status, owner: state.latestOwner,
        expiry: state.expiry.toString(), unregisteredSnapshot: state.status === 0 &&
          state.latestOwner.toLowerCase() === ZERO && state.expiry === 0n })
    }
    const repeat = await client.getBlock({ blockNumber: at })
    if (repeat.hash?.toLowerCase() !== block.hash.toLowerCase()) return fail('FINALIZED_BLOCK_CHANGED')
    return { verdict: 'READ_ONLY_SNAPSHOT', chainId: 11155111,
      finalized: { number: String(at), hash: block.hash }, wallet,
      sepoliaEth: formatEther(gas), mockUsdcBaseUnits: String(usdc), names,
      registrationAvailableVerified: false, nativeAuthorityVerified: false, sovereignReceipt: false,
      note: 'An unregistered registry snapshot does not prove registrar availability, price, commitment or execution rights' }
  } catch { return fail('RPC_OR_ABI_UNVERIFIABLE') }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) throw Error('invalid arguments')
    const rpc = process.env.COMETENS_SEPOLIA_RPC_URL
    const parsed = new URL(rpc)
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw Error('invalid RPC')
    const bytes = await readFile(process.argv[2])
    if (bytes.length > 2048) throw Error('manifest too large')
    const config = JSON.parse(bytes.toString())
    if (Object.keys(config).sort().join(',') !== 'labels,wallet') throw Error('invalid config')
    const result = await checkSepoliaRegistration({ ...config,
      client: createPublicClient({ chain: sepolia, transport: http(rpc, { retryCount: 0 }) }) })
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    if (result.verdict !== 'READ_ONLY_SNAPSHOT') process.exitCode = 2
  } catch {
    process.stderr.write('Sepolia ENSv2 registration preflight BLOCKED: invalid config or RPC; no chain write.\n')
    process.exitCode = 2
  }
}
