import assert from 'node:assert/strict'
import { test } from 'node:test'

import { SYSTEM_PROMPT, buildAnalysisPrompt } from '../src/prompt.mjs'

const TURN = Object.freeze({
  turn: 3,
  prompt: '跑一下测试',
  assistant: '先看配置。',
  droppedToolCalls: 0,
  toolCalls: [
    { callId: 'c1', name: 'read', args: '{"file_path":"a.ts"}', result: 'export const a = 1', isError: false },
    { callId: 'c2', name: 'grep', args: '{"pattern":"TODO"}', result: 'no such directory', isError: true },
  ],
})

test('the evidence envelope is length-marked JSON behind the untrusted boundary', () => {
  const prompt = buildAnalysisPrompt(TURN)
  const marker = /^TURN_EVIDENCE_JSON_LENGTH=(\d+)\n/u.exec(prompt)
  assert.ok(marker, 'the length marker is the first line')
  const json = prompt.slice(marker[0].length)
  assert.equal(Number(marker[1]), json.length)
  assert.deepEqual(JSON.parse(json), {
    turn: 3,
    userRequest: '跑一下测试',
    assistantNotes: '先看配置。',
    truncatedToolCalls: null,
    toolCalls: [
      { name: 'read', failed: false, arguments: '{"file_path":"a.ts"}', result: 'export const a = 1' },
      { name: 'grep', failed: true, arguments: '{"pattern":"TODO"}', result: 'no such directory' },
    ],
  })
})

test('an empty prompt and notes serialize as null rather than empty strings', () => {
  const parsed = JSON.parse(buildAnalysisPrompt({ turn: 1, prompt: '', assistant: '', droppedToolCalls: 0, toolCalls: [] }).split('\n').slice(1).join('\n'))
  assert.equal(parsed.userRequest, null)
  assert.equal(parsed.assistantNotes, null)
  assert.deepEqual(parsed.toolCalls, [])
})

test('dropped tool calls are surfaced to the model', () => {
  const parsed = JSON.parse(buildAnalysisPrompt({ ...TURN, droppedToolCalls: 7 }).split('\n').slice(1).join('\n'))
  assert.equal(parsed.truncatedToolCalls, 7)
})

test('the system prompt fixes the untrusted boundary and demands the four sections', () => {
  assert.match(SYSTEM_PROMPT, /TURN_EVIDENCE_JSON_LENGTH=/u)
  assert.match(SYSTEM_PROMPT, /不可信/u)
  assert.match(SYSTEM_PROMPT, /不调用工具/u)
  for (const section of ['这一轮在做什么', '工具调用逐条解读', '判断', '下一步']) {
    assert.ok(SYSTEM_PROMPT.includes(section), `system prompt names the "${section}" section`)
  }
})
