import { describe,it,expect,vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { validateRegisterOrder,checkRegister,checkWalletDelegation } from '../../scripts/g2-local-sepolia-register.mjs'
const order=JSON.parse(readFileSync(new URL('../../examples/g2-sepolia/03-register.json',import.meta.url)))
order.expiresAt=new Date(Date.now()+3600000).toISOString()
const manifest={label:'cometens-g2-20261023',wallet:order.from,durationSeconds:'31536000',maxTotalCost:'9000000',expectedRegistrarCodeHash:'0xb025a7edb8e81862c2d28857211a7a91c1fb2b17c5bcf28b983987067f083c2a',expectedTokenCodeHash:'0xa9a4749f886f5035336f6e16dce5ca6f339ae73f76e94ad4b8f46a447dc335f3'}
describe('G2 registration safety',()=>{
 it('rejects observed 7702 delegate on two RPCs, code mismatch and unexpected code',async()=>{
  const code='0xef01005804b6119d12ad403a430fd3cff12a8ff6e4064b'
  const client=c=>({getChainId:async()=>11155111,getBytecode:async()=>c})
  await expect(checkWalletDelegation([client(code),client(code)])).resolves.toMatchObject({reason:'EIP7702_DELEGATION_ACTIVE',delegate:'0x5804b6119d12ad403a430fd3cff12a8ff6e4064b'})
  await expect(checkWalletDelegation([client(code),client('0x')])).resolves.toMatchObject({reason:'WALLET_CODE_RPC_DISAGREEMENT'})
  await expect(checkWalletDelegation([client('0x6000'),client('0x6000')])).resolves.toMatchObject({reason:'UNEXPECTED_WALLET_CODE'})
  await expect(checkWalletDelegation([client('0x'),client('0x')])).resolves.toMatchObject({status:'PASS'})
  await expect(checkWalletDelegation([client(undefined),client(undefined)])).resolves.toMatchObject({status:'PASS'})
  await expect(checkWalletDelegation([client(undefined),client('0x')])).resolves.toMatchObject({status:'PASS'})
  await expect(checkWalletDelegation([client('0xef01000000000000000000000000000000000000000001'),client('0xef01000000000000000000000000000000000000000001')])).resolves.toMatchObject({reason:'EIP7702_DELEGATION_ACTIVE'})
 })
 it('requires exact dedicated register schema and fixed manifest',()=>{
  expect(validateRegisterOrder(order,manifest).maxCost).toBe(9000000n)
  for(const mutation of [{action:'commit'},{chainId:1},{maxTotalCost:'10000000'},{commitment:'0x'+'00'.repeat(32)},{from:'0x0000000000000000000000000000000000000001'},{to:'0x0000000000000000000000000000000000000001'},{expiresAt:'2020-01-01T00:00:00.000Z'},{data:'0xdeadbeef'}])
   expect(()=>validateRegisterOrder({...order,...mutation},manifest)).toThrow()
  expect(()=>validateRegisterOrder(order,{...manifest,maxTotalCost:'9000001'})).toThrow()
 })
 it('blocks a missing, expired, or mismatched local commitment before any RPC',async()=>{
  const spy=vi.fn()
  expect((await checkRegister({order:{...order,expiresAt:'2020-01-01T00:00:00.000Z'},manifest,saltFile:'/no/file',clients:[spy,spy]})).reason).toBe('INVALID_REGISTER_ORDER')
  expect((await checkRegister({order,manifest,saltFile:'/no/file',clients:[spy,spy]})).reason).toBe('SALT_INVALID')
  expect(spy).not.toHaveBeenCalled()
 })
})

it('accepts ordinary public 0644 order JSON, rejects symlink and oversized order',async()=>{
 const {readPublicOrder}=await import('../../scripts/g2-local-sepolia-register.mjs')
 const {mkdtemp,writeFile,chmod,symlink,rm}=await import('node:fs/promises')
 const {tmpdir}=await import('node:os')
 const {join}=await import('node:path')
 const dir=await mkdtemp(join(tmpdir(),'g2-public-order-'))
 try {
  const publicPath=join(dir,'order.json')
  await writeFile(publicPath,JSON.stringify(order))
  await chmod(publicPath,0o644)
  expect(await readPublicOrder(publicPath)).toEqual(order)
  const alias=join(dir,'alias.json')
  await symlink(publicPath,alias)
  await expect(readPublicOrder(alias)).rejects.toThrow('UNSAFE_ORDER_FILE')
  const large=join(dir,'large.json')
  await writeFile(large,'x'.repeat(4097))
  await expect(readPublicOrder(large)).rejects.toThrow('UNSAFE_ORDER_FILE')
 } finally {await rm(dir,{recursive:true,force:true})}
})
