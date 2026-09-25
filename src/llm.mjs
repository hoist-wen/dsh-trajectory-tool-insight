/**
 * One auxiliary completion over `ctx.llm.stream`.
 *
 * Two host semantics drive the shape of this module:
 *
 * 1. `ctx.llm` has no non-streaming entry point, so an interpretation always
 *    consumes the chunk stream.
 * 2. Adapter selection, dispatch, and iteration failures are normalized into a
 *    terminal `finish` chunk of kind `error`/`aborted` — they do **not** throw.
 *    Provider failures are therefore read off `finish`, never off a `catch`.
 *
 * The assembly below implements the documented chunk protocol directly
 * (`block-start | text-delta | reasoning-delta | tool-call-delta | block-end |
 * usage | finish`; `usage` always precedes `finish`, and nothing follows
 * `finish`) instead of importing `BlockAssembler`, which keeps this package
 * free of runtime dependencies.
 */
import { randomUUID } from 'node:crypto'
import { TurnInsightError } from './errors.mjs'

/** Attribution recorded on the auxiliary request. */
const PLUGIN_ID = 'dsh-plugin-turn-insight'

function createDeadline(parent, timeoutMs) {
  const controller = new AbortController()
  let timedOut = false
  const forward = () => controller.abort(parent?.reason)
  if (parent?.aborted) forward()
  else parent?.addEventListener?.('abort', forward, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new Error('turn-insight: interpretation timed out'))
  }, timeoutMs)
  return {
    signal: controller.signal,
    get timedOut() { return timedOut },
    dispose() {
      clearTimeout(timer)
      parent?.removeEventListener?.('abort', forward)
    },
  }
}

function newAssembler() {
  const deltas = new Map()
  const finals = new Map()
  let usage = null
  let reason = null
  return {
    push(chunk) {
      if (chunk === null || typeof chunk !== 'object') return
      if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
        const current = deltas.get(chunk.index) ?? { type: chunk.type === 'text-delta' ? 'text' : 'reasoning', text: '' }
        current.text += String(chunk.text ?? '')
        deltas.set(chunk.index, current)
      } else if (chunk.type === 'block-end') {
        finals.set(chunk.index, chunk.block)
      } else if (chunk.type === 'usage') {
        usage = chunk.usage ?? null
      } else if (chunk.type === 'finish') {
        reason = chunk.reason ?? null
      }
    },
    get reason() { return reason },
    get usage() { return usage },
    read() {
      const indexes = [...new Set([...deltas.keys(), ...finals.keys()])]
        .filter(index => Number.isSafeInteger(index))
        .sort((left, right) => left - right)
      const blocks = indexes.flatMap(index => {
        const final = finals.get(index)
        if (final !== null && typeof final === 'object') return [final]
        const delta = deltas.get(index)
        return delta === undefined ? [] : [{ type: delta.type, text: delta.text }]
      })
      const text = blocks
        .filter(block => block.type === 'text' && typeof block.text === 'string')
        .map(block => block.text)
        .join('\n')
        .trim()
      return { blocks, text, toolCallCount: blocks.filter(block => block.type === 'tool-call').length }
    },
  }
}

/**
 * Run one interpretation call and return its visible text.
 *
 * @param llm - the `ctx.llm` service.
 * @param request - the call to make.
 * @param request.route - resolved `{ provider, model, reasoningEffort? }`.
 * @param request.system - the system prompt.
 * @param request.user - the untrusted evidence envelope.
 * @param request.maxOutputTokens - output cap.
 * @param request.timeoutMs - wall-clock cap.
 * @param request.signal - caller cancellation, forwarded to the provider.
 * @returns `{ text, usage, finish, truncated }`.
 * @throws {TurnInsightError} for every provider or shape failure.
 */
export async function runInterpretation(llm, { route, system, user, maxOutputTokens, timeoutMs, signal }) {
  if (llm === null || typeof llm !== 'object' || typeof llm.stream !== 'function') {
    throw new TurnInsightError('LLM_UNAVAILABLE', 'The DSH llm service is unavailable in this deployment.')
  }
  if (!route?.provider || !route?.model) {
    throw new TurnInsightError('MODEL_NOT_CONFIGURED', 'No model route could be resolved for this session.')
  }

  const deadline = createDeadline(signal, timeoutMs)
  const assembler = newAssembler()
  try {
    const options = {
      provider: route.provider,
      model: route.model,
      ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}),
      messages: [{
        id: `turn-insight-${randomUUID()}`,
        role: 'user',
        source: { kind: 'plugin', plugin: PLUGIN_ID },
        content: [{ type: 'text', text: user }],
      }],
      system,
      maxTokens: maxOutputTokens,
      signal: deadline.signal,
    }
    for await (const chunk of llm.stream(options)) {
      assembler.push(chunk)
      if (assembler.reason !== null) break
    }

    if (deadline.signal.aborted) {
      const timedOut = deadline.timedOut && signal?.aborted !== true
      throw new TurnInsightError(
        timedOut ? 'MODEL_TIMEOUT' : 'MODEL_ABORTED',
        timedOut ? 'The interpretation call timed out.' : 'The interpretation call was cancelled.',
        { usage: assembler.usage },
      )
    }

    const finish = assembler.reason
    const kind = typeof finish?.kind === 'string' ? finish.kind : 'stop'
    if (kind === 'error' || kind === 'aborted') {
      throw new TurnInsightError(
        typeof finish?.failure?.code === 'string' && finish.failure.code ? finish.failure.code : 'MODEL_ERROR',
        finish?.failure?.message ?? 'The interpretation model call failed.',
        { usage: assembler.usage, finish: kind },
      )
    }

    const { text, toolCallCount } = assembler.read()
    if (toolCallCount > 0) {
      throw new TurnInsightError('MODEL_TOOL_CALL', 'The interpretation model attempted a tool call.', {
        usage: assembler.usage,
        finish: kind,
      })
    }
    const truncated = kind === 'max-tokens'
    if (!text) {
      // A reasoning model can spend the whole output budget on reasoning and
      // never emit an answer. That is a configuration problem, not an empty
      // response, so it gets its own code and an actionable message.
      if (truncated) {
        throw new TurnInsightError(
          'MODEL_NO_OUTPUT',
          `模型把全部 ${maxOutputTokens} token 输出预算用在了推理上，没有产出正文。`
          + '该预算是「推理 + 正文」的合计上限，无法把推理排除在外；'
          + '请调大 maxOutputTokens，或把 reasoningEffort 调低。',
          { usage: assembler.usage, finish: kind, maxOutputTokens },
        )
      }
      throw new TurnInsightError('MODEL_EMPTY_OUTPUT', 'The interpretation model returned no visible text.', {
        usage: assembler.usage,
        finish: kind,
      })
    }
    return { text, usage: assembler.usage, finish: kind, truncated }
  } finally {
    deadline.dispose()
  }
}
