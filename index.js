/**
 * 轨迹解读 · 宿主半部分.
 *
 * A read-only interpretation surface for one trajectory turn's tool calls. It
 * contributes exactly two authenticated HTTP routes and never writes to the
 * session log:
 *
 * - `POST /api/turn-insight.turns`   `{ sessionId }` → `{ turns, totalTurns, route }`
 * - `POST /api/turn-insight.analyze` `{ sessionId, turn }` → `{ text, route, usage, finish, truncated }`
 *
 * Both are **exact Fetch routes under the shared `/api` channel** rather than a
 * private `connection.rpc.handle` channel. That is deliberate:
 * `HostConnectionRpc.handle` mounts its route with
 * `owner.effect(() => owner.webServer.register(route))`, and the context Cordis
 * binds as `owner` there is *not* the plugin's own inject scope — declaring
 * `webServer` in this plugin's `inject` does not satisfy it, and the load fails
 * with `cannot get property "webServer" without inject`. The shared `/api`
 * channel is mounted by the connection plugin itself (with its own
 * `ctx.inject(['webServer'])` scope), and its exact-route registry touches no
 * such property, which is why `file-upload`, `deliverables`, `session-log-export`
 * and the session controller all register this way.
 *
 * The session log stays the single source of truth: every turn and tool call
 * the panel shows is folded out of it on demand, and the model that interprets
 * a turn is resolved from that same session's own durable model selection.
 *
 * @module dsh-plugin-turn-insight
 */
import { configuredFallbackRoute, normalizeConfig, turnLimits } from './src/config.mjs'
import { TurnInsightError } from './src/errors.mjs'
import { runInterpretation } from './src/llm.mjs'
import { buildAnalysisPrompt, buildSystemPrompt } from './src/prompt.mjs'
import { resolveRoute } from './src/route.mjs'
import { collectTurns } from './src/turns.mjs'

export const name = 'turn-insight'

/**
 * The routes live on the shared `/api` channel, which the connection plugin
 * mounts itself, so no `webServer` dependency is declared here.
 */
export const inject = ['connection', 'sessionQuery', 'llm']

/** Exact Fetch routes, absolute below `/api`, single segment, dots allowed. */
const TURNS_PATH = '/api/turn-insight.turns'
const ANALYZE_PATH = '/api/turn-insight.analyze'

function ok(value) {
  return { ok: true, value }
}

function failure(code, message, details = {}) {
  return { ok: false, error: { code, message, details } }
}

/**
 * Read an optional Cordis service without making it a hard dependency.
 * @param ctx - the plugin context.
 * @param serviceName - registry key to look up.
 * @returns the service, or `null` when this deployment does not provide it.
 */
function optionalService(ctx, serviceName) {
  try {
    return (typeof ctx.get === 'function' ? ctx.get(serviceName) : undefined) ?? null
  } catch {
    return null
  }
}

/** Parse the request body, rejecting anything that is not a JSON object. */
async function readJson(request) {
  try {
    const value = await request.json()
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value
  } catch {
    // fall through to the explicit failure below
  }
  throw new TurnInsightError('bad-request', 'The request body must be a JSON object.')
}

function readSessionId(payload) {
  const sessionId = payload.sessionId
  if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
    throw new TurnInsightError('bad-request', 'payload.sessionId must be a non-empty string.')
  }
  return sessionId.trim()
}

function readTurn(payload) {
  const turn = payload.turn
  if (!Number.isSafeInteger(turn) || turn < 0) {
    throw new TurnInsightError('bad-request', 'payload.turn must be a non-negative integer.')
  }
  return turn
}

/**
 * Read the panel's transient prompt append.
 *
 * Absent, null, and whitespace-only all mean "use the default prompt", which is
 * what keeps an untouched box byte-identical to the pre-append behaviour.
 *
 * @param payload - the decoded request body.
 * @param settings - validated configuration supplying the length cap.
 * @returns the trimmed append, or `''`.
 * @throws {TurnInsightError} when the value is not a string or exceeds the cap.
 */
function readAppend(payload, settings) {
  const value = payload.append
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') {
    throw new TurnInsightError('bad-request', 'payload.append must be a string when present.')
  }
  const append = value.trim()
  if (append.length > settings.maxAppendChars) {
    throw new TurnInsightError(
      'bad-request',
      `payload.append must be at most ${settings.maxAppendChars} characters.`,
      { maxAppendChars: settings.maxAppendChars, received: append.length },
    )
  }
  return append
}

