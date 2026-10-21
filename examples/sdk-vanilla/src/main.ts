import { createCometENSClient, createSelfHostedProfile, SDKError } from '@cometens/sdk'

const text = (key: string): string => import.meta.env[key]?.trim() ?? ''

function address(key: string): `0x${string}` {
  const value = text(key)
  if (!/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0{40}$/i.test(value)) {
    throw new Error(`Missing or invalid public contract address for ${key}`)
  }
  return value as `0x${string}`
}

const form = document.querySelector<HTMLFormElement>('#lookup')
const result = document.querySelector<HTMLOutputElement>('#result')
if (!form || !result) throw new Error('Demo form is missing')

let client: ReturnType<typeof createCometENSClient> | undefined
try {
  const profile = createSelfHostedProfile({
    id: 'community-local-demo',
    protocol: 'v3-readonly',
    rootName: text('VITE_PARENT_NAME'),
    l1: {
      chainId: 11155111,
      rpcUrl: text('VITE_L1_RPC_URL'),
      resolverAddress: address('VITE_L1_RESOLVER_ADDRESS'),
    },
    l2: {
      chainId: 11155420,
      rpcUrl: text('VITE_L2_RPC_URL'),
      recordsAddress: address('VITE_L2_RECORDS_ADDRESS'),
    },
    gatewayUrls: [],
  })
  client = createCometENSClient(profile)
  result.textContent = 'Configuration valid. Enter an ENS name to read OP records.'
} catch {
  result.textContent = 'Configuration incomplete: copy .env.example to .env.local, set your verified Sepolia contract addresses and restart the demo.'
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')
  if (submit) submit.disabled = true
}

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  if (!client) return
  const name = new FormData(form).get('name')?.toString().trim() ?? ''
  if (!name) return

  result.textContent = 'Checking chain IDs and contract deployments…'
  try {
    await client.verifyNetwork()
    const [address, website] = await Promise.all([
      client.getAddr(name),
      client.getText(name, 'url'),
    ])
    result.textContent = JSON.stringify({
      name,
      network: 'Ethereum Sepolia / OP Sepolia',
      l2Address: address,
      textUrl: website,
      source: 'L2Records direct read (not Universal Resolver)',
    }, null, 2)
  } catch (error) {
    // Display a stable code, never an arbitrary third-party exception or RPC URL.
    result.textContent = error instanceof SDKError
      ? `Network or record lookup failed (${error.kind})`
      : 'Network or record lookup failed'
  }
})
