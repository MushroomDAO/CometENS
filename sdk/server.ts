import { CometENS } from './CometENS.js'
import { SDKError } from './profiles.js'
import type { NetworkProfile } from './types.js'

export interface ServerAuth {
  /** Secret for *service metering* on an API supporting bearer keys.
   * It never replaces EIP-712 owner/operator signing. Never expose to browsers.
   */
  getApiKey: () => string | Promise<string>
}

export class CometENSServerClient extends CometENS {
  private readonly auth: ServerAuth

  constructor(profile: NetworkProfile, auth: ServerAuth) {
    if (typeof window !== 'undefined') {
      throw new SDKError('invalid-input', 'Server-only API key authentication is unavailable in browsers')
    }
    super(profile)
    this.auth = auth
  }

  protected override async requestHeaders(): Promise<Record<string, string>> {
    const key = await this.auth.getApiKey()
    if (!key || /[\r\n]/.test(key)) throw new SDKError('invalid-input', 'Server API key is missing or invalid')
    return { ...await super.requestHeaders(), authorization: `Bearer ${key}` }
  }
}

export const createCometENSServerClient = (profile: NetworkProfile, auth: ServerAuth) =>
  new CometENSServerClient(profile, auth)
