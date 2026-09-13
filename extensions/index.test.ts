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

  it('task 1.1 (slash commands): loading registers the bare /cgc command', () => {
    const registered: string[] = []
    const api = {
      on() {
        return undefined
      },
      registerCommand(name: string) {
        registered.push(name)
      },
    }

    entry(api as never)

    expect(registered).toContain('cgc')
    // The slash-command surface is a single bare registration: no duplicate
    // name that would make pi assign a `:1` invocation suffix.
    expect(registered.filter((name) => name === 'cgc')).toHaveLength(1)
  })

  it('task 1.1 (slash commands): a throwing registerCommand never breaks load (fail-open)', () => {
    const api = {
      on() {
        return undefined
      },
      registerCommand() {
        throw new Error('api exploded')
      },
    }

    expect(() => entry(api as never)).not.toThrow()
  })
})
