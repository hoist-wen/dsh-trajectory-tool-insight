/**
 * Pure projection: a DSH session event log -> per-turn tool-call evidence.
 *
 * The raw log stays the single source of truth; this module only reads it.
 * Event vocabulary is the one the Host already commits (mirrors the shapes the
 * built-in trajectory surfaces consume):
 *
 * - `turn/start`   `{ turn }`                     — opens a turn
 * - `step/start`   `{ turn, step }`               — model request boundary
 * - `user/message` `{ content: Block[] }`         — the turn's human prompt
 * - `assistant/message` `{ turn, step, message: { content: Block[] } }`
 * - `tool/call`    `{ callId, name, arguments, turn, step }`
 * - `tool/result`  `{ message: { source: { callId }, content: [{ content: Block[], isError }] } }`
 * - `turn/end`     `{ turn, reason }`             — closes a turn
 *
 * `tool-call` blocks inside an assistant message are recorded only when no
 * canonical `tool/call` event carries the same call id, so a log that has both
 * does not double-count.
 */

/**
 * Character and count caps applied while projecting one log.
 * @typedef {object} TurnLimits
 * @property {number} maxTurns
 * @property {number} maxToolCallsPerTurn
 * @property {number} maxArgsChars
 * @property {number} maxResultChars
 * @property {number} promptChars
 * @property {number} assistantChars
 */

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function asObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function clip(value, limit) {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  if (text.length <= limit) return text
  return `${text.slice(0, Math.max(0, limit - 1))}…`
}

function blocksToText(content, limit) {
  const parts = asArray(content).flatMap(block => {
    const text = asObject(block).text
    return typeof text === 'string' && text.length > 0 ? [text] : []
  })
  return clip(parts.join('\n'), limit)
}

function safeTurnNumber(value) {
  const turn = Number(value)
  return Number.isSafeInteger(turn) && turn >= 0 ? turn : null
}

