import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { liveTestOptIn } from '../integration/live-opt-in'

const configured = {
  OP_SEPOLIA_RPC_URL: 'https://testnet.example',
  PRIVATE_KEY_JASON: 'test-only-placeholder',
  COMETENS_LIVE_READ_TESTS: undefined,
  COMETENS_LIVE_WRITE_TESTS: undefined,
}

describe('live Sepolia tests require deliberate opt-in', () => {
  it('does not enable writes just because RPC and account secrets are present', () => {
    expect(liveTestOptIn(configured)).toEqual({ reads: false, writes: false })
  })

  it('read opt-in permits only read-only suites', () => {
    expect(liveTestOptIn({ ...configured, COMETENS_LIVE_READ_TESTS: '1' }))
      .toEqual({ reads: true, writes: false })
  })

  it('write opt-in alone never permits signing/broadcasting transactions', () => {
    expect(liveTestOptIn({ ...configured, COMETENS_LIVE_WRITE_TESTS: '1' }))
      .toEqual({ reads: false, writes: false })
  })

  it('requires both exact flags to permit testnet writes', () => {
    expect(liveTestOptIn({ ...configured, COMETENS_LIVE_READ_TESTS: '1', COMETENS_LIVE_WRITE_TESTS: '1' }))
      .toEqual({ reads: true, writes: true })
    expect(liveTestOptIn({ ...configured, COMETENS_LIVE_READ_TESTS: 'true', COMETENS_LIVE_WRITE_TESTS: 'true' }))
      .toEqual({ reads: false, writes: false })
  })

  it('wires every deployed-network test suite to the correct opt-in guard', () => {
    // Inspect executable TypeScript nodes, not comments or text that could
    // mention LIVE_WRITES while silently removing the actual skip condition.
    const filename = new URL('../integration/deployed.test.ts', import.meta.url)
    const ast = ts.createSourceFile('deployed.test.ts', readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true)
    const guards = new Map<string, ts.Expression>()
    const suites = new Map<string, ts.Expression>()
    let optInBinding = false

    for (const statement of ast.statements) {
      if (ts.isVariableStatement(statement)) {
        for (const decl of statement.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && decl.initializer) guards.set(decl.name.text, decl.initializer)
          if (ts.isObjectBindingPattern(decl.name) && decl.initializer &&
              ts.isCallExpression(decl.initializer) && ts.isIdentifier(decl.initializer.expression) &&
              decl.initializer.expression.text === 'liveTestOptIn') {
            const names = decl.name.elements.map((element) => [element.propertyName?.getText(ast), element.name.getText(ast)])
            optInBinding = names.some(([from, to]) => from === 'reads' && to === 'LIVE_READS') &&
              names.some(([from, to]) => from === 'writes' && to === 'LIVE_WRITES')
          }
        }
      }
      if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue
      const suiteCall = statement.expression
      const skipCall = suiteCall.expression
      if (!ts.isCallExpression(skipCall) || !ts.isPropertyAccessExpression(skipCall.expression) ||
          !ts.isIdentifier(skipCall.expression.expression) || skipCall.expression.expression.text !== 'describe') {
        // A new unguarded top-level `describe(...)` must not silently appear.
        expect(suiteCall.expression.getText(ast).startsWith('describe')).toBe(false)
        continue
      }
      expect(skipCall.expression.name.text).toBe('skipIf')
      expect(skipCall.arguments).toHaveLength(1)
      const title = suiteCall.arguments[0]
      expect(title && ts.isStringLiteral(title)).toBe(true)
      if (title && ts.isStringLiteral(title)) suites.set(title.text, skipCall.arguments[0])
    }

    expect(optInBinding).toBe(true)
    expect([...suites.keys()].sort()).toEqual([
      'Integration: L2Records on OP Sepolia',
      'Integration: OffchainResolver on Sepolia',
      'Integration: aastar.eth CCIP-Read flow',
      'Integration: forest.aastar.eth setup',
    ].sort())

    const protectedBy = (expression: ts.Expression | undefined, flag: string) => {
      if (expression && ts.isIdentifier(expression)) expression = guards.get(expression.text)
      if (!expression || !ts.isBinaryExpression(expression) ||
          expression.operatorToken.kind !== ts.SyntaxKind.BarBarToken) return false
      // OR is left-associative: the first negative opt-in must guard *every*
      // alternative, not merely occur somewhere in the expression.
      let first: ts.Expression = expression.left
      while (ts.isBinaryExpression(first) && first.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
        first = first.left
      }
      return ts.isPrefixUnaryExpression(first) && first.operator === ts.SyntaxKind.ExclamationToken &&
        ts.isIdentifier(first.operand) && first.operand.text === flag
    }
    for (const [name, expression] of suites) {
      const writeSuite = name.includes('L2Records') || name.includes('CCIP-Read')
      expect(protectedBy(expression, writeSuite ? 'LIVE_WRITES' : 'LIVE_READS'), name).toBe(true)
    }
  })
})
