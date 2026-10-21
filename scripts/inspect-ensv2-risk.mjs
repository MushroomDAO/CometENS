#!/usr/bin/env node
/** Read-only ENSv2 Sepolia authority sampling. NEVER an ENS title receipt. */
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { createPublicClient, http, isAddress, keccak256, toHex } from 'viem'
import { sepolia } from 'viem/chains'

// https://docs.ens.domains/learn/deployments/ (2026-10-21).
// Older July and September contracts-v2 deployment tables are DIFFERENT deployments.
export const ROOT = '0xb458d6a3a77919449d03e7a6903c26827c1ec43f'
export const ETH = '0xd4ebcbbdf463c9c45784603db0ddd499bc44a8b4'
const ZERO = '0x0000000000000000000000000000000000000000'
const SLOT_IMPL = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
const proxySlot = (name) => toHex(BigInt(keccak256(toHex(`eip1967.proxy.${name}`))) - 1n, { size: 32 })
const ADMIN_SLOT = proxySlot('admin')
const BEACON_SLOT = proxySlot('beacon')
const HEX32 = /^0x[0-9a-fA-F]{64}$/
const lower = (x) => x?.toLowerCase()
const address = (x) => typeof x === 'string' && isAddress(x)
const validName = (x) => typeof x === 'string' && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*eth$/.test(x) &&
  x.split('.').every(v => !(v.length >= 4 && v[2] === '-' && v[3] === '-'))
const fn = (name, inputs, outputs) => ({ type: 'function', name, stateMutability: 'view',
  inputs: inputs.map(type => ({ type })), outputs: outputs.map(type => ({ type })) })
// Function signatures cross-checked against ensdomains/contracts-v2
// tag sepolia-deployment-2026-09-15 (f2f0a05e), and current ENS docs.
export const ABI = [
  fn('getSubregistry', ['string'], ['address']),
  fn('getParent', [], ['address', 'string']),
  fn('getState', ['uint256'], ['tuple']),
  fn('getResource', ['uint256'], ['uint256']),
  fn('roleCount', ['uint256'], ['uint256']),
  fn('roles', ['uint256', 'address'], ['uint256']),
  fn('isEmancipated', [], ['bool']),
  fn('isApprovedForAll', ['address', 'address'], ['bool']),
]
// A concrete ABI tuple is required for viem, not an inferred response.
ABI[2].outputs[0].components = [
  { name: 'status', type: 'uint8' }, { name: 'expiry', type: 'uint64' },
  { name: 'latestOwner', type: 'address' }, { name: 'tokenId', type: 'uint256' },
  { name: 'resource', type: 'uint256' },
]
const ROLES = {
  REGISTRAR: 0n, REGISTER_RESERVED: 4n,
  SET_PARENT: 8n, UNREGISTER: 12n, RENEW: 16n,
  SET_SUBREGISTRY: 20n, SET_RESOLVER: 24n, CAN_TRANSFER: 28n,
  SET_URI: 36n, CAN_NAME: 120n, UPGRADE: 124n,
}
const dangerous = ['SET_PARENT', 'UNREGISTER', 'SET_SUBREGISTRY', 'SET_RESOLVER', 'UPGRADE']
const count = (bitmap, shift) => Number((bitmap >> shift) & 15n)
const roleCounts = (bitmap) => Object.fromEntries(Object.entries(ROLES).map(([name, shift]) =>
  [name, { regular: count(bitmap, shift), admin: count(bitmap, shift + 128n) }]))
const problem = (code, context = '') => ({ code, context })
const fail = (reason) => ({ verdict: 'NEEDS_REVIEW', sovereignReceipt: false,
  evidenceLevel: 'FINALIZED_RPC_OBSERVATION_ONLY', findings: [problem(reason)] })

