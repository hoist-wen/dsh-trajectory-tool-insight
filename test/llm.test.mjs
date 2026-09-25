import assert from 'node:assert/strict'
import { test } from 'node:test'

import { runInterpretation } from '../src/llm.mjs'

const ROUTE = Object.freeze({ provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash' })

const CALL = Object.freeze({
  route: ROUTE,
  system: 'system prompt',
  user: 'TURN_EVIDENCE_JSON_LENGTH=2\n{}',
  maxOutputTokens: 512,
  timeoutMs: 5_000,
})

function llmYielding(chunks) {
  const calls = []
  return {
    calls,
    async *stream(options) {
      calls.push(options)
      for (const chunk of chunks) yield chunk
    },
  }
}

/** A provider that never answers until its signal aborts — the timeout/abort shape. */
function hangingLlm() {
  return {
    async *stream(options) {
      await new Promise(resolve => {
        if (options.signal.aborted) {
          resolve()
          return
        }
        options.signal.addEventListener('abort', resolve, { once: true })
      })
    },
  }
}

function textStream(text) {
  return [
    { type: 'block-start', index: 0, block: { type: 'text' } },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

test('assembles visible text, usage, and the finish kind', async () => {
  const llm = llmYielding(textStream('这一轮在读取配置。'))
  const result = await runInterpretation(llm, CALL)
  assert.deepEqual(result, {
    text: '这一轮在读取配置。',
    usage: { inputTokens: 10, outputTokens: 3 },
    finish: 'stop',
    truncated: false,
  })
})

test('deltas without a terminal block-end are still assembled', async () => {
  const llm = llmYielding([
    { type: 'text-delta', index: 0, text: '前半' },
    { type: 'text-delta', index: 0, text: '后半' },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  assert.equal((await runInterpretation(llm, CALL)).text, '前半后半')
})

test('reasoning blocks never leak into the visible text', async () => {
  const llm = llmYielding([
    { type: 'reasoning-delta', index: 0, text: '内部推理' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: '内部推理' } },
    { type: 'text-delta', index: 1, text: '可见结论' },
    { type: 'block-end', index: 1, block: { type: 'text', text: '可见结论' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  assert.equal((await runInterpretation(llm, CALL)).text, '可见结论')
})

test('the request carries the resolved route, the system prompt, and an attributed plugin message', async () => {
  const llm = llmYielding(textStream('ok'))
  await runInterpretation(llm, { ...CALL, route: { ...ROUTE, reasoningEffort: 'high' } })
  const options = llm.calls[0]
  assert.equal(options.provider, 'commandcode')
  assert.equal(options.model, 'deepseek/deepseek-v4.1-flash')
  assert.equal(options.reasoningEffort, 'high')
  assert.equal(options.system, 'system prompt')
  assert.equal(options.maxTokens, 512)
  assert.ok(options.signal instanceof AbortSignal)
  assert.equal(options.messages.length, 1)
  const [message] = options.messages
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, 'plugin')
  assert.equal(message.source.plugin, 'dsh-plugin-turn-insight')
  assert.match(message.id, /^turn-insight-/u)
  assert.deepEqual(message.content, [{ type: 'text', text: CALL.user }])
})

test('an omitted reasoningEffort is not sent at all', async () => {
  const llm = llmYielding(textStream('ok'))
  await runInterpretation(llm, CALL)
  assert.equal('reasoningEffort' in llm.calls[0], false)
})

// Provider failures arrive as a terminal finish chunk, never as a throw.
for (const [kind, code] of [['error', 'RATE_LIMIT'], ['error', 'AUTH'], ['aborted', 'MODEL_ABORTED']]) {
  test(`a terminal ${kind} finish (${code}) surfaces the provider code`, async () => {
    const llm = llmYielding([
      { type: 'text-delta', index: 0, text: 'partial' },
      { type: 'finish', reason: { kind, failure: { code, message: `provider said ${code}` } } },
    ])
    await assert.rejects(runInterpretation(llm, CALL), error => {
      assert.equal(error.name, 'TurnInsightError')
      assert.equal(error.code, kind === 'aborted' ? 'MODEL_ABORTED' : code)
      assert.match(error.message, /provider said/u)
      assert.equal(error.details.usage, null)
      return true
    })
  })
}

test('a finish without a provider code still fails loudly', async () => {
  const llm = llmYielding([{ type: 'finish', reason: { kind: 'error', failure: { message: 'boom' } } }])
  await assert.rejects(runInterpretation(llm, CALL), error => error.code === 'MODEL_ERROR')
})

test('a max-tokens stop returns the partial text flagged as truncated', async () => {
  const llm = llmYielding([
    { type: 'text-delta', index: 0, text: '写到一半' },
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ])
  assert.deepEqual(await runInterpretation(llm, CALL), {
    text: '写到一半',
    usage: null,
    finish: 'max-tokens',
    truncated: true,
  })
})

test('a budget spent entirely on reasoning reports its own actionable failure', async () => {
  // The observed real-world case: finish_reason=length, outputTokens=1500,
  // reasoningTokens=1500 — the whole allowance went to reasoning and no visible
  // text was produced.
  const llm = llmYielding([
    { type: 'reasoning-delta', index: 0, text: '想了很多' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: '想了很多' } },
    { type: 'usage', usage: { outputTokens: 1_500, reasoningTokens: 1_500 } },
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ])
  await assert.rejects(runInterpretation(llm, { ...CALL, maxOutputTokens: 1_500 }), error => {
    assert.equal(error.code, 'MODEL_NO_OUTPUT')
    assert.match(error.message, /推理/u)
    assert.match(error.message, /1500/u)
    assert.equal(error.details.maxOutputTokens, 1_500)
    return true
  })
})

test('a tool call from the interpretation model is refused', async () => {
  const llm = llmYielding([
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'x', name: 'read', arguments: '{}' } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ])
  await assert.rejects(runInterpretation(llm, CALL), error => error.code === 'MODEL_TOOL_CALL')
})

test('a stop with no visible text is an explicit failure', async () => {
  const llm = llmYielding([{ type: 'finish', reason: { kind: 'stop' } }])
  await assert.rejects(runInterpretation(llm, CALL), error => error.code === 'MODEL_EMPTY_OUTPUT')
})

test('the wall-clock cap aborts the call', async () => {
  await assert.rejects(
    runInterpretation(hangingLlm(), { ...CALL, timeoutMs: 25 }),
    error => error.code === 'MODEL_TIMEOUT',
  )
})

test('a caller abort is reported as cancelled, not as a timeout', async () => {
  const controller = new AbortController()
  const promise = runInterpretation(hangingLlm(), { ...CALL, signal: controller.signal })
  setTimeout(() => controller.abort(), 5)
  await assert.rejects(promise, error => error.code === 'MODEL_ABORTED')
})

test('missing prerequisites fail before any provider call', async () => {
  await assert.rejects(runInterpretation(null, CALL), error => error.code === 'LLM_UNAVAILABLE')
  await assert.rejects(runInterpretation({}, CALL), error => error.code === 'LLM_UNAVAILABLE')
  const llm = llmYielding(textStream('never'))
  await assert.rejects(runInterpretation(llm, { ...CALL, route: null }), error => error.code === 'MODEL_NOT_CONFIGURED')
  await assert.rejects(runInterpretation(llm, { ...CALL, route: { provider: '', model: 'm' } }), error => error.code === 'MODEL_NOT_CONFIGURED')
  assert.equal(llm.calls.length, 0)
})
