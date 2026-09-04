import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadArtifact } from '../e2e/artifacts'

/**
 * The two failure messages, pinned.
 *
 * This whole change is the WORDING of two error paths — and nothing drove either of them:
 * `grep -rl loadArtifact test/unit/` was 0. Someone could swap the two messages, or delete the
 * `forge build` line, and no test would go red. The value of the change and the coverage of the
 * change had no overlap at all.
 *
 * Runs against temp directories, so it needs neither Foundry nor the e2e environment.
 */
const withTemp = <T>(fn: (dir: string) => T): T => {
  const dir = mkdtempSync(join(tmpdir(), 'artifact-msg-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('loadArtifact — what it says when the artifact is not there', () => {
  it('no out/ at all: names Foundry, the command, and why it is absent', () => {
    withTemp((dir) => {
      const e = (() => {
        try {
          loadArtifact(dir, 'L2RecordsV3')
        } catch (err) {
          return err as Error
        }
        throw new Error('should have thrown')
      })()
      expect(e.message).toContain('have not been built')
      expect(e.message).toContain('forge build')
      expect(e.message).toContain('gitignored')
    })
  })

  it('out/ exists but this contract is missing: says THAT, not the other thing', () => {
    withTemp((dir) => {
      mkdirSync(join(dir, 'out'), { recursive: true })
      const e = (() => {
        try {
          loadArtifact(dir, 'L2RecordsV3')
        } catch (err) {
          return err as Error
        }
        throw new Error('should have thrown')
      })()
      expect(e.message).toContain('exists but this contract is not in it')
      expect(e.message).toContain('forge build')
    })
  })

  // THE CONTROL that makes the two above mean something: they must not be the same message.
  // Without it, one message used for both cases would satisfy every `toContain` that overlaps.
  it('the two messages are different (control)', () => {
    withTemp((dir) => {
      const a = (() => {
        try {
          loadArtifact(dir, 'X')
        } catch (e) {
          return (e as Error).message
        }
        return ''
      })()
      mkdirSync(join(dir, 'out'), { recursive: true })
      const b = (() => {
        try {
          loadArtifact(dir, 'X')
        } catch (e) {
          return (e as Error).message
        }
        return ''
      })()
      expect(a).not.toBe(b)
      expect(a).toBeTruthy()
      expect(b).toBeTruthy()
    })
  })

  it('returns the artifact when it IS there (must-pass control)', () => {
    // Without this, a loadArtifact that threw unconditionally would pass everything above.
    withTemp((dir) => {
      mkdirSync(join(dir, 'out', 'X.sol'), { recursive: true })
      writeFileSync(join(dir, 'out', 'X.sol', 'X.json'), JSON.stringify({ abi: [], bytecode: { object: '0x00' } }))
      expect(loadArtifact(dir, 'X').bytecode.object).toBe('0x00')
    })
  })
})
