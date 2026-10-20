import { createCometENSClient, type NetworkProfile } from '@cometens/sdk'

const text = (key: string): string => import.meta.env[key]?.trim() ?? ''
const rootName = text('VITE_PARENT_NAME')

const profile = {
  id: 'community-local-demo',
  mode: 'selfHosted',
  protocol: 'v3-readonly',
  rootName,
  l1: {
    chainId: 11155111,
    rpcUrl: text('VITE_L1_RPC_URL'),
    resolverAddress: text('VITE_L1_RESOLVER_ADDRESS'),
  },
  l2: {
    chainId: 11155420,
    rpcUrl: text('VITE_L2_RPC_URL'),
    recordsAddress: text('VITE_L2_RECORDS_ADDRESS'),
  },
  gatewayUrls: [] as string[],
} as NetworkProfile

const form = document.querySelector<HTMLFormElement>('#lookup')
const result = document.querySelector<HTMLOutputElement>('#result')
if (!form || !result) throw new Error('Demo form is missing')

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  const name = new FormData(form).get('name')?.toString().trim() ?? ''
  if (!name) return

  result.textContent = 'Checking chain IDs and contract deployments…'
  try {
    const client = createCometENSClient(profile)
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
    result.textContent = error instanceof Error ? error.message : 'Network or record lookup failed'
  }
})
