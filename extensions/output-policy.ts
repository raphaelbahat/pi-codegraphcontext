// Output policy pipeline (change add-cgc-output-token-economy, design D1).
//
// ONE pipeline in the shared runner — strip control sequences → redact
// secrets → bound with head+tail (+spill) — applied uniformly before any
// consumer receives results (gate classifier, command renderer, notices, and
// future tools all inherit it without per-surface logic).
//
// This module is the policy's home. Stage functions that previously lived in
// the slash-commands renderer (commands.ts task 1.3) were moved here so the
// runner and the renderers consume one policy; commands.ts re-exports the
// renderer conveniences (its per-surface bounding is retired by task 2.1).
//
// Stage order matters (design D4): redaction runs BEFORE bounding so the
// placeholders are exactly what surfaces see, and bounding runs LAST so the
// delivered text can never exceed its budget, marker included. Every stage is
// a pure function: nothing here spawns, records, or throws into callers
// (ADR-0004 — renderers stay pure consumers; the runner owns the fail-open
// wrapper around the pipeline per task 1.7).

/**
 * Size budget for rendered command output (head+tail bounding, design D4).
 * The slash-commands renderer's per-surface cap — every rendered command
 * text (status, doctor, report) passes through it, so pathological output can
 * never flood the session transcript. The RUNNER's delivered-output budget is
 * {@link OUTPUT_POLICY_MAX_BYTES}; this tighter cap belongs to the renderer
 * and is retired with the renderer's per-surface bounding (task 2.1).
 */
export const OUTPUT_TEXT_BUDGET = 4096

/**
 * The runner policy's delivered-output budget in characters: the default
 * `output.maxBytes` of the change (16 KiB). Every `cgc` invocation's captured
 * output is bounded to this budget with head+tail preservation and an
 * explicit truncation marker. Task 1.2 plumbs the config key in; until then
 * this constant IS the policy default.
 */
export const OUTPUT_POLICY_MAX_BYTES = 16_384

/**
 * Control/ANSI-escape stripping for rendered text (pre-ADR-0005 discipline:
 * rendered output embeds state detail strings and raw cgc command output, so
 * defense in depth keeps any escape sequence out of the session transcript).
 * Tab/newline/carriage return are preserved — they are layout, not escapes.
 *
 * Task 1.3 widened the status-local pass (task 1.2 of add-cgc-slash-commands)
 * into the shared rule and also strips standalone C1 controls (U+0080–U+009F,
 * including the one-character CSI U+009B): a control byte never survives into
 * a transcript, even without its ESC introducer.
 */
// Built with `new RegExp` on purpose: this pattern exists to match control
// bytes, so a regex literal containing control-character escapes would trip
// biome's `noControlCharactersInRegex`; string escapes sidestep the false
// positive while keeping the exact same pattern.
const ESC_CHAR = '\\x1b'
const CONTROL_SEQUENCE_PATTERN = new RegExp(
  `${ESC_CHAR}(?:\\[[0-9;?]*[ -/]*[@-~]|\\][^\\x07${ESC_CHAR}]*(?:\\x07|${ESC_CHAR}\\\\)|[()#][0-9A-Za-z]|[\\x2d-\\x5f])|[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]`,
  'g',
)

// Standalone C1 controls (U+0080–U+009F, e.g. the one-character CSI U+009B)
// are stripped as well (task 1.3): a control byte never survives into a
// transcript, even without its ESC introducer. Built from a string (like
// CONTROL_SEQUENCE_PATTERN) so biome's `noControlCharactersInRegex` sees no
// control bytes in a regex literal.
const C1_CONTROL_PATTERN = /[\u0080-\u009f]/g

/** Strip control sequences and ANSI escapes from text (see pattern doc). */
export function stripControlSequences(text: string): string {
  return text.replace(CONTROL_SEQUENCE_PATTERN, '').replace(C1_CONTROL_PATTERN, '')
}

