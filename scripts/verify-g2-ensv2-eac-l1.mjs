#!/usr/bin/env node
/** Read-only ETHEREUM MAINNET ENSv2 EAC observation. NEVER an issuance permit or title receipt. */
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { createPublicClient, http, isAddress, keccak256, toHex } from 'viem'
import { mainnet } from 'viem/chains'
import { ABI as REGISTRY_ABI } from './inspect-ensv2-risk.mjs'

// Official https://docs.ens.domains/learn/deployments/ (2026-10-23), MAINNET, not Sepolia.
export const MAINNET_ROOT = '0x2553c09be6447beffdb86fa622ad41fb8f77a91e'
export const MAINNET_ETH = '0xf60aba43e1f7f3dab1186ff03b561401c9df85e2'
const ZERO = '0x0000000000000000000000000000000000000000'
const HEX32 = /^0x[0-9a-fA-F]{64}$/
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const slot = (key) => toHex(BigInt(keccak256(toHex(`eip1967.proxy.${key}`))) - 1n, { size: 32 })
const ADMIN_SLOT = slot('admin')
const BEACON_SLOT = slot('beacon')
const lower = (s) => s?.toLowerCase()
const nonzero = (s) => typeof s === 'string' && isAddress(s) && lower(s) !== ZERO
const role = (index) => 1n << BigInt(index)
export const V2_ROLE = Object.freeze({
  REGISTRAR: role(0), REGISTER_RESERVED: role(4), SET_PARENT: role(8),
  UNREGISTER: role(12), RENEW: role(16), SET_SUBREGISTRY: role(20),
  SET_RESOLVER: role(24), UPGRADE: role(124),
})
const dangerous = [4, 8, 12, 20, 24, 124] // migration, hierarchy, rights, upgrades, incl admins
const count = (bitmap, bit) => Number((bitmap >> BigInt(bit)) & 15n)
const hasDanger = (bitmap) => !!count(bitmap, 128) || !!count(bitmap, 28 + 128) ||
  dangerous.some(bit => count(bitmap, bit) || count(bitmap, bit + 128))
