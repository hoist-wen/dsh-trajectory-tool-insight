import assert from 'node:assert/strict'
import { test } from 'node:test'

import { collectTurns } from '../src/turns.mjs'

const LIMITS = Object.freeze({
  maxTurns: 50,
  maxToolCallsPerTurn: 40,
  maxArgsChars: 1_200,
  maxResultChars: 1_600,
  promptChars: 400,
  assistantChars: 600,
})

function event(seq, type, data) {
  return { type, seq, time: 1_700_000_000_000 + seq, data }
}

/** A two-turn log: turn 1 reads a file, turn 2 runs two commands, one failing. */
function sampleLog() {
  return [
    event(0, 'turn/start', { turn: 1 }),
    event(1, 'user/message', { content: [{ type: 'text', text: '看看这个文件的实现' }] }),
    event(2, 'step/start', { turn: 1, step: 0 }),
    event(3, 'assistant/message', {
      turn: 1,
      step: 0,
      message: { id: 'm1', content: [{ type: 'text', text: '我先读文件。' }, { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"file_path":"a.ts"}' }] },
    }),
    event(4, 'tool/call', { turn: 1, step: 0, callId: 'c1', name: 'read', arguments: '{"file_path":"a.ts"}' }),
    event(5, 'tool/result', {
      turn: 1,
      step: 0,
      message: { source: { callId: 'c1' }, toolCallId: 'c1', content: [{ type: 'text', text: 'export const a = 1' }] },
    }),
    event(6, 'turn/end', { turn: 1, reason: { kind: 'stop' } }),
    event(7, 'turn/start', { turn: 2 }),
    event(8, 'user/message', { content: [{ type: 'text', text: '跑一下测试' }] }),
    event(9, 'step/start', { turn: 2, step: 0 }),
    event(10, 'tool/call', { turn: 2, step: 0, callId: 'c2', name: 'pwsh', arguments: '{"command":"npm test"}' }),
    event(11, 'tool/result', {
      turn: 2,
      step: 0,
      message: { source: { callId: 'c2' }, toolCallId: 'c2', content: [{ type: 'text', text: '2 passing' }] },
    }),
    event(12, 'tool/call', { turn: 2, step: 1, callId: 'c3', name: 'grep', arguments: '{"pattern":"TODO"}' }),
    event(13, 'tool/result', {
      turn: 2,
      step: 1,
      message: { source: { callId: 'c3' }, toolCallId: 'c3', isError: true, content: [{ type: 'text', text: 'no such directory' }] },
    }),
    event(14, 'turn/end', { turn: 2, reason: { kind: 'stop' } }),
  ]
}

test('groups tool calls by turn and pairs each call with its result', () => {
  const { turns, totalTurns } = collectTurns(sampleLog(), LIMITS)
  assert.equal(totalTurns, 2)
  assert.deepEqual(turns.map(turn => turn.turn), [1, 2])

  const [first, second] = turns
  assert.equal(first.prompt, '看看这个文件的实现')
  assert.equal(first.assistant, '我先读文件。')
  assert.equal(first.closed, true)
  assert.deepEqual(first.toolCalls, [{
    callId: 'c1',
    name: 'read',
    seq: 4,
    args: '{"file_path":"a.ts"}',
    result: 'export const a = 1',
    isError: false,
  }])

  assert.deepEqual(second.toolCalls.map(call => call.name), ['pwsh', 'grep'])
  assert.equal(second.toolCalls[0].result, '2 passing')
  assert.equal(second.toolCalls[0].isError, false)
  assert.equal(second.toolCalls[1].result, 'no such directory')
  assert.equal(second.toolCalls[1].isError, true)
})

test('a tool call recorded as an assistant block and as a tool/call event counts once', () => {
  const { turns } = collectTurns(sampleLog(), LIMITS)
  assert.equal(turns[0].toolCalls.length, 1)
})

test('turns without tool calls are reported by count but not returned', () => {
  const log = [
    event(0, 'turn/start', { turn: 1 }),
    event(1, 'user/message', { content: [{ type: 'text', text: '只回答，不用工具' }] }),
    event(2, 'assistant/message', { turn: 1, step: 0, message: { content: [{ type: 'text', text: '好的' }] } }),
    event(3, 'turn/end', { turn: 1, reason: { kind: 'stop' } }),
  ]
  const { turns, totalTurns } = collectTurns(log, LIMITS)
  assert.equal(totalTurns, 1)
  assert.deepEqual(turns, [])
})

test('a tool result whose call event is missing still yields one readable entry', () => {
  const log = [
    event(0, 'turn/start', { turn: 4 }),
    event(1, 'tool/result', {
      turn: 4,
      step: 0,
      message: { source: { callId: 'orphan' }, toolCallId: 'orphan', content: [{ type: 'text', text: 'late output' }] },
    }),
  ]
  const { turns } = collectTurns(log, LIMITS)
  assert.equal(turns.length, 1)
  assert.deepEqual(turns[0].toolCalls, [{
    callId: 'orphan',
    name: 'unknown',
    seq: 1,
    args: '',
    result: 'late output',
    isError: false,
  }])
})

test('the per-turn cap drops overflow and reports the count', () => {
  const log = [event(0, 'turn/start', { turn: 1 })]
  for (let index = 0; index < 5; index += 1) {
    log.push(event(1 + index, 'tool/call', { turn: 1, step: 0, callId: `c${index}`, name: 'read', arguments: '{}' }))
  }
  const { turns } = collectTurns(log, { ...LIMITS, maxToolCallsPerTurn: 2 })
  assert.equal(turns[0].toolCalls.length, 2)
  assert.equal(turns[0].droppedToolCalls, 3)
})

test('only the newest maxTurns survive, and totalTurns still counts the log', () => {
  const log = []
  let seq = 0
  for (let turn = 1; turn <= 6; turn += 1) {
    log.push(event(seq++, 'turn/start', { turn }))
    log.push(event(seq++, 'tool/call', { turn, step: 0, callId: `c${turn}`, name: 'read', arguments: '{}' }))
    log.push(event(seq++, 'turn/end', { turn, reason: { kind: 'stop' } }))
  }
  const { turns, totalTurns } = collectTurns(log, { ...LIMITS, maxTurns: 2 })
  assert.equal(totalTurns, 6)
  assert.deepEqual(turns.map(turn => turn.turn), [5, 6])
})

test('long arguments and results are clipped, and non-string arguments are serialized', () => {
  const log = [
    event(0, 'turn/start', { turn: 1 }),
    event(1, 'tool/call', { turn: 1, step: 0, callId: 'c1', name: 'pwsh', arguments: { command: 'x'.repeat(400) } }),
    event(2, 'tool/result', {
      turn: 1,
      step: 0,
      message: { source: { callId: 'c1' }, toolCallId: 'c1', content: [{ type: 'text', text: 'y'.repeat(400) }] },
    }),
  ]
  const { turns } = collectTurns(log, { ...LIMITS, maxArgsChars: 80, maxResultChars: 80 })
  assert.equal(turns[0].toolCalls[0].args.length, 80)
  assert.ok(turns[0].toolCalls[0].args.endsWith('…'))
  assert.ok(turns[0].toolCalls[0].args.startsWith('{"command":"xxx'))
  assert.equal(turns[0].toolCalls[0].result.length, 80)
})

test('a malformed log projects to empty output instead of throwing', () => {
  assert.deepEqual(collectTurns(undefined, LIMITS), { totalTurns: 0, turns: [] })
  assert.deepEqual(collectTurns([null, 3, 'x', {}], LIMITS), { totalTurns: 0, turns: [] })
})

test('a call is attributed to the open turn when its own event omits the turn', () => {
  const log = [
    event(0, 'turn/start', { turn: 7 }),
    event(1, 'tool/call', { step: 0, callId: 'c1', name: 'read', arguments: '{}' }),
  ]
  const { turns } = collectTurns(log, LIMITS)
  assert.equal(turns[0].turn, 7)
})
