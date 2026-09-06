import { describe, expect, it } from 'bun:test'
import * as entry from './index'

describe('extension entry', () => {
  it('loads', () => {
    expect(entry).toBeDefined()
  })
})