/** Explicit truncation marker naming the original size (design D4). */
export function truncationMarker(originalLength: number, label = 'command'): string {
  return `\n… [cgc ${label} output truncated, original ${originalLength} chars]`
}

// ---------------------------------------------------------------------------
// Secret redaction (design D4, task 1.5 deepens the pattern set)
// ---------------------------------------------------------------------------

/**
 * Placeholder replacing a redacted secret value. Conservative by design: the
 * placeholder never echoes the value, never varies by shape, and is
 * unmissable in rendered output.
 */
export const REDACTION_PLACEHOLDER = '[REDACTED]'

/**
 * Credential-style assignments (design D4, conservative first cut — task 1.5
 * owns pattern tuning): a credential-ish key immediately followed by `=` or
 * `:` and a non-empty value. The key list is deliberately narrow (API keys,
 * tokens, secrets, passwords, auth, client secrets, private keys); the value
 * is the run of non-space, non-quote, non-delimiter characters after the
 * separator, with balanced surrounding single/double quotes preserved so the
 * redaction keeps the assignment's shape.
 *
 * Built from a string like the control-sequence pattern so biome's
 * `noControlCharactersInRegex` sees no problematic literals.
 */
const CREDENTIAL_STYLE_ASSIGNMENT =
  /(\b(?:api[_-]?key|access[_-]?key|auth(?:entication)?|client[_-]?secret|password|passwd|pwd|secret|secret[_-]?key|token|private[_-]?key)\b\s*[=:]\s*)("?)([^"'\s,;{}]+)("?)/gi

/**
 * High-entropy literal candidates (design D4, conservative first cut — task
 * 1.5 owns pattern tuning): the pattern matches 32+-character hex strings and
 * 40+-character base64-alphabet strings, then {@link looksHighEntropy}
 * verifies the candidate actually looks random before redacting. Long
 * random-looking literals are the shape of generated secrets (API keys,
 * signing keys, tokens); short hex values (colors, short git SHAs) and
 * ordinary words are left alone.
 */
const HIGH_ENTROPY_LITERAL = /\b[0-9a-fA-F]{32,}\b|\b[A-Za-z0-9+/]{40,}\b/g

/**
 * True when a long run of alphanumerics/b64 characters actually looks like a
 * random literal rather than ordinary output. Requires variety (8+ distinct
 * characters — a run of one repeated character is emphasis text, padding, or
 * a flood, not a secret), and either a pure-hex shape (32+ hex chars are
 * hash/key-shaped by construction: git SHAs, digests, tokens) or a mix of at
 * least two character classes (lower/upper/digit/symbol), the shape of
 * generated keys.
 */
function looksHighEntropy(candidate: string): boolean {
  if (new Set(candidate).size < 8) return false
  const classes = [
    /[a-z]/.test(candidate),
    /[A-Z]/.test(candidate),
    /[0-9]/.test(candidate),
    /[+/]/.test(candidate),
  ]
  if (classes.filter(Boolean).length < 2) return false
  // Mixed classes: base64-ish and key-shaped — redactable either way.
  return true
}

/** Options controlling the secret-redaction stage. */
export interface CgcRedactOptions {
  /**
   * Master switch for the redaction stage (default on). Task 1.2 wires the
   * `output.redactSecrets` config key here; until then the default stands —
   * redaction is on unless a caller explicitly turns it off.
   */
  enabled?: boolean
}

/**
 * Conservative pattern-based secret redaction (design D4): credential-style
 * assignments and high-entropy literals are replaced with
 * {@link REDACTION_PLACEHOLDER}. Runs BEFORE bounding so placeholders are
 * what surfaces see. Shaped values keep their surrounding quotes
 * (`token="abc"` → `token="[REDACTED]"`). Pure function, never throws.
 */
export function redactSecrets(text: string, options: CgcRedactOptions = {}): string {
  if (options.enabled === false) return text
  const withAssignments = text.replace(
    CREDENTIAL_STYLE_ASSIGNMENT,
    (_match, prefix: string, openQuote: string, _value: string, closeQuote: string) =>
      `${prefix}${openQuote}${REDACTION_PLACEHOLDER}${closeQuote}`,
  )
  return withAssignments.replace(HIGH_ENTROPY_LITERAL, (candidate) =>
    looksHighEntropy(candidate) ? REDACTION_PLACEHOLDER : candidate,
  )
}

// ---------------------------------------------------------------------------
// Bounding (head+tail with an explicit marker, design D2/D4)
// ---------------------------------------------------------------------------

/** Options controlling the shared size-bound (design D4). */
export interface CgcOutputBoundOptions {
  /**
   * Size cap in characters. Defaults to {@link OUTPUT_TEXT_BUDGET} — the
   * shared cap every command renders under.
   */
  budget?: number
  /**
   * Command name embedded in the truncation marker (e.g. "status" renders
   * "cgc status output truncated …"). Defaults to "command".
   */
  label?: string
  /**
   * The ORIGINAL size to state in the truncation marker. When omitted the
   * marker states the length of the text being bounded; the runner passes
   * the raw stream's total byte count so the marker is honest about material
   * that was dropped by capture retention, not just by this stage.
   */
  originalSize?: number
}

/**
 * Bound rendered text to a budget, preserving head and tail with an explicit
 * truncation marker (design D4: size-bounded render with head+tail
 * preservation). Command output is generated and short in the common case, so
 * this is a fail-safe net for pathological embedded detail strings and raw
 * cgc output, not a hot path. When even the marker cannot fit the budget the
 * marker alone is returned — the truncation contract still holds.
 */
export function boundText(text: string, options: CgcOutputBoundOptions = {}): string {
  const budget = options.budget ?? OUTPUT_TEXT_BUDGET
  if (text.length <= budget) return text
  const marker = truncationMarker(options.originalSize ?? text.length, options.label ?? 'command')
  if (budget < marker.length) return marker
  const headLength = Math.floor((budget - marker.length) / 2)
  return `${text.slice(0, headLength)}${marker}${text.slice(text.length - (budget - marker.length - headLength))}`
}

/**
 * The renderer-level convenience pipeline (design D4): strip control
 * sequences, then size-bound with head+tail preservation and an explicit
 * truncation marker. The slash-commands renderer consumes this directly for
 * its own text (status) and for presentational wrapping of already-pipelined
 * command output (doctor/report, task 2.4). Task 2.1 retires the per-surface
 * bounding — until then this function keeps the renderer's behavior exactly.
 */
export function renderCommandText(text: string, options: CgcOutputBoundOptions = {}): string {
  return boundText(stripControlSequences(text), options)
}

// ---------------------------------------------------------------------------
// The runner pipeline: strip → redact → bound (design D1)
// ---------------------------------------------------------------------------

/** Options for the runner's uniform output policy (design D1). */
export interface CgcOutputPolicyOptions extends CgcOutputBoundOptions {
  /**
   * Whether the redaction stage is enabled (default on). Task 1.2 wires the
   * `output.redactSecrets` config key here.
   */
  redact?: boolean
}

/**
 * The runner's output policy pipeline (design D1): strip control sequences →
 * redact secrets → bound with head+tail (+spill seam) — applied uniformly
 * before any consumer receives results. Stage order is fixed: redaction runs
 * before bounding so placeholders are what surfaces see, and bounding runs
 * last so the delivered text never exceeds its budget. Pure function; the
 * runner wraps it fail-open (task 1.7) so a stage defect degrades to
 * best-effort delivery instead of failing the invocation.
 */
export function applyOutputPolicy(text: string, options: CgcOutputPolicyOptions = {}): string {
  const stripped = stripControlSequences(text)
  const redacted = redactSecrets(stripped, { enabled: options.redact !== false })
  return boundText(redacted, options)
}