/** Every chain read uses the SAME finalized block number, including code and storage. */
export async function inspectEnsv2({ client, manifest }) {
  if (!manifest || manifest.chainId !== 11155111 || !validName(manifest.name) ||
      lower(manifest.rootRegistry) !== ROOT || lower(manifest.ethRegistry) !== ETH ||
      Object.keys(manifest).some(k => !['chainId', 'name', 'rootRegistry', 'ethRegistry', 'pins', 'operators'].includes(k)) ||
      !Array.isArray(manifest.pins) || manifest.pins.length > 32 ||
      !Array.isArray(manifest.operators) || manifest.operators.length > 32 ||
      manifest.operators.some(x => !address(x)) ||
      manifest.pins.some(p => !p || !address(p.address) || !HEX32.test(p.codeHash) ||
        Object.keys(p).some(k => !['address', 'codeHash', 'implementation'].includes(k)) ||
        (p.implementation !== undefined && (!p.implementation ||
          Object.keys(p.implementation).some(k => !['address', 'codeHash'].includes(k)) ||
          !address(p.implementation.address) || !HEX32.test(p.implementation.codeHash))))) {
    return fail('INVALID_MANIFEST')
  }
  const pins = new Map(manifest.pins.map(p => [lower(p.address), p]))
  if (pins.size !== manifest.pins.length) return fail('DUPLICATE_PIN')
  const findings = [problem('APPROVAL_ENUMERATION_INCOMPLETE'),
    problem('L1_RPC_NOT_CONSENSUS_PROOF'), problem('UPGRADE_GOVERNANCE_NOT_EXHAUSTIVE')]
  const registries = []
  try {
    if (await client.getChainId() !== 11155111) return fail('WRONG_CHAIN')
    const block = await client.getBlock({ blockTag: 'finalized' })
    if (typeof block.number !== 'bigint' || typeof block.timestamp !== 'bigint' || !HEX32.test(block.hash ?? '')) {
      return fail('FINALIZED_BLOCK_UNAVAILABLE')
    }
    const now = BigInt(Math.floor(Date.now() / 1000))
    if (block.timestamp > now + 120n || block.timestamp + 7200n < now) return fail('STALE_FINALITY')
    const at = block.number
    const read = (addr, name, args = []) =>
      client.readContract({ address: addr, abi: ABI, functionName: name, args, blockNumber: at })
    const pinCode = async (addr) => {
      const pin = pins.get(lower(addr))
      if (!pin) { findings.push(problem('MISSING_REGISTRY_PIN', addr)); return false }
      const code = await client.getBytecode({ address: addr, blockNumber: at })
      if (!code || code === '0x' || lower(keccak256(code)) !== lower(pin.codeHash)) {
        findings.push(problem('RUNTIME_CODEHASH_MISMATCH', addr)); return false
      }
      const raw = await client.getStorageAt({ address: addr, slot: SLOT_IMPL, blockNumber: at })
      if (!HEX32.test(raw ?? '')) { findings.push(problem('IMPLEMENTATION_SLOT_UNKNOWN', addr)); return false }
      for (const [slot, name] of [[ADMIN_SLOT, 'PROXY_ADMIN_PRESENT'], [BEACON_SLOT, 'PROXY_BEACON_PRESENT']]) {
        const value = await client.getStorageAt({ address: addr, slot, blockNumber: at })
        if (!HEX32.test(value ?? '')) { findings.push(problem('PROXY_CONTROL_SLOT_UNKNOWN', addr)); return false }
        if (lower(value.slice(-40)) !== ZERO.slice(2)) findings.push(problem(name, addr))
      }
      const implementation = ('0x' + raw.slice(-40))
      if (lower(implementation) !== ZERO) {
        if (!pin.implementation || lower(pin.implementation.address) !== lower(implementation)) {
          findings.push(problem('UNPINNED_PROXY_IMPLEMENTATION', addr)); return false
        }
        const implementationCode = await client.getBytecode({ address: implementation, blockNumber: at })
        if (!implementationCode || lower(keccak256(implementationCode)) !== lower(pin.implementation.codeHash)) {
          findings.push(problem('IMPLEMENTATION_CODEHASH_MISMATCH', addr)); return false
        }
      }
      return true
    }

    let current = ROOT
    const labels = manifest.name.split('.').reverse()
    for (let i = 0; i < labels.length; i++) {
      if (!(await pinCode(current))) break
      const label = labels[i]
      const id = BigInt(keccak256(toHex(label)))
      const [state, rootCount, resource, emancipated] = await Promise.all([
        read(current, 'getState', [id]), read(current, 'roleCount', [0n]),
        read(current, 'getResource', [id]), read(current, 'isEmancipated'),
      ])
      if (typeof resource !== 'bigint' || typeof rootCount !== 'bigint' ||
          typeof state?.expiry !== 'bigint' || typeof state?.status !== 'number' ||
          state.status < 0 || state.status > 2 || typeof state.resource !== 'bigint' ||
          state.resource !== resource || typeof state.tokenId !== 'bigint' ||
          !address(state?.latestOwner) || typeof emancipated !== 'boolean') {
        findings.push(problem('INVALID_REGISTRY_ABI', current)); break
      }
      const nameCount = await read(current, 'roleCount', [resource])
      if (typeof nameCount !== 'bigint') { findings.push(problem('INVALID_ROLE_COUNT', current)); break }
      const rootRoles = roleCounts(rootCount)
      const scopedRoles = roleCounts(nameCount)
      for (const role of dangerous) {
        if (rootRoles[role].regular || rootRoles[role].admin) {
          findings.push(problem('DANGEROUS_ROOT_ROLE', `${current}:${role}`))
        }
      }
      for (const role of ['UNREGISTER', 'RENEW', 'SET_SUBREGISTRY', 'SET_RESOLVER']) {
        if (scopedRoles[role].regular || scopedRoles[role].admin) {
          findings.push(problem('SCOPED_ROLE_ASSIGNEES_PRESENT', `${current}:${role}`))
        }
      }
      if (!emancipated) findings.push(problem('REGISTRY_NOT_EMANCIPATED', current))
      if (state.status !== 2 || state.expiry <= now) findings.push(problem('NAME_NOT_ACTIVE', label))
      if (state.status === 2 && lower(state.latestOwner) === ZERO) {
        findings.push(problem('REGISTERED_OWNER_MISSING', label))
      }
      const approvals = []
      if (lower(state.latestOwner) !== ZERO) {
        const bitmap = await read(current, 'roles', [resource, state.latestOwner])
        if (typeof bitmap !== 'bigint') { findings.push(problem('INVALID_OWNER_ROLES', label)); break }
        for (const op of manifest.operators) {
          const [approved, delegated] = await Promise.all([
            read(current, 'isApprovedForAll', [state.latestOwner, op]), read(current, 'roles', [resource, op]),
          ])
          if (typeof approved !== 'boolean' || typeof delegated !== 'bigint') {
            findings.push(problem('INVALID_APPROVAL_OR_ROLES', op)); break
          }
          approvals.push({ operator: op, approved, effectiveRoles: delegated.toString() })
          if (approved) findings.push(problem('INHERITED_ERC1155_APPROVAL', op))
          if (delegated !== 0n) findings.push(problem('THIRD_PARTY_EAC_ROLES', op))
        }
      }
      registries.push({ registry: current, label, owner: state.latestOwner,
        status: state.status, expiry: state.expiry.toString(), resource: resource.toString(),
        rootRoles, scopedRoles, approvals, emancipated })
      if (i === labels.length - 1) break
      const child = await read(current, 'getSubregistry', [label])
      if (!address(child) || lower(child) === ZERO) {
        findings.push(problem('MISSING_SUBREGISTRY', label)); break
      }
      if (i === 0 && lower(child) !== ETH) {
        findings.push(problem('OFFICIAL_ETH_REGISTRY_MISMATCH', child)); break
      }
      if (!(await pinCode(child))) break
      const parent = await read(child, 'getParent')
      if (!Array.isArray(parent) || lower(parent[0]) !== lower(current) || parent[1] !== label) {
        findings.push(problem('NONCANONICAL_PARENT_LINK', child)); break
      }
      current = child
    }
    return {
      verdict: 'NEEDS_REVIEW', sovereignReceipt: false,
      evidenceLevel: 'FINALIZED_RPC_OBSERVATION_ONLY', chainId: 11155111,
      finalized: { number: at.toString(), hash: block.hash, timestamp: block.timestamp.toString() },
      name: manifest.name, visited: registries, findings,
      checkedAllAncestry: registries.length === labels.length,
      checkedAllApprovals: false, checkedAllRoleAssignees: false,
    }
  } catch {
    // viem often embeds confidential RPC URLs and request bodies.
    return { ...fail('RPC_OR_ABI_UNVERIFIABLE'), registriesObserved: registries.length }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const filename = process.argv[2]
    const rpc = process.env.COMETENS_SEPOLIA_RPC_URL
    if (!filename || !rpc || !/^https:\/\//.test(rpc) || new URL(rpc).username ||
        process.argv.length !== 3) throw new Error('invalid input')
    const content = await readFile(filename)
    if (content.length > 16384) throw new Error('large manifest')
    const manifest = JSON.parse(content.toString())
    const result = await inspectEnsv2({ manifest, client: createPublicClient({ chain: sepolia, transport: http(rpc) }) })
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    if (!result.checkedAllAncestry) process.exitCode = 2
  } catch {
    process.stderr.write('ENSv2 inspector: NEEDS_REVIEW (invalid config or RPC); no transaction sent.\n')
    process.exitCode = 2
  }
}
