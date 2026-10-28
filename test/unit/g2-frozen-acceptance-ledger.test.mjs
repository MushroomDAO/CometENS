import {it,expect} from 'vitest'
import {readFileSync} from 'node:fs'
const text=readFileSync(new URL('../../docs/goal/G2-EVIDENCE-INVENTORY-20261028.md',import.meta.url),'utf8')
it('preserves nine frozen pending gates and forbids auto promotion',()=>{for(let n=1;n<=9;n++)expect(text).toContain(`| G2.${n} |`);expect(text.match(/\| PENDING \|/g)).toHaveLength(9);expect(text).toContain('G3 BLOCKED');expect(text).toContain('CLOSED')})
