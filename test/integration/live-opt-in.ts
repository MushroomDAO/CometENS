/** Testnet RPC credentials alone must never authorize external reads or writes. */
export function liveTestOptIn(env: NodeJS.ProcessEnv = process.env) {
  const reads = env.COMETENS_LIVE_READ_TESTS === '1'
  // Two distinct, explicit flags are required before Vitest may send transactions.
  const writes = reads && env.COMETENS_LIVE_WRITE_TESTS === '1'
  return { reads, writes }
}