/** The provider/model of the session's last logged request header, when it has one. */
function loggedRequestConfig(ctx, sessionId) {
  const agents = optionalService(ctx, 'agents')
  if (agents === null || typeof agents.get !== 'function') return null
  const config = agents.get(sessionId)?.session?.requestHeader?.()?.config
  return config !== null && typeof config === 'object' ? config : null
}

/** The deployment-wide default model selection. */
function defaultSelection(ctx) {
  const service = optionalService(ctx, 'agentDefaultModel')
  if (service === null || typeof service.currentSelection !== 'function') return null
  return service.currentSelection() ?? null
}

/**
 * Fold one session into its turns plus the route its interpretation should use.
 *
 * One `observeSession` call serves both needs: it returns the exact event cut
 * and the projection baseline at that cut. The observation is a lease and is
 * always released.
 *
 * @param ctx - plugin context carrying `sessionQuery`.
 * @param settings - validated configuration.
 * @param sessionId - the session to fold.
 * @param signal - the request's cancellation signal.
 * @returns `{ turns, totalTurns, route }`.
 */
async function readSession(ctx, settings, sessionId, signal) {
  const observation = await ctx.sessionQuery.observeSession(sessionId, { signal })
  try {
    const route = resolveRoute({
      projection: observation.projections?.values?.modelSelection,
      loggedConfig: loggedRequestConfig(ctx, sessionId),
      defaultSelection: defaultSelection(ctx),
      fallback: configuredFallbackRoute(settings),
    })
    return { ...collectTurns(observation.events, turnLimits(settings)), route }
  } finally {
    observation[Symbol.dispose]?.()
  }
}

/**
 * Register the two interpretation routes.
 *
 * @param ctx - plugin context; `connection`, `sessionQuery`, and `llm` are
 *   guaranteed present by {@link inject}.
 * @param rawConfig - configuration read from `cordis.yml`.
 * @throws TypeError when the configuration is invalid or the exact-route
 *   registry is unavailable.
 */
export function apply(ctx, rawConfig = {}) {
  const settings = normalizeConfig(rawConfig)
  if (typeof ctx.connection?.fetch?.register !== 'function') {
    throw new TypeError('turn-insight: ctx.connection.fetch is unavailable in this deployment')
  }

  // A business failure stays a 200 with a structured body so the panel can
  // explain it; only the transport (admission, malformed request) is non-200.
  const respond = (body) => Response.json(body, { headers: { 'cache-control': 'no-store' } })
  const guard = async (task) => {
    try {
      return respond(ok(await task()))
    } catch (error) {
      if (error instanceof TurnInsightError) return respond(failure(error.code, error.message, error.details))
      return respond(failure('internal', error instanceof Error ? error.message : String(error), {}))
    }
  }

  // `fetch.register` scopes its own lifetime to the calling fiber; no extra
  // effect owner is needed.
  ctx.connection.fetch.register({
    path: TURNS_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: request => guard(async () => {
      const payload = await readJson(request)
      const sessionId = readSessionId(payload)
      const { turns, totalTurns, route } = await readSession(ctx, settings, sessionId, request.signal)
      return { sessionId, totalTurns, turns, route }
    }),
  })

  ctx.connection.fetch.register({
    path: ANALYZE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: request => guard(async () => {
      const payload = await readJson(request)
      const sessionId = readSessionId(payload)
      const turn = readTurn(payload)
      const append = readAppend(payload, settings)
      const { turns, route } = await readSession(ctx, settings, sessionId, request.signal)
      const target = turns.find(item => item.turn === turn)
      if (target === undefined) {
        throw new TurnInsightError('TURN_NOT_FOUND', `Turn ${turn} has no recorded tool calls in this session.`)
      }
      // The configured effort, when set, wins over the inherited session route:
      // it is the documented lever for a model that burns the whole output
      // budget on reasoning.
      const effectiveRoute = settings.reasoningEffort
        ? { ...route, reasoningEffort: settings.reasoningEffort }
        : route
      const result = await runInterpretation(ctx.llm, {
        route: effectiveRoute,
        system: buildSystemPrompt(append),
        user: buildAnalysisPrompt(target),
        maxOutputTokens: settings.maxOutputTokens,
        timeoutMs: settings.timeoutMs,
        signal: request.signal,
      })
      return { sessionId, turn, route: effectiveRoute, appendApplied: append !== '', ...result }
    }),
  })
}
