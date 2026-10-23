/**
 * An additional finalized-RPC block-hash agreement check, NOT Ethereum
 * consensus validation, live ENS ownership or an OP authorization decision.
 */
import { reconcileNativeIssueResult } from './reconcile-g2-native-result.mjs'

const HASH = /^0x[0-9a-fA-F]{64}$/
const DECIMAL = /^(0|[1-9][0-9]*)$/
const MAX_SECONDS_OLD = 7200n
const MAX_SECONDS_FUTURE = 120n
const same = (a, b) => typeof a === 'string' && typeof b === 'string' &&
  a.toLowerCase() === b.toLowerCase()

export class CorroborationFailure extends Error {
  constructor(code) {
    super(`G2 independent RPC cross-check refused: ${code}`)
    this.code = code
  }
}
const fail = (code) => { throw new CorroborationFailure(code) }
const parseHeight = (v) => typeof v === 'string' && v.length < 79 &&
  DECIMAL.test(v) && BigInt(v) > 0n ? BigInt(v) : fail('invalid-observation')

function validateObservation(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o) ||
      o.status !== 'DUAL_RPC_OBSERVED' ||
      o.evidenceLevel !== 'TWO_FINALIZED_RPC_OBSERVATIONS_ONLY' ||
      o.ethereumConsensusIndependentlyVerified !== false ||
      o.nativeCurrentAuthorityVerified !== false ||
      o.finalizedL1IssuanceVerifiedOnOP !== false ||
      o.opGrantsNativeRights !== false || o.sovereignReceipt !== false ||
      !HASH.test(o.requestId ?? '') || !HASH.test(o.node ?? '') ||
      !HASH.test(o.l1TransactionHash ?? '') || !HASH.test(o.opTransactionHash ?? '') ||
      !HASH.test(o.sourceBlock?.hash ?? '') || !HASH.test(o.opBlock?.hash ?? '')) fail('invalid-observation')
  return {
    l1: { chainId: 11155111, height: parseHeight(o.sourceBlock.number), hash: o.sourceBlock.hash },
    op: { chainId: 11155420, height: parseHeight(o.opBlock.number), hash: o.opBlock.hash },
  }
}

async function checkProvider(client, expected, now) {
  try {
    if (await client.getChainId() !== expected.chainId) fail('wrong-secondary-chain')
    const before = await client.getBlock({ blockTag: 'finalized' })
    if (typeof before?.number !== 'bigint' || typeof before.timestamp !== 'bigint' ||
        !HASH.test(before.hash ?? '') || before.number < expected.height ||
        before.timestamp > now + MAX_SECONDS_FUTURE ||
        before.timestamp + MAX_SECONDS_OLD < now) fail('untrusted-secondary-finality')
    // When finalized itself points to the historical height, it must also
    // attest the SAME hash, not merely a different numbered-block response.
    if (before.number === expected.height && !same(before.hash, expected.hash)) {
      fail('secondary-block-disagreement')
    }
    const historical = await client.getBlock({ blockNumber: expected.height })
    if (historical?.number !== expected.height ||
        !same(historical.hash, expected.hash)) fail('secondary-block-disagreement')

    const after = await client.getBlock({ blockTag: 'finalized' })
    if (typeof after?.number !== 'bigint' || typeof after.timestamp !== 'bigint' ||
        !HASH.test(after.hash ?? '') || after.number < before.number ||
        after.timestamp > now + MAX_SECONDS_FUTURE ||
        after.timestamp + MAX_SECONDS_OLD < now ||
        (after.number === before.number && !same(after.hash, before.hash))) {
      fail('unstable-secondary-finality')
    }
    if (after.number === expected.height && !same(after.hash, expected.hash)) {
      fail('secondary-block-disagreement')
    }
    const historicAgain = await client.getBlock({ blockNumber: expected.height })
    if (historicAgain?.number !== expected.height ||
        !same(historicAgain.hash, expected.hash)) fail('secondary-block-disagreement')
    return { blockNumber: expected.height.toString(), blockHash: expected.hash.toLowerCase(),
      claimedFinalizedNumber: after.number.toString() }
  } catch (error) {
    if (error instanceof CorroborationFailure) throw error
    // Never return provider errors; upstream URLs can contain credentials.
    fail('unverifiable-secondary-rpc')
  }
}

/** The primary observation must already be produced by PR #159's audit. */
export async function corroborateNativeResultBlocks({
  observation, secondaryL1, secondaryOp, now = () => BigInt(Math.floor(Date.now() / 1000)),
}) {
  const pins = validateObservation(observation)
  if (!secondaryL1 || !secondaryOp || secondaryL1 === secondaryOp) fail('invalid-providers')
  const at = now()
  if (typeof at !== 'bigint' || at < 0n) fail('invalid-clock')
  const [l1, op] = await Promise.all([
    checkProvider(secondaryL1, pins.l1, at),
    checkProvider(secondaryOp, pins.op, at),
  ])
  return {
    status: 'TWO_RPC_PROVIDER_BLOCK_HASH_AGREEMENT',
    requestId: observation.requestId, node: observation.node,
    sourceBlock: l1, opBlock: op,
    l1TransactionHash: observation.l1TransactionHash,
    opTransactionHash: observation.opTransactionHash,
    historicalObservationsCorroborated: true,
    providerIndependenceVerified: false,
    ethereumConsensusIndependentlyVerified: false,
    nativeCurrentAuthorityVerified: false,
    finalizedL1IssuanceVerifiedOnOP: false,
    opGrantsNativeRights: false, sovereignReceipt: false,
    evidenceLevel: 'SECONDARY_FINALIZED_RPC_HEADER_AGREEMENT_ONLY',
  }
}

/** Calls the approved read-only cross-chain reconciler first, then cross-checks. */
export async function reconcileWithSecondProviders({
  l1Client, opClient, secondaryL1, secondaryOp, profile,
}) {
  if (!l1Client || !opClient || !secondaryL1 || !secondaryOp ||
      secondaryL1 === l1Client || secondaryOp === opClient ||
      secondaryL1 === secondaryOp) fail('invalid-providers')
  const observation = await reconcileNativeIssueResult({ l1Client, opClient, profile })
  return corroborateNativeResultBlocks({ observation, secondaryL1, secondaryOp })
}
