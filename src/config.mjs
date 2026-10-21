/**
 * Validated plugin configuration.
 *
 * Every value below is deployment-tunable and therefore arrives from
 * `cordis.yml`; nothing here is hard-coded at a call site. Validation is
 * explicit and total: an unknown key, a wrong type, or an out-of-range number
 * throws during `apply()`, so a typo fails the plugin load loudly instead of
 * silently falling back to a default.
 *
 * This package deliberately ships no `Config` schema and no runtime
 * dependencies: the surface is small enough that total hand-written validation
 * is clearer than importing the Schemastery package, and a dependency-free
 * plugin cannot fail to resolve at load time.
 */

/** Field defaults; also the exact set of keys this plugin accepts. */
export const CONFIG_DEFAULTS = Object.freeze({
  /** Fallback route for a session whose own model selection cannot be read. */
  defaultProvider: '',
  defaultModel: '',
  /**
   * Reasoning effort for the auxiliary call. Empty inherits whatever the
   * session's own route specifies.
   *
   * The default is `low` on purpose: `maxOutputTokens` is a single cap that
   * covers reasoning **and** visible text, so a deep-thinking auxiliary call
   * can spend the whole allowance before writing anything. There is no way to
   * exempt reasoning from the cap — DSH's request carries only `maxTokens` and
   * `reasoningEffort`, and this deployment's provider forwards exactly those.
   * `low` is therefore the lever that makes a small budget usable.
   *
   * An adapter that does not offer the requested id should ignore it; to go
   * back to inheriting the session's effort, set this to ''.
   */
  reasoningEffort: 'low',
  /** How many of the newest turns `turns/list` returns. */
  maxTurns: 50,
  /** Tool calls kept per turn; overflow is reported as `droppedToolCalls`. */
  maxToolCallsPerTurn: 40,
  /** Character caps applied to the evidence handed to the model. */
  maxArgsChars: 1_200,
  maxResultChars: 1_600,
  /** Character cap applied to a turn's own prompt (panel excerpt and evidence). */
  maxPromptChars: 400,
  /**
   * Output cap and wall-clock cap for one interpretation call.
   *
   * Read this as "reasoning + answer", not "answer length": reasoning tokens
   * count against it. `deepseek/deepseek-v4.1-flash` through the Command Code
   * provider thinks unconditionally and offers only `low | high | max` — there
   * is no `off`, and `reasoning_effort` is the only request field that controls
   * depth. A budget that only covers the answer can therefore be consumed
   * entirely by thinking and produce no text at all.
   */
  maxOutputTokens: 1_500,
  timeoutMs: 120_000,
  /**
   * Longest operator-supplied system prompt the panel may send. A non-empty
   * value replaces the default prompt entirely for that analyze call, so the
   * cap applies to a full system instruction rather than to a steering note.
   */
  maxOverrideChars: 2_000,
})

const NUMBER_BOUNDS = Object.freeze({
  maxTurns: [1, 500],
  maxToolCallsPerTurn: [1, 200],
  maxArgsChars: [80, 20_000],
  maxResultChars: [80, 40_000],
  maxPromptChars: [80, 4_000],
  maxOutputTokens: [64, 32_000],
  timeoutMs: [1_000, 900_000],
  maxOverrideChars: [0, 20_000],
})

const STRING_KEYS = Object.freeze(['defaultProvider', 'defaultModel', 'reasoningEffort'])

function readString(key, value) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new TypeError(`trajectory-tool-insight: config.${key} must be a string`)
  }
  const trimmed = value.trim()
  if (trimmed.length > 200) {
    throw new TypeError(`trajectory-tool-insight: config.${key} must be at most 200 characters`)
  }
  return trimmed
}

function readNumber(key, value) {
  if (value === undefined || value === null) return undefined
  const [min, max] = NUMBER_BOUNDS[key]
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`trajectory-tool-insight: config.${key} must be an integer between ${min} and ${max}`)
  }
  return value
}

/**
 * Validate one raw configuration mapping.
 * @param raw - the mapping Cordis read from `cordis.yml`; omitted means defaults.
 * @returns a frozen configuration whose every field is present and validated.
 * @throws TypeError on a malformed mapping, an unknown key, or an invalid value.
 */
export function normalizeConfig(raw = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('trajectory-tool-insight: plugin config must be a mapping')
  }
  const unknown = Object.keys(raw).filter(key => !Object.hasOwn(CONFIG_DEFAULTS, key))
  if (unknown.length > 0) {
    throw new TypeError(`trajectory-tool-insight: unknown config ${unknown.map(key => `"${key}"`).join(', ')}`)
  }
  const config = { ...CONFIG_DEFAULTS }
  for (const key of STRING_KEYS) {
    const value = readString(key, raw[key])
    if (value !== undefined) config[key] = value
  }
  for (const key of Object.keys(NUMBER_BOUNDS)) {
    const value = readNumber(key, raw[key])
    if (value !== undefined) config[key] = value
  }
  return Object.freeze(config)
}

/**
 * The projection caps derived from one validated configuration.
 * @param config - a normalized configuration.
 * @returns the limits object {@link import('./turns.mjs').collectTurns} expects.
 */
export function turnLimits(config) {
  return {
    maxTurns: config.maxTurns,
    maxToolCallsPerTurn: config.maxToolCallsPerTurn,
    maxArgsChars: config.maxArgsChars,
    maxResultChars: config.maxResultChars,
    promptChars: config.maxPromptChars,
  }
}

/**
 * The configured fallback route, or `null` when the operator configured none.
 * @param config - a normalized configuration.
 * @returns `{ provider, model }`, or `null` when either half is empty.
 */
export function configuredFallbackRoute(config) {
  const provider = config.defaultProvider
  const model = config.defaultModel
  if (!provider || !model) return null
  return { provider, model }
}
