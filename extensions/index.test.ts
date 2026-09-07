import { describe, expect, it } from 'bun:test'
import entry from './index'

describe('extension entry', () => {
  it('exports a default Pi extension factory', () => {
    expect(typeof entry).toBe('function')
  })
})
