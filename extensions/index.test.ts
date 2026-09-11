import { describe, expect, it } from 'bun:test'
import entry from './index'

const brokenApi = {
  on() {
    throw new Error('api exploded')
  },
}

describe('extension entry', () => {
  it('exports a default Pi extension factory', () => {
    expect(typeof entry).toBe('function')
  })

  it('task 3.2: loading with a throwing extension API never throws (fail-open)', () => {
    expect(() => entry(brokenApi as never)).not.toThrow()
  })
})
