#!/usr/bin/env node
// G2.5 OP application-only inspector. No wallet, transaction signing or broadcasting.
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { createPublicClient, http } from 'viem'
import { optimismSepolia } from 'viem/chains'

const USAGE = `Usage: pnpm controller:v4 -- <command> --profile ./v4-profile.json [options]
Commands:
  status [--operator 0xADDRESS]
  receipt --hash 0xTXHASH
  prepare-grant --from 0xCONTROLLER --operator 0xADDRESS --permissions 1|3 --quota N --expires-at UNIX
  prepare-revoke --from 0xCONTROLLER --operator 0xADDRESS
  prepare-rotate --from 0xCONTROLLER --operator 0xOLD --next 0xNEW --permissions 1|3 --quota N --expires-at UNIX
  prepare-propose --from 0xCONTROLLER --next 0xNEW
  prepare-accept --from 0xPENDING
Provide OP Sepolia RPC using COMETENS_OP_RPC_URL (environment only, never echoed).
Profile JSON: {"parentName":"community.eth","chainId":11155420,"contract":"0x...","expectedCodeHash":"0x..."}
Output is OP application status or unsigned calldata/receipt, never L1 ENS sovereignty.`

const COMMAND_FLAGS = {
  status: ['operator'], receipt: ['hash'],
  'prepare-grant': ['from', 'operator', 'permissions', 'quota', 'expires-at'],
  'prepare-revoke': ['from', 'operator'],
  'prepare-rotate': ['from', 'operator', 'next', 'permissions', 'quota', 'expires-at'],
  'prepare-propose': ['from', 'next'],
  'prepare-accept': ['from'],
}

/** Strict argument parser: no unexpected keys, unknown flags or duplicate flags. */
export function parseV4Args(args) {
  const [command, ...rest] = args[0] === '--' ? args.slice(1) : args
  if (!Object.hasOwn(COMMAND_FLAGS, command)) throw new Error('invalid command')
  if (rest.length % 2 !== 0) throw new Error('expected flag/value pairs')
  const flags = {}
  for (let i = 0; i < rest.length; i += 2) {
    const option = rest[i]
    if (!/^--[a-z-]+$/.test(option) || ![...COMMAND_FLAGS[command], 'profile'].includes(option.slice(2)) ||
        Object.hasOwn(flags, option.slice(2)) || !rest[i + 1] || rest[i + 1].startsWith('--')) {
      throw new Error('invalid option')
    }
    flags[option.slice(2)] = rest[i + 1]
  }
  if (!flags.profile) throw new Error('missing profile')
  for (const flag of COMMAND_FLAGS[command]) {
    if (command === 'status' && flag === 'operator') continue
    if (!flags[flag]) throw new Error('missing required option')
  }
  return { command, flags }
}

const bigint = (value) => {
  if (!/^(0|[1-9][0-9]*)$/.test(value ?? '')) throw new Error('expected unsigned integer')
  return BigInt(value)
}
const output = (object) => JSON.stringify(object, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2)

export async function runV4Cli(args, options = {}) {
  const { V4ControllerAdapter } = options.adapterClass
    ? { V4ControllerAdapter: options.adapterClass } : await import('../sdk/dist/v4.js')
  const { command, flags } = parseV4Args(args)
  const rpcUrl = options.rpcUrl ?? process.env.COMETENS_OP_RPC_URL
  if (!rpcUrl) throw new Error('missing RPC')
  const url = new URL(rpcUrl)
  if (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('invalid RPC')
  }
  const raw = await readFile(flags.profile)
  if (raw.byteLength > 8192) throw new Error('profile too large')
  const profile = JSON.parse(raw.toString())
  const client = options.client ?? createPublicClient({ chain: optimismSepolia, transport: http(rpcUrl) })
  const adapter = new V4ControllerAdapter(profile, client)
  const from = flags.from
  let result
  switch (command) {
    case 'status':
      result = { controller: await adapter.getControllerStatus(),
        ...(flags.operator && { operator: await adapter.getOperator(flags.operator) }),
        consistency: 'independent latest-block RPC reads' }
      break
    case 'receipt':
      result = { receipt: await adapter.getReceipt(flags.hash), meaning: 'Mined OP transaction only; query status to confirm effect' }
      break
    case 'prepare-grant':
      result = await adapter.prepareGrant(from, flags.operator, bigint(flags.permissions), bigint(flags.quota), bigint(flags['expires-at']))
      break
    case 'prepare-revoke':
      result = await adapter.prepareRevoke(from, flags.operator)
      break
    case 'prepare-rotate':
      result = await adapter.prepareRotate(from, flags.operator, flags.next, bigint(flags.permissions), bigint(flags.quota), bigint(flags['expires-at']))
      break
    case 'prepare-propose':
      result = await adapter.prepareControllerHandoff(from, flags.next)
      break
    case 'prepare-accept':
      result = await adapter.prepareAcceptController(from)
      break
  }
  return output({ kind: command, result, signed: false, broadcast: false,
    caveat: 'OP application-only; L1 ENS/NameWrapper ownership not verified' })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--help') || process.argv.length <= 2) {
    process.stdout.write(USAGE + '\n')
  } else {
    runV4Cli(process.argv.slice(2)).then((value) => {
      process.stdout.write(value + '\n')
    }).catch((error) => {
      // Never echo file path, profile, RPC URL or upstream exception text.
      const kind = typeof error?.kind === 'string' ? error.kind : 'invalid-input-or-unavailable'
      process.stderr.write(`V4 CLI failed (${kind}); see --help.\n`)
      process.exitCode = 1
    })
  }
}
