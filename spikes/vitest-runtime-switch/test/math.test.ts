import { expect, test } from 'vitest'
import { isAdult } from '../src/math'
test('adult', () => { expect(isAdult(30)).toBe(true); expect(isAdult(3)).toBe(false) })