function serializeArguments(value) {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

function ensureTurn(turns, turn, event) {
  const existing = turns.get(turn)
  if (existing !== undefined) return existing
  const entry = {
    turn,
    seq: Number.isSafeInteger(event?.seq) ? event.seq : null,
    time: Number.isSafeInteger(event?.time) ? event.time : null,
    prompt: '',
    assistant: '',
    calls: [],
    byCallId: new Map(),
    dropped: 0,
    closed: false,
  }
  turns.set(turn, entry)
  return entry
}

function recordCall(entry, raw, limits, canonical) {
  const callId = clip(raw.callId, 200)
  const existing = callId ? entry.byCallId.get(callId) : undefined
  if (existing !== undefined) {
    // A canonical `tool/call` event is the authoritative record. An assistant
    // `tool-call` block seen earlier only fills the gap for logs that never
    // commit the event, so it must not keep ownership once the event arrives.
    if (canonical && !existing.canonical) {
      existing.canonical = true
      existing.name = clip(raw.name, 200) || existing.name
      existing.args = clip(serializeArguments(raw.args), limits.maxArgsChars) || existing.args
      existing.seq = Number.isSafeInteger(raw.seq) ? raw.seq : existing.seq
    }
    return
  }
  if (entry.calls.length >= limits.maxToolCallsPerTurn) {
    entry.dropped += 1
    return
  }
  const call = {
    callId,
    canonical: canonical === true,
    name: clip(raw.name, 200) || 'unknown',
    args: clip(serializeArguments(raw.args), limits.maxArgsChars),
    seq: Number.isSafeInteger(raw.seq) ? raw.seq : null,
    isError: false,
    result: '',
  }
  entry.calls.push(call)
  if (callId) entry.byCallId.set(callId, call)
}

function appendAssistantText(entry, content, limits) {
  const text = blocksToText(asArray(content).filter(block => asObject(block).type === 'text'), limits.assistantChars)
  if (!text) return
  entry.assistant = clip(entry.assistant ? `${entry.assistant}\n${text}` : text, limits.assistantChars)
}

/**
 * Project a session event log into the newest turns that carried tool calls.
 *
 * @param events - raw session events in ascending seq order.
 * @param limits - caps to apply while projecting.
 * @returns `{ turns, totalTurns }`; `turns` is ordered by ascending turn number
 *   and contains only turns with at least one recorded tool call.
 */
export function collectTurns(events, limits) {
  const turns = new Map()
  let openTurn = null

  for (const event of asArray(events)) {
    const type = asObject(event).type
    const data = asObject(event?.data)

    if (type === 'turn/start') {
      const turn = safeTurnNumber(data.turn)
      if (turn !== null) {
        ensureTurn(turns, turn, event)
        openTurn = turn
      }
      continue
    }

    if (type === 'step/start') {
      const turn = safeTurnNumber(data.turn)
      if (turn !== null) openTurn = turn
      continue
    }

    if (type === 'user/message') {
      if (openTurn === null) continue
      const entry = ensureTurn(turns, openTurn, event)
      if (!entry.prompt) entry.prompt = blocksToText(data.content, limits.promptChars)
      continue
    }

    if (type === 'assistant/message') {
      const turn = safeTurnNumber(data.turn) ?? openTurn
      if (turn === null) continue
      const entry = ensureTurn(turns, turn, event)
      const content = asArray(asObject(data.message).content)
      appendAssistantText(entry, content, limits)
      for (const block of content) {
        const call = asObject(block)
        if (call.type !== 'tool-call') continue
        recordCall(entry, { callId: call.id, name: call.name, args: call.arguments, seq: event?.seq }, limits, false)
      }
      continue
    }

    if (type === 'tool/call') {
      const turn = safeTurnNumber(data.turn) ?? openTurn
      if (turn === null) continue
      const entry = ensureTurn(turns, turn, event)
      recordCall(entry, { callId: data.callId, name: data.name, args: data.arguments, seq: event?.seq }, limits, true)
      continue
    }

    if (type === 'tool/result') {
      const message = asObject(data.message)
      const blocks = asArray(message.content)
      // `tool/result.data.message` is the tool message itself. Some carriers
      // wrap it one level deeper, so unwrap an inner `content` array when the
      // first block carries one.
      const carrier = blocks.length > 0 && Array.isArray(asObject(blocks[0]).content)
        ? asObject(blocks[0])
        : message
      const callId = clip(
        carrier.toolCallId ?? asObject(carrier.source).callId ?? asObject(message.source).callId,
        200,
      )
      const isError = carrier.isError === true || message.isError === true
      const resultText = blocksToText(carrier.content, limits.maxResultChars)
      const turn = safeTurnNumber(data.turn) ?? openTurn
      if (turn === null) continue
      const entry = ensureTurn(turns, turn, event)
      if (callId === '' || !entry.byCallId.has(callId)) {
        // A result whose call event fell outside the retained window: keep it
        // rather than dropping evidence the model would otherwise never see.
        recordCall(entry, { callId, name: 'unknown', args: '', seq: event?.seq }, limits, false)
      }
      const record = entry.byCallId.get(callId)
      if (record !== undefined) {
        record.result = resultText
        record.isError = isError
      }
      continue
    }

    if (type === 'turn/end') {
      const turn = safeTurnNumber(data.turn)
      const entry = turn === null ? turns.get(openTurn) : turns.get(turn)
      if (entry !== undefined) entry.closed = true
      if (turn === null || turn === openTurn) openTurn = null
    }
  }

  const ordered = [...turns.values()].sort((left, right) => left.turn - right.turn)
  const retained = ordered.slice(-limits.maxTurns)
  return {
    totalTurns: ordered.length,
    turns: retained.map(entry => ({
      turn: entry.turn,
      seq: entry.seq,
      time: entry.time,
      closed: entry.closed,
      prompt: entry.prompt,
      assistant: entry.assistant,
      droppedToolCalls: entry.dropped,
      toolCalls: entry.calls.map(call => ({
        callId: call.callId,
        name: call.name,
        seq: call.seq,
        args: call.args,
        result: call.result,
        isError: call.isError,
      })),
    })).filter(entry => entry.toolCalls.length > 0),
  }
}
