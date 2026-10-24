// Read-only member authority observation; a registration tx alone never certifies G2 sovereignty.
import { inspectEnsv2 } from './inspect-ensv2-risk.mjs'

// Current ENSv2 Sepolia ETHRegistrar deployment, not archived July 2026 address.
const SEPOLIA_ETH_REGISTRAR = '0xf633e7fc17e2bbe0d0965d18ec1821dcb754a3d3'

const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()
const fail = (reason) => ({ verdict: 'BLOCKED', reason, nativeOwnershipObserved: false,
  eacExclusiveControlVerified: false, independentlyFinalized: false, sovereignReceipt: false })

export async function auditG2Ensv2Parent({ client, manifest, expectedOwner, registrationReceipt }) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(expectedOwner ?? '') || !registrationReceipt ||
      registrationReceipt.status !== 'success' ||
      !/^0x[0-9a-fA-F]{64}$/.test(registrationReceipt.transactionHash ?? '') ||
      typeof registrationReceipt.blockNumber !== 'bigint' ||
      registrationReceipt.blockNumber <= 0n ||
      !same(registrationReceipt.to, SEPOLIA_ETH_REGISTRAR)) return fail('INVALID_REGISTRATION_RECEIPT')
  const evidence = await inspectEnsv2({ client, manifest })
  if (!Array.isArray(evidence.visited) || !evidence.checkedAllAncestry ||
      !/^[0-9]+$/.test(evidence.finalized?.number ?? '')) return fail('EAC_NOT_OBSERVABLE')
  if (BigInt(evidence.finalized.number) < registrationReceipt.blockNumber) return fail('REGISTRATION_NOT_FINALIZED')
  const name = manifest.name
  const current = evidence.visited.at(-1)
  if (!current || current.label !== name.split('.')[0] || current.status !== 2 ||
      !same(current.owner, expectedOwner) || !/^[0-9]+$/.test(current.expiry ?? '') ||
      BigInt(current.expiry) <= BigInt(Math.floor(Date.now() / 1000))) return fail('NOT_CURRENT_OWNER')
  return { verdict: 'REGISTERED_OWNER_RPC_OBSERVED_ONLY', name,
    expectedOwner, finalized: evidence.finalized,
    registrationTxHash: registrationReceipt.transactionHash,
    registeredExpiresAt: current.expiry, findings: evidence.findings,
    nativeOwnershipObserved: true, eacExclusiveControlVerified: false,
    independentlyFinalized: false, sovereignReceipt: false }
}
