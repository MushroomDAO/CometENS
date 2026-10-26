import {it,expect} from 'vitest'
import {retryMovingHead} from '../../scripts/prepare-g2-sepolia-ensv2-registration.mjs'

it('revalidates all safety gates against a fresh block after head advances',async()=>{
 const seen=[]
 const outcome=await retryMovingHead({phase:'reveal'},async()=>{
  seen.push(seen.length+1)
  return seen.length===1?{reason:'QUOTE_HEAD_ADVANCED',simulated:false}:
    {reason:'EXTERNAL_WALLET_ACTION_REQUIRED',simulated:true,simulationBlock:{number:'42'},totalCost:'8000021'}
 })
 expect(seen).toEqual([1,2]);expect(outcome.simulationBlock.number).toBe('42')
})
it('never accepts stale quote when newer block fails payment or commitment safety',async()=>{
 let calls=0
 const result=await retryMovingHead({phase:'reveal'},async()=>++calls===1?
  {reason:'QUOTE_HEAD_ADVANCED'}:{reason:'ALLOWANCE_TOO_LOW'})
 expect(calls).toBe(2);expect(result.reason).toBe('ALLOWANCE_TOO_LOW')
})
it('bounds attempts at two, never retries unrelated failures or commit flow',async()=>{
 let calls=0
 const attempt=async()=>{calls++;return {reason:'QUOTE_HEAD_ADVANCED'}}
 expect((await retryMovingHead({phase:'reveal'},attempt)).reason).toBe('QUOTE_HEAD_ADVANCED')
 expect(calls).toBe(2)
 calls=0;await retryMovingHead({phase:'commit'},attempt);expect(calls).toBe(1)
 calls=0;await retryMovingHead({phase:'reveal'},async()=>{calls++;return {reason:'COMMITMENT_NOT_IN_WINDOW'}})
 expect(calls).toBe(1)
})