const ABI = [
  ...REGISTRY_ABI,
  { type: 'function', name: 'ownerOf', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'hasRootRoles', stateMutability: 'view',
    inputs: [{ type: 'uint256' }, { type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'hasRoles', stateMutability: 'view',
    inputs: [{ type: 'uint256' }, { type: 'uint256' }, { type: 'address' }], outputs: [{ type: 'bool' }] },
]
const deny = (reason) => ({ verdict: 'DENY', reason, authorizedAtSnapshot: false,
  canExecuteNativeIssue: false, sovereignReceipt: false })

/**
 * Checks only a direct, lowercase ASCII *.eth parent and its current subregistry.
 * A *latest-block* read is a point-in-time observation, never an atomic L1 action.
 * No operator/bridge/relayer can convert this into a future authorization.
 */
export async function verifyCurrentEnsv2Eac({ client, manifest }) {
  if (!manifest || Object.keys(manifest).some(k => !['parentName', 'holder', 'actor', 'pins'].includes(k)) ||
      typeof manifest.parentName !== 'string' ||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.eth$/.test(manifest.parentName) ||
      manifest.parentName.split('.')[0].slice(2, 4) === '--' ||
      !nonzero(manifest.holder) || !nonzero(manifest.actor) ||
      !Array.isArray(manifest.pins) || manifest.pins.length !== 3 ||
      manifest.pins.some(p => !p || !nonzero(p.address) || !HEX32.test(p.codeHash) ||
        Object.keys(p).some(k => !['address', 'codeHash', 'implementation'].includes(k)) ||
        (p.implementation !== undefined && (!p.implementation ||
          !nonzero(p.implementation.address) || !HEX32.test(p.implementation.codeHash) ||
          Object.keys(p.implementation).some(k => !['address', 'codeHash'].includes(k)))))) {
    return deny('INVALID_MANIFEST')
  }
  const pins = new Map(manifest.pins.map(p => [lower(p.address), p]))
  if (pins.size !== 3 || !pins.has(MAINNET_ROOT) || !pins.has(MAINNET_ETH)) return deny('MISSING_OR_DUPLICATE_PIN')
  if (lower(manifest.actor) !== lower(manifest.holder)) return deny('ACTOR_NOT_NATIVE_HOLDER')
  try {
    if (await client.getChainId() !== 1) return deny('WRONG_CHAIN')
    const block = await client.getBlock({ blockTag: 'latest' })
    if (typeof block?.number !== 'bigint' || typeof block.timestamp !== 'bigint' || !HEX32.test(block.hash ?? '')) {
      return deny('UNVERIFIABLE_HEAD')
    }
    const wall = BigInt(Math.floor(Date.now() / 1000))
    if (block.timestamp > wall + 120n || wall - block.timestamp > 120n) return deny('STALE_HEAD')
    const at = block.number
    const read = (address, functionName, args = []) =>
      client.readContract({ address, abi: ABI, functionName, args, blockNumber: at })
    const pinRuntime = async (address) => {
      const pin = pins.get(lower(address))
      if (!pin) return false
      const code = await client.getBytecode({ address, blockNumber: at })
      if (!code || code === '0x' || lower(keccak256(code)) !== lower(pin.codeHash)) return false
      const [impl, admin, beacon] = await Promise.all([IMPL_SLOT, ADMIN_SLOT, BEACON_SLOT].map(s =>
        client.getStorageAt({ address, slot: s, blockNumber: at })))
      if (![impl, admin, beacon].every(s => HEX32.test(s ?? '')) ||
          lower(admin.slice(-40)) !== ZERO.slice(2) || lower(beacon.slice(-40)) !== ZERO.slice(2)) return false
      const implAddress = `0x${impl.slice(-40)}`
      if (lower(implAddress) === ZERO) return !pin.implementation
      if (!pin.implementation || lower(pin.implementation.address) !== lower(implAddress)) return false
      const implCode = await client.getBytecode({ address: implAddress, blockNumber: at })
      return !!implCode && lower(keccak256(implCode)) === lower(pin.implementation.codeHash)
    }

    if (!(await pinRuntime(MAINNET_ROOT)) || !(await pinRuntime(MAINNET_ETH))) return deny('UNPINNED_ROOT_OR_ETH')
    const [ethForward, ethBackward] = await Promise.all([
      read(MAINNET_ROOT, 'getSubregistry', ['eth']), read(MAINNET_ETH, 'getParent'),
    ])
    if (lower(ethForward) !== MAINNET_ETH || !Array.isArray(ethBackward) ||
        lower(ethBackward[0]) !== MAINNET_ROOT || ethBackward[1] !== 'eth') return deny('ETH_HIERARCHY_MISMATCH')

    const label = manifest.parentName.split('.')[0]
    const labelId = BigInt(keccak256(toHex(label)))
    const [state, resource, child, ethRootCounts, rootRootCounts] = await Promise.all([
      read(MAINNET_ETH, 'getState', [labelId]), read(MAINNET_ETH, 'getResource', [labelId]),
      read(MAINNET_ETH, 'getSubregistry', [label]), read(MAINNET_ETH, 'roleCount', [0n]),
      read(MAINNET_ROOT, 'roleCount', [0n]),
    ])
    if (typeof state?.status !== 'number' || state.status !== 2 ||
        typeof state.expiry !== 'bigint' || state.expiry <= block.timestamp + 86400n ||
        typeof state.resource !== 'bigint' || typeof state.tokenId !== 'bigint' ||
        state.resource === 0n || resource !== state.resource ||
        lower(state.latestOwner) !== lower(manifest.holder)) return deny('PARENT_INACTIVE_OR_MIGRATED')
    if (!nonzero(child) || lower(child) === MAINNET_ETH || lower(child) === MAINNET_ROOT ||
        !pins.has(lower(child)) || !(await pinRuntime(child))) return deny('UNTRUSTED_SUBREGISTRY')
    const [parentHolder, childParent, childRootCounts, parentScopedCounts, childRootRoles, childRegistrar,
      parentRoles, parentCanSwap, parentApproval] = await Promise.all([
      read(MAINNET_ETH, 'ownerOf', [state.tokenId]), read(child, 'getParent'),
      read(child, 'roleCount', [0n]), read(MAINNET_ETH, 'roleCount', [state.resource]),
      read(child, 'roles', [0n, manifest.actor]),
      read(child, 'hasRootRoles', [V2_ROLE.REGISTRAR, manifest.actor]),
      read(MAINNET_ETH, 'roles', [state.resource, manifest.actor]),
      read(MAINNET_ETH, 'hasRoles', [state.resource, V2_ROLE.SET_SUBREGISTRY, manifest.actor]),
      read(MAINNET_ETH, 'isApprovedForAll', [manifest.holder, manifest.actor]),
    ])
    if (lower(parentHolder) !== lower(manifest.holder) || !Array.isArray(childParent) ||
        lower(childParent[0]) !== MAINNET_ETH || childParent[1] !== label) return deny('PARENT_OWNER_OR_POINTER_CHANGED')
    if ([childRootCounts, ethRootCounts, rootRootCounts, parentScopedCounts, childRootRoles, parentRoles]
      .some(x => typeof x !== 'bigint') || typeof childRegistrar !== 'boolean' ||
      typeof parentCanSwap !== 'boolean' || typeof parentApproval !== 'boolean') return deny('INVALID_EAC_READ')
    // ROOT roles are not equivalent to resource-scoped roles. Registrar MUST be ROOT;
    // admin alone cannot mint. A parent set-subregistry grant cannot mint either.
    if (!childRegistrar || (childRootRoles & V2_ROLE.REGISTRAR) === 0n) return deny('NO_CURRENT_ROOT_REGISTRAR')
    // Scoped parent rights are distinct from child ROOT issuance rights; an
    // additional parent pointer setter or unregister role is an unsafe bypass.
    if (hasDanger(rootRootCounts) || hasDanger(ethRootCounts) || hasDanger(childRootCounts) ||
        count(parentScopedCounts, 12) || count(parentScopedCounts, 12 + 128) ||
        count(parentScopedCounts, 20) > 1 || count(parentScopedCounts, 20 + 128) > 1 ||
        (count(parentScopedCounts, 20) === 1 && (parentRoles & V2_ROLE.SET_SUBREGISTRY) === 0n) ||
        (count(parentScopedCounts, 20 + 128) === 1 &&
          (parentRoles & (V2_ROLE.SET_SUBREGISTRY << 128n)) === 0n) ||
        count(childRootCounts, 0) !== 1) {
      return deny('ROOT_ADMIN_OR_MIGRATION_REGRANT_PATH')
    }
    const verifiedBlock = await client.getBlock({ blockNumber: at })
    if (lower(verifiedBlock?.hash) !== lower(block.hash)) return deny('HEAD_REORGED')
    return {
      verdict: 'OBSERVED_EAC_ONLY', reason: 'L1_TX_RECHECK_AND_LAUNCH_REQUIRED',
      authorizedAtSnapshot: true, canExecuteNativeIssue: false, sovereignReceipt: false,
      snapshot: { chainId: 1, number: at.toString(), hash: block.hash, timestamp: block.timestamp.toString() },
      parentName: manifest.parentName, nativeHolder: parentHolder, subregistry: child,
      registrarRootRole: true, parentCanSetSubregistry: parentCanSwap,
      parentRoleBitmap: parentRoles.toString(), selfApproval: parentApproval,
      completeAdminEnumeration: false, verifiedLiveTransaction: false,
    }
  } catch {
    return deny('RPC_OR_ABI_UNVERIFIABLE') // avoid leaking transport URLs, headers or secrets
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const filename = process.argv[2]
    const rpc = process.env.COMETENS_MAINNET_RPC_URL
    if (!filename || process.argv.length !== 3 || !rpc || !/^https:\/\//.test(rpc) ||
        new URL(rpc).username || new URL(rpc).password) throw new Error('invalid input')
    const bytes = await readFile(filename)
    if (bytes.length > 16384) throw new Error('oversize')
    const result = await verifyCurrentEnsv2Eac({
      client: createPublicClient({ chain: mainnet, transport: http(rpc) }),
      manifest: JSON.parse(bytes.toString()),
    })
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    if (result.verdict !== 'OBSERVED_EAC_ONLY') process.exitCode = 2
  } catch {
    process.stderr.write('ENSv2 L1 EAC: DENY (invalid config or RPC). No transaction sent.\n')
    process.exitCode = 2
  }
}
