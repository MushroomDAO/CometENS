import type { PublicClient } from 'viem'
import type { V4ControllerAdapter } from '../sdk/v4/controller.js'

export declare function parseV4Args(args: string[]): {
  command: string
  flags: Record<string, string>
}

export declare function runV4Cli(
  args: string[],
  options?: {
    rpcUrl?: string
    client?: PublicClient
    adapterClass?: typeof V4ControllerAdapter
  },
): Promise<string>
