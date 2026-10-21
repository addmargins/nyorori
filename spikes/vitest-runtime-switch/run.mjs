// Spike: one Vitest instance, mutants switched at runtime via provide/inject (no re-transform, no restart).
import { createVitest } from 'vitest/node'
import path from 'node:path'
const target = path.resolve('src/math.ts')
const plugin = {
  name: 'nyorori', enforce: 'pre',
  transform(code, id) {
    if (id !== target) return
    // hand-written schemata: 1 => `>`, 2 => `<`, 3 => `true`
    return code.replace('age >= 18',
      '(globalThis.__nyorori_active === 1 ? age > 18 : globalThis.__nyorori_active === 2 ? age < 18 : globalThis.__nyorori_active === 3 ? true : age >= 18)')
  },
}
const vitest = await createVitest('test', { watch: false, reporters: [], setupFiles: ['./setup.ts'], provide: { nyororiMutant: 0 }, related: [target] }, { plugins: [plugin] })
const related = await vitest.getRelevantTestSpecifications()
console.log('related specs:', related.map(s => path.relative('.', s.moduleId)))
for (const id of [0, 1, 2, 3]) {
  for (const p of vitest.projects) p.provide('nyororiMutant', id)
  const t = performance.now()
  const res = await vitest.runTestSpecifications(related)
  const failed = res.testModules.some(m => m.state() === 'failed')
  console.log(`mutant ${id}: ${failed ? 'KILLED' : 'SURVIVED'} (${(performance.now()-t).toFixed(0)}ms)`)
}
await vitest.close()
