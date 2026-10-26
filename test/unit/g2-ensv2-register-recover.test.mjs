import {it,expect} from 'vitest'
import {validateJournal,inspectRegister} from '../../scripts/g2-ensv2-register-recover.mjs'
const wallet='0xF7Bf79AcB7F3702b9DbD397d8140ac9DE6Ce642C'
const registrar='0xf633e7fc17e2bbe0d0965d18ec1821dcb754a3d3'
const h='0x'+'ab'.repeat(32), blockhash='0x'+'cd'.repeat(32), data='0x1234'
const {keccak256}=await import('viem')
const journal={state:'SIGNED_NO_RETRY',commitment:'0x'+'fe'.repeat(32),hash:h,nonce:751,chainId:11155111,calldataHash:keccak256(data)}
const stub=({missing=false,wrong=false,final=101n}={})=>({
 getChainId:async()=>11155111,
 getTransaction:async()=>missing?null:{from:wallet,to:registrar,nonce:751,hash:h,input:wrong?'0x':data},
 getTransactionReceipt:async()=>missing?null:{transactionHash:h,blockHash:blockhash,blockNumber:100n,status:'success'},
 getBlock:async p=>p.blockTag?{number:final}:{hash:blockhash,number:100n}
})
it('rejects missing signer hash, invalid nonce and malformed journal',()=>{
 expect(validateJournal(journal)).toBe(journal)
 for(const v of [{hash:'0x'},{nonce:-1},{state:'RESERVED_NO_RETRY'},{chainId:1}])expect(()=>validateJournal({...journal,...v})).toThrow('INVALID_SIGNED_JOURNAL')
})
it('only finalizes matching canonical dual RPC receipts; never retries uncertainty',async()=>{
 expect((await inspectRegister([stub(),stub()],journal)).status).toBe('REGISTER_TX_FINALIZED')
 expect((await inspectRegister([stub({missing:true}),stub()],journal)).status).toBe('UNKNOWN_DO_NOT_RETRY')
 expect((await inspectRegister([stub({wrong:true}),stub()],journal)).status).toBe('TX_MISMATCH_NO_RETRY')
 expect((await inspectRegister([stub({final:99n}),stub()],journal)).status).toBe('AWAITING_FINALITY_NO_RETRY')
})
