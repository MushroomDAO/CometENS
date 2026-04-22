#!/usr/bin/env node
/**
 * Sync ABI from Foundry build artifacts to contracts/abi/.
 * Run after: forge build
 * Usage:     pnpm abi:sync
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const contracts = [
  { src: 'contracts/out/L2RecordsV2.sol/L2RecordsV2.json', dest: 'contracts/abi/L2RecordsV2.json' },
]

for (const { src, dest } of contracts) {
  const artifact = JSON.parse(readFileSync(resolve(root, src), 'utf8'))
  mkdirSync(dirname(resolve(root, dest)), { recursive: true })
  writeFileSync(resolve(root, dest), JSON.stringify(artifact.abi, null, 2) + '\n')
  console.log(`✓ ${dest}  (${artifact.abi.length} entries)`)
}
