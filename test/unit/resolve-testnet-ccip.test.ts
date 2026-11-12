import { describe, expect, it } from 'vitest'
import { encodeErrorResult, getAddress, type Hex } from 'viem'
import {
  OFFCHAIN_LOOKUP_ABI,
  decodeOffchainLookup,
  gatewayHexFromHttp,
  parseOffchainLookupArgs,
  rpcResultFromJson,
} from '../../scripts/resolve-testnet'

const SENDER = getAddress('0x1111111111111111111111111111111111111111')
const URLS = ['https://gateway.example/ccip']
const CALL_DATA = '0xabcdef'
const CALLBACK = '0x556f1830'
const EXTRA = '0x'

const VALID_ARGS = [SENDER, URLS, CALL_DATA, CALLBACK, EXTRA]

describe('parseOffchainLookupArgs', () => {
  it('accepts a 5-field OffchainLookup argument list', () => {
    expect(parseOffchainLookupArgs(VALID_ARGS)).toEqual({
      sender: SENDER,
      urls: URLS,
      callData: CALL_DATA,
      callbackFunction: CALLBACK,
      extraData: EXTRA,
    })
  })

  it('accepts args produced by decodeErrorResult', () => {
    const revertData = encodeErrorResult({
      abi: OFFCHAIN_LOOKUP_ABI,
      errorName: 'OffchainLookup',
      args: [SENDER, URLS, CALL_DATA, CALLBACK, EXTRA],
    })
    expect(decodeOffchainLookup(revertData)).toMatchObject({
      sender: SENDER,
      urls: URLS,
      callData: CALL_DATA,
      callbackFunction: CALLBACK,
      extraData: EXTRA,
    })
  })

  it('fails closed on truncated args', () => {
    expect(() => parseOffchainLookupArgs(undefined)).toThrow('truncated OffchainLookup args')
    expect(() => parseOffchainLookupArgs([])).toThrow('truncated OffchainLookup args')
    expect(() => parseOffchainLookupArgs(VALID_ARGS.slice(0, 4))).toThrow('truncated OffchainLookup args')
    expect(() => parseOffchainLookupArgs('0x556f1830')).toThrow('truncated OffchainLookup args')
  })

  it('fails closed on wrong types', () => {
    const cases: unknown[] = [
      ['0x1234', URLS, CALL_DATA, CALLBACK, EXTRA],
      [1, URLS, CALL_DATA, CALLBACK, EXTRA],
      [SENDER, 'https://gateway.example/ccip', CALL_DATA, CALLBACK, EXTRA],
      [SENDER, [1], CALL_DATA, CALLBACK, EXTRA],
      [SENDER, [], CALL_DATA, CALLBACK, EXTRA],
      [SENDER, URLS, 'not-hex', CALLBACK, EXTRA],
      [SENDER, URLS, CALL_DATA, '0x1234', EXTRA],
      [SENDER, URLS, CALL_DATA, CALLBACK, null],
    ]
    for (const args of cases) {
      expect(() => parseOffchainLookupArgs(args)).toThrow('invalid OffchainLookup args')
    }
  })

  it('fails closed when the revert payload is not decodable', () => {
    expect(() => decodeOffchainLookup('0x556f1830')).toThrow()
    expect(() => decodeOffchainLookup('0xdeadbeef')).toThrow()
  })
})

describe('gatewayHexFromHttp', () => {
  it('returns data from an OK { data: Hex } body', () => {
    const data: Hex = '0xabcd'
    expect(gatewayHexFromHttp({ ok: true, status: 200, body: { data } })).toBe(data)
  })

  it('fails closed on non-OK HTTP even when the body looks valid', () => {
    expect(() => gatewayHexFromHttp({
      ok: false,
      status: 502,
      body: { data: '0xabcd' },
    })).toThrow('HTTP 502')
  })

  it('fails closed when an OK body is not { data: Hex }', () => {
    expect(() => gatewayHexFromHttp({ ok: true, status: 200, body: null })).toThrow('gateway JSON missing hex data')
    expect(() => gatewayHexFromHttp({ ok: true, status: 200, body: { data: 1 } })).toThrow('gateway JSON missing hex data')
    expect(() => gatewayHexFromHttp({ ok: true, status: 200, body: { data: 'zzzz' } })).toThrow('gateway JSON missing hex data')
    expect(() => gatewayHexFromHttp({ ok: true, status: 200, body: {} })).toThrow('gateway JSON missing hex data')
  })
})

describe('rpcResultFromJson', () => {
  it('returns a hex result and a hex revert payload', () => {
    expect(rpcResultFromJson({ result: '0x01' })).toBe('0x01')
    expect(rpcResultFromJson({ error: { data: '0x556f1830' } })).toEqual({ revertData: '0x556f1830' })
  })

  it('fails closed when the payload is not hex', () => {
    expect(() => rpcResultFromJson({ result: 'nope' })).toThrow('RPC error:')
    expect(() => rpcResultFromJson({ error: { data: 1 } })).toThrow('RPC error:')
    expect(() => rpcResultFromJson({ error: { message: 'boom' } })).toThrow('RPC error:')
    expect(() => rpcResultFromJson(null)).toThrow('RPC error:')
  })
})
