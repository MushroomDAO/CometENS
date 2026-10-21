/**
 * Read-only evidence for LEGACY ENSv1 on Ethereum Sepolia, not ENSv2.
 * This NEVER authorizes an OP controller or emits a SOVEREIGN receipt.
 * Source: https://docs.ens.domains/learn/deployments/
 */
import { createPublicClient, http, isAddress, keccak256, namehash } from 'viem'
import { sepolia } from 'viem/chains'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const ENSV1_SEPOLIA_REGISTRY = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e'
export const ENSV1_SEPOLIA_WRAPPER = '0x0635513f179D50A207757E05759CbD106d7dFcE8'
export const CANNOT_UNWRAP = 1
export const PARENT_CANNOT_CONTROL = 1 << 16

const registryAbi = [{ type: 'function', name: 'owner', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'address' }] }]
const wrapperAbi = [{
  type: 'function', name: 'getData', stateMutability: 'view',
  inputs: [{ type: 'uint256' }], outputs: [{ type: 'address' }, { type: 'uint32' }, { type: 'uint64' }],
}]
const HEX32 = /^0x[0-9a-fA-F]{64}$/
const ZERO = '0x0000000000000000000000000000000000000000'

export class EvidenceFailure extends Error {
  constructor(code) { super(`ENSv1 evidence refused: ${code}`); this.code = code; this.name = 'EvidenceFailure' }
}

const nonzero = (addr) => typeof addr === 'string' && isAddress(addr) && addr.toLowerCase() !== ZERO
const matches = (a, b) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase()

function validEnsName(name, directParent) {
  if (typeof name !== 'string' || name !== name.toLowerCase()) return false
  const labels = name.split('.')
  if (labels.length < 2 || labels.at(-1) !== 'eth') return false
  if (!labels.every((label) => label.length >= 1 && label.length <= 63 &&
      /^[a-z0-9-]+$/.test(label) && label[0] !== '-' && label.at(-1) !== '-' &&
      !(label.length >= 4 && label[2] === '-' && label[3] === '-'))) return false
  return !directParent || (labels.length === directParent.split('.').length + 1 && name.endsWith(`.${directParent}`))
}

/**
 * An independently pinned read-only snapshot. Block, code, owner and wrapped
 * fuses all come from the SAME finalized L1 block. No OP chain write/bridge.
 */
