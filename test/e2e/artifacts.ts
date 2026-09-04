import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Abi, Hex } from 'viem'

/**
 * Read a Foundry build artifact, and say what to do when it isn't there.
 *
 * `contracts/out/` is gitignored, so a fresh clone or a new `git worktree` has none of it and
 * the first `pnpm test` fails — six e2e files at once, each with a bare
 * `ENOENT: … contracts/out/L2RecordsV3.sol/L2RecordsV3.json`. Nothing in that message names
 * Foundry, and nothing tells the reader to run `forge build`.
 *
 * CI already knows: its step is literally named "Contracts must compile before the e2e suite
 * deploys them". The knowledge existed and simply never reached anyone working locally.
 *
 * It also self-heals, which is the part that makes it expensive: the failing run itself
 * produces `contracts/out/`, so the second run is green and the evidence — along with the
 * state that caused it — is gone. I diagnosed this three times today before it stuck.
 */
/**
 * The return type is `Abi` / `Hex`, not `unknown[]` / `string`.
 *
 * Before this helper each caller did `JSON.parse(...)`, which is `any` — so `bytecode.object`
 * flowed into viem's `` `0x${string}` `` parameters unchecked. Naming a weaker type here turned
 * that `any` into `string` and surfaced four real mismatches. They were never new bugs; they
 * were what the `any` had been covering.
 */
export function loadArtifact(contractsDir: string, name: string): { abi: Abi; bytecode: { object: Hex } } {
  const path = join(contractsDir, 'out', `${name}.sol`, `${name}.json`)
  if (!existsSync(path)) {
    const outDir = join(contractsDir, 'out')
    throw new Error(
      existsSync(outDir)
        ? `Contract artifact not found: ${name}.\n` +
          `  ${path}\n` +
          `contracts/out/ exists but this contract is not in it — run: cd contracts && forge build`
        : `Contract artifacts have not been built.\n` +
          `  missing: ${outDir}\n` +
          `Run: cd contracts && forge build\n` +
          `(contracts/out/ is gitignored, so a fresh clone or worktree never has it. CI builds ` +
          `first — see the "Contracts must compile before the e2e suite deploys them" step.)`,
    )
  }
  return JSON.parse(readFileSync(path, 'utf8'))
}
