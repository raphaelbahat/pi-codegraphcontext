import { describe, expect, it } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CgcRunner } from './runner'
import { SpillSession } from './spill'

const BUN = process.execPath
const IS_WINDOWS = process.platform === 'win32'

function makeBase(): string {
  return mkdtempSync(join(tmpdir(), 'cgc-spill-test-'))
}

function spillDirs(base: string): string[] {
  return readdirSync(base).filter((entry) => entry.startsWith('pi-cgc-spill'))
}

describe('SpillSession / SpillWriter (add-cgc-output-token-economy task 1.4)', () => {
  it('creates its directory lazily under the injected base and spills the stream', () => {
    const base = makeBase()
    try {
      const session = new SpillSession({ baseDir: base, id: 'session-abc' })
      const writer = session.createWriter('stdout', 1024)

      // Nothing touches disk until the stream is flushed.
      writer.sink(Buffer.from('hello '))
      expect(session.directoryPath).toBeNull()
      expect(writer.filePath).toBeNull()

      writer.sink(Buffer.from('world'))
      const path = writer.commit()

      expect(session.directoryPath).toBe(join(base, 'pi-cgc-spill-session-abc'))
      expect(path).toContain('pi-cgc-spill-session-abc')
      expect(path).toContain('spill-stdout-1.log')
      expect(readFileSync(path as string, 'utf8')).toBe('hello world')
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('buffers below the threshold and leaves nothing behind on discard', () => {
    const base = makeBase()
    try {
      const session = new SpillSession({ baseDir: base, id: 'session-buffered' })
      const writer = session.createWriter('stdout', 4096)

      writer.sink(Buffer.from('short output'))
      writer.discard()

      expect(session.directoryPath).toBeNull()
      expect(writer.filePath).toBeNull()
      expect(existsSync(join(base, 'pi-cgc-spill-session-buffered'))).toBe(false)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('flushes the buffered prefix when the stream crosses the threshold', () => {
    const base = makeBase()
    try {
      const session = new SpillSession({ baseDir: base, id: 'session-cross' })
      const writer = session.createWriter('stderr', 8)

      writer.sink(Buffer.from('abc'))
      writer.sink(Buffer.from('defghij'))
      const path = writer.commit()

      expect(path).not.toBeUndefined()
      expect(readFileSync(path as string, 'utf8')).toBe('abcdefghij')
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('uses restrictive permissions where the platform supports them', () => {
    if (IS_WINDOWS) return
    const base = makeBase()
    try {
      const session = new SpillSession({ baseDir: base, id: 'session-perm' })
      const writer = session.createWriter('stdout', 0)
      writer.sink(Buffer.from('secret-bearing output'))
      const path = writer.commit()

      expect(statSync(session.directoryPath as string).mode & 0o777).toBe(0o700)
      expect(statSync(path as string).mode & 0o777).toBe(0o600)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('remove deletes the directory and every spill file in it', () => {
    const base = makeBase()
    try {
      const session = new SpillSession({ baseDir: base, id: 'session-remove' })
      const out = session.createWriter('stdout', 0)
      const err = session.createWriter('stderr', 0)
      out.sink(Buffer.from('out'))
      err.sink(Buffer.from('err'))
      out.commit()
      err.commit()
      const directory = session.directoryPath as string
      expect(existsSync(directory)).toBe(true)

      session.remove()

      expect(existsSync(directory)).toBe(false)
      expect(session.directoryPath).toBeNull()
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('remove is idempotent and safe when nothing was spilled', () => {
    const base = makeBase()
    try {
      const session = new SpillSession({ baseDir: base, id: 'session-empty' })
      expect(() => {
        session.remove()
        session.remove()
      }).not.toThrow()
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('is fail-open when the spill directory cannot be created', () => {
    const base = makeBase()
    try {
      // A regular file where the base directory should be makes mkdir throw.
      const notADirectory = join(base, 'not-a-directory')
      writeFileSync(notADirectory, 'x')
      const session = new SpillSession({ baseDir: notADirectory, id: 'session-fail' })
      const writer = session.createWriter('stdout', 0)

      expect(() => writer.sink(Buffer.from('data'))).not.toThrow()
      expect(writer.commit()).toBeUndefined()
      expect(writer.filePath).toBeNull()
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})

describe('runner spill integration (add-cgc-output-token-economy task 1.4)', () => {
  it('spills a truncated stream to a temp file outside the workspace and names it', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'cgc-spill-runner-ws-'))
    const spillBase = makeBase()
    try {
      const runner = new CgcRunner({
        executable: BUN,
        spillToTemp: true,
        spillBaseDir: spillBase,
      })
      const result = await runner.run(workspace, {
        args: ['-e', 'process.stdout.write("x".repeat(1024 * 1024))'],
        env: {},
        maxOutputBytes: 2048,
      })

      expect(result.ok).toBe(true)
      expect(result.stdout).toContain('truncated')
      expect(result.stdout).toContain('spilled to')

      // The marker names a file under the (test) base, never the workspace.
      const match = result.stdout.match(/spilled to ([^\]]+)\]/)
      const spillPath = match?.[1]
      expect(spillPath).toBeDefined()
      expect((spillPath as string).startsWith(workspace)).toBe(false)
      expect((spillPath as string).startsWith(spillBase)).toBe(true)
      // The FULL original output is on disk.
      const full = readFileSync(spillPath as string)
      expect(full.length).toBe(1024 * 1024)

      // Teardown removes the session directory and its files.
      expect(spillDirs(spillBase).length).toBe(1)
      runner.cleanupSpills()
      expect(spillDirs(spillBase).length).toBe(0)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
      rmSync(spillBase, { recursive: true, force: true })
    }
  })

  it('writes no spill file when spill is disabled', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'cgc-spill-runner-ws-'))
    try {
      const runner = new CgcRunner({ executable: BUN, spillToTemp: false })
      const result = await runner.run(workspace, {
        args: ['-e', 'process.stdout.write("x".repeat(1024 * 1024))'],
        env: {},
        maxOutputBytes: 2048,
      })

      expect(result.stdout).toContain('truncated')
      expect(result.stdout).not.toContain('spilled to')
      expect(result.stdout).not.toContain('pi-cgc-spill')
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})