export async function auditLegacyEnsV1({ client, parentName, childName, expectedRegistryCodeHash, expectedWrapperCodeHash }) {
  if (!client || !validEnsName(parentName) || !validEnsName(childName, parentName) ||
      !HEX32.test(expectedRegistryCodeHash ?? '') || !HEX32.test(expectedWrapperCodeHash ?? '')) {
    throw new EvidenceFailure('invalid-input')
  }

  try {
    if (await client.getChainId() !== 11155111) throw new EvidenceFailure('wrong-chain')
    // No 'latest' fallback: absent finalized support means no freshness claim.
    const block = await client.getBlock({ blockTag: 'finalized' })
    if (typeof block.number !== 'bigint' || typeof block.timestamp !== 'bigint') throw new EvidenceFailure('unverified-block')
    const now = BigInt(Math.floor(Date.now() / 1000))
    if (block.timestamp > now + 120n || block.timestamp + 7200n < now) throw new EvidenceFailure('stale-finality')
    const blockNumber = block.number
    const [registryCode, wrapperCode] = await Promise.all([
      client.getBytecode({ address: ENSV1_SEPOLIA_REGISTRY, blockNumber }),
      client.getBytecode({ address: ENSV1_SEPOLIA_WRAPPER, blockNumber }),
    ])
    if (!registryCode || registryCode === '0x' || !wrapperCode || wrapperCode === '0x' ||
        keccak256(registryCode).toLowerCase() !== expectedRegistryCodeHash.toLowerCase() ||
        keccak256(wrapperCode).toLowerCase() !== expectedWrapperCodeHash.toLowerCase()) {
      throw new EvidenceFailure('untrusted-bytecode')
    }

    const parentNode = namehash(parentName)
    const childNode = namehash(childName)
    const [parentRegistryOwner, childRegistryOwner] = await Promise.all([
      client.readContract({ address: ENSV1_SEPOLIA_REGISTRY, abi: registryAbi, functionName: 'owner', args: [parentNode], blockNumber }),
      client.readContract({ address: ENSV1_SEPOLIA_REGISTRY, abi: registryAbi, functionName: 'owner', args: [childNode], blockNumber }),
    ])
    if (!nonzero(parentRegistryOwner)) throw new EvidenceFailure('missing-parent')

    async function wrappedData(node, registryOwner) {
      if (!matches(registryOwner, ENSV1_SEPOLIA_WRAPPER)) return null
      const data = await client.readContract({ address: ENSV1_SEPOLIA_WRAPPER, abi: wrapperAbi,
        functionName: 'getData', args: [BigInt(node)], blockNumber })
      if (!Array.isArray(data) || data.length !== 3 || typeof data[1] !== 'number' || typeof data[2] !== 'bigint') {
        throw new EvidenceFailure('invalid-wrapper-data')
      }
      return { holder: data[0], fuses: data[1], expiry: data[2] }
    }

    const [parent, child] = await Promise.all([
      wrappedData(parentNode, parentRegistryOwner), wrappedData(childNode, childRegistryOwner),
    ])
    // A finalized block can predate expiry; a name that has expired NOW is
    // not safe merely because its previously-finalized snapshot was valid.
    const parentValid = !!parent && nonzero(parent.holder) && parent.expiry > now && parent.expiry > block.timestamp
    const childValid = !!child && nonzero(child.holder) && child.expiry > now && child.expiry > block.timestamp &&
      !!parent && child.expiry <= parent.expiry
    const parentLocked = parentValid && (parent.fuses & CANNOT_UNWRAP) !== 0
    const childLocked = childValid && (child.fuses & CANNOT_UNWRAP) !== 0
    const childEmancipated = childValid && (child.fuses & PARENT_CANNOT_CONTROL) !== 0

    return {
      mode: 'LEGACY_ENSV1_SEPOLIA_OBSERVATION_ONLY',
      // Sepolia ENSv2 is the current standard deployment. Do not classify this
      // legacy v1 state as a live ENSv2 security or resolution assertion.
      opControllerAuthorityVerified: false,
      sovereignReceipt: false,
      ensV2AuthorityVerified: false,
      chainId: 11155111,
      blockNumber: blockNumber.toString(), blockTimestamp: block.timestamp.toString(),
      parentName, childName, parentNode, childNode,
      parentRegistryOwner, childRegistryOwner,
      parentWrappedHolder: parent?.holder ?? null,
      childWrappedHolder: child?.holder ?? null,
      parentExpiry: parent?.expiry.toString() ?? null,
      childExpiry: child?.expiry.toString() ?? null,
      parentLocked: !!parentLocked, childLocked: !!childLocked, childEmancipated: !!childEmancipated,
      // At most legacy fuse-condition evidence; NOT a native handoff proof.
      observedLegacyFuseConditions: !!(parentLocked && childLocked && childEmancipated),
    }
  } catch (error) {
    if (error instanceof EvidenceFailure) throw error
    // viem errors often embed credential-bearing RPC URLs and request bodies.
    throw new EvidenceFailure('rpc-or-contract-error')
  }
}

// Resolve symlinks and spaces correctly; importing in Vitest never runs the CLI.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2)
  const get = (flag) => args[args.indexOf(flag) + 1]
  try {
    if (get('--mode') !== 'legacy-ensv1-sepolia' || args.length !== 10 ||
        !['--mode', '--parent', '--child', '--registry-codehash', '--wrapper-codehash'].every((flag) => args.includes(flag))) {
      throw new EvidenceFailure('usage: --mode legacy-ensv1-sepolia --parent x.eth --child y.x.eth --registry-codehash 0x... --wrapper-codehash 0x...')
    }
    const rpc = process.env.COMETENS_PUBLIC_SEPOLIA_RPC
    const parsed = rpc && new URL(rpc)
    if (!parsed || parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
      throw new EvidenceFailure('public-rpc-required')
    }
    const client = createPublicClient({ chain: sepolia, transport: http(rpc) })
    const result = await auditLegacyEnsV1({ client, parentName: get('--parent'), childName: get('--child'),
      expectedRegistryCodeHash: get('--registry-codehash'), expectedWrapperCodeHash: get('--wrapper-codehash') })
    console.log(JSON.stringify(result, null, 2))
  } catch (error) {
    const code = error instanceof EvidenceFailure ? error.code : 'invalid-public-rpc'
    console.error(`ENSv1 evidence unavailable (${code}); no L1/OP ownership conclusion`)
    process.exitCode = 1
  }
}
