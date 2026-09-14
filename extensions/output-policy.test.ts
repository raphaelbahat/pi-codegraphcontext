import { describe, expect, it } from 'bun:test'
import {
  applyOutputPolicy,
  boundText,
  OUTPUT_POLICY_MAX_BYTES,
  OUTPUT_TEXT_BUDGET,
  REDACTION_PLACEHOLDER,
  redactSecrets,
} from './output-policy'

describe('output policy pipeline (add-cgc-output-token-economy task 1.1)', () => {
  it('redacts credential-style assignments, preserving the surrounding quotes', () => {
    expect(redactSecrets('token="abc123" api_key=xyz789 password:hunter2 secret:  qwerty')).toBe(
      `token="${REDACTION_PLACEHOLDER}" api_key=${REDACTION_PLACEHOLDER} password:${REDACTION_PLACEHOLDER} secret:  ${REDACTION_PLACEHOLDER}`,
    )
  })

  it('redacts high-entropy literals (long hex and base64 runs)', () => {
    // 32+ hex chars with variety: hash/key-shaped by construction.
    const hexish = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'
    expect(redactSecrets(`checksum=${hexish}`)).toBe(`checksum=${REDACTION_PLACEHOLDER}`)
    // Mixed-class, high-variety b64-alphabet run (no letters from A–F).
    const b64ish = 'GhIjKlMnOpQrStUvWxYz'.repeat(2)
    expect(redactSecrets(`token ${b64ish}`)).toBe(`token ${REDACTION_PLACEHOLDER}`)
    expect(redactSecrets('plain words and short hex 1a2b3c stay')).toBe(
      'plain words and short hex 1a2b3c stay',
    )
  })

  it('does not redact low-variety runs (ordinary output, not secrets)', () => {
    // Long runs of one repeated character (emphasis text, padding, a stream
    // of x's) or of a tiny pattern are NOT high entropy — the conservative
    // guard keeps them.
    expect(redactSecrets('x'.repeat(1_048_576))).toBe('x'.repeat(1_048_576))
    expect(redactSecrets(`padding ${'a'.repeat(60)} end`)).toBe(`padding ${'a'.repeat(60)} end`)
    expect(redactSecrets(`border ${'ab'.repeat(20)} end`)).toBe(`border ${'ab'.repeat(20)} end`)
  })

  it('leaves output untouched when the redaction opt-out seam is enabled:false', () => {
    expect(redactSecrets('token=abc123', { enabled: false })).toBe('token=abc123')
  })

  it('applies strip → redact → bound in the fixed order', () => {
    const line = '\u001b[31msecret=abc123\u001b[0m\n'
    const out = applyOutputPolicy(line.repeat(OUTPUT_TEXT_BUDGET), {
      budget: OUTPUT_TEXT_BUDGET,
    })

    expect(out).not.toContain('\u001b')
    expect(out).not.toContain('abc123')
    expect(out).toContain(REDACTION_PLACEHOLDER)
    expect(out.length).toBeLessThanOrEqual(OUTPUT_TEXT_BUDGET)
    expect(out).toContain('truncated')
  })

  it('passes small output through unchanged and unmarked', () => {
    expect(applyOutputPolicy('plain ok')).toBe('plain ok')
  })

  it('bounds to the runner policy budget by default and states the ORIGINAL size', () => {
    const out = boundText('x'.repeat(OUTPUT_POLICY_MAX_BYTES + 1), {
      budget: OUTPUT_POLICY_MAX_BYTES,
      label: 'command',
      originalSize: 1_048_576,
    })

    expect(out.length).toBeLessThanOrEqual(OUTPUT_POLICY_MAX_BYTES)
    expect(out).toContain('cgc command output truncated')
    expect(out).toContain('original 1048576 chars')
    expect(out.startsWith('x')).toBe(true)
    expect(out.endsWith('x')).toBe(true)
  })
})
