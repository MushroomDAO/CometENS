#!/usr/bin/env node
/** Strictly read-only preparation. This module never constructs a wallet client. */
import { createPublicClient, http, isAddressEqual, keccak256, zeroAddress } from 'viem'
import { sepolia } from 'viem/chains'
import { pathToFileURL } from 'node:url'

export const WALLET = '0xF7Bf79AcB7F3702b9DbD397d8140ac9DE6Ce642C'
export const DELEGATE = '0x5804b6119d12ad403a430fd3cff12a8ff6e4064b'
export const CHAIN = 11155111
export const DELEGATE_HASH = '0xa7537d192ef8051322146be7540c39537d9ee4428a8cde0c74f6d3980173aeb3'
const PREFIX = '0xef0100'
export function checkSnapshot({ chainId, wallet, code, delegateCode, expectedDelegateCodeHash = DELEGATE_HASH, latestNonce, pendingNonce }) {
  const blocked = (reason) => ({ status: 'BLOCKED', reason, safeToSign: false, broadcast: false })
  if (chainId !== CHAIN || !wallet || !isAddressEqual(wallet, WALLET)) return blocked('WRONG_CHAIN_OR_WALLET')
  if (typeof code !== 'string' || code.toLowerCase() !== `${PREFIX}${DELEGATE.slice(2)}`.toLowerCase()) return blocked('DELEGATION_CHANGED')
  if (typeof delegateCode !== 'string' || delegateCode === '0x' ||
      !/^0x[0-9a-f]{64}$/i.test(expectedDelegateCodeHash ?? '') ||
      keccak256(delegateCode).toLowerCase() !== expectedDelegateCodeHash.toLowerCase()) return blocked('DELEGATE_CODEHASH_MISMATCH')
  if (!Number.isSafeInteger(latestNonce) || !Number.isSafeInteger(pendingNonce) ||
      latestNonce < 0 || pendingNonce !== latestNonce || latestNonce >= Number.MAX_SAFE_INTEGER - 1) return blocked('NONCE_PENDING_OR_INVALID')
  return { status: 'READY_FOR_HUMAN_REVIEW', safeToSign: false, broadcast: false,
    chainId: CHAIN, wallet: WALLET, currentDelegate: DELEGATE, verifiedDelegateCodeHash: expectedDelegateCodeHash,
    observedTransactionNonce: latestNonce, expectedSelfAuthorizationNonce: latestNonce + 1,
    targetContractAddress: zeroAddress, executor: 'self',
    note: 'UNSIGNED ONLY. Revoking changes smart-account behavior and does not clear storage. Recheck state and nonce immediately before any human-controlled signing.' }
}

export async function checkRemote(client) {
  const chainId = await client.getChainId()
  if (chainId !== CHAIN) return checkSnapshot({ chainId, wallet: WALLET })
  const [code, delegateCode, latestNonce, pendingNonce] = await Promise.all([
    client.getBytecode({ address: WALLET }), client.getBytecode({ address: DELEGATE }),
    client.getTransactionCount({ address: WALLET, blockTag: 'latest' }),
    client.getTransactionCount({ address: WALLET, blockTag: 'pending' }),
  ])
  return checkSnapshot({ chainId, wallet: WALLET, code, delegateCode, expectedDelegateCodeHash: DELEGATE_HASH, latestNonce, pendingNonce })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = process.argv.slice(2)
  if (options.length !== 2 || options[0] !== '--rpc') {
    console.error('Usage: node scripts/check-g2-sepolia-7702-revocation.mjs --rpc <trusted-Sepolia-RPC>')
    process.exitCode = 1
  } else {
    const client = createPublicClient({ chain: sepolia, transport: http(options[1], { timeout: 15000 }) })
    try {
      const result = await checkRemote(client)
      console.log(JSON.stringify(result, null, 2))
      // Deliberately exit nonzero even when the snapshot matches: no signing authorization.
      process.exitCode = 2
    } catch {
      console.error('BLOCKED: RPC_UNVERIFIED')
      process.exitCode = 2
    }
  }
}
