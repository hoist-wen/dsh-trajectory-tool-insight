/**
 * Loads the authored browser bundle the way the Web Client does — one script
 * registering one factory — and exercises its registration and RPC surface
 * against stubs. This is the guard the previous generation of this plugin
 * lacked: it fails when the bundle only *looks* right but cannot boot.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const PACKAGE_NAME = '@hoist-wen/dsh-trajectory-tool-insight'
const SOURCE = await readFile(new URL('../client.js', import.meta.url), 'utf8')

function createReactStub(stateSeeds = []) {
  let stateIndex = 0
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useRef: value => ({ current: value }),
    useState: initial => {
      const seed = stateSeeds[stateIndex]
      stateIndex += 1
      return [seed === undefined ? (typeof initial === 'function' ? initial() : initial) : seed, () => {}]
    },
    useEffect: () => {},
    useCallback: fn => fn,
  }
}

function createDocumentStub() {
  const appended = []
  return {
    appended,
    head: { appendChild: node => { appended.push(node) } },
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
  }
}

/** What the browser does: execute the script, then materialize the factory. */
function loadBundle({ stateSeeds = [], respond } = {}) {
  let registration = null
  const window = { __ModuleLoader__: { load: value => { registration = value } } }
  const document = createDocumentStub()
  const calls = []
  const answer = typeof respond === 'function' ? respond : async () => ({ ok: true, value: {} })
  const fetch = async (url, init) => {
    const body = init?.body === undefined ? undefined : JSON.parse(init.body)
    calls.push({ url, method: init?.method, headers: init?.headers, body, signal: init?.signal })
    const result = await answer({ url, body })
    if (result instanceof Response) return result
    return Response.json(result)
  }
  new Function('window', 'document', 'fetch', SOURCE)(window, document, fetch)
  assert.ok(registration !== null, 'the bundle registers itself through window.__ModuleLoader__.load')
  const requested = []
  const exports = registration.factory(specifier => {
    requested.push(specifier)
    if (specifier === 'react') return createReactStub(stateSeeds)
    throw new Error(`unexpected module request: ${specifier}`)
  })
  return { registration, exports, requested, document, calls }
}

function createContextStub() {
  const state = { effects: [], injectKey: null, injection: null, registration: null }
  const ctx = {
    effect: (body, label) => {
      state.effects.push({ disposer: body(), label })
      return () => {}
    },
    slots: {
      inject: (key, callback) => {
        state.injectKey = key
        state.injection = callback
        return () => {}
      },
      register: (options, component) => {
        state.registration = { options, component }
        return () => {}
      },
    },
  }
  return { ctx, state }
}

/**
 * `apply`, then the injection the slot runtime performs once
 * `conversation.view` is declared — which is what actually registers the tab.
 */
function mount({ stateSeeds = [], respond } = {}) {
  const bundle = loadBundle({ stateSeeds, respond })
  const { ctx, state } = createContextStub()
  bundle.exports.apply(ctx)
  state.injection()
  return { ...bundle, state }
}

function collectText(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out)
    return out
  }
  if (typeof node === 'object' && 'type' in node) {
    for (const child of node.children) collectText(child, out)
  }
  return out
}

function collectElements(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) collectElements(child, out)
    return out
  }
  if ('type' in node) {
    out.push(node)
    for (const child of node.children) collectElements(child, out)
  }
  return out
}

function renderTree(state, sessionId) {
  const { options, component } = state.registration
  const props = { sessionId, api: options.inject(sessionId).api }
  return component(props)
}

function renderView(state, sessionId) {
  return collectText(renderTree(state, sessionId)).join(' ')
}

test('the bundle registers under its own package name', () => {
  const { registration } = loadBundle()
  assert.equal(registration.id, PACKAGE_NAME)
  assert.equal(typeof registration.factory, 'function')
  assert.equal(registration.chunk, undefined)
})

test('the materialized module exports the client plugin contract', () => {
  const { exports, requested } = loadBundle()
  assert.equal(exports.name, 'trajectory-tool-insight')
  // The view ring is the only service dependency: requests are same-origin
  // `fetch` calls to `/api`, not client Connection RPC.
  assert.deepEqual(exports.inject, ['slots'])
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual(requested, ['react'])
})

test('apply claims exactly one conversation.view tab beside 轨迹', () => {
  const { state } = mount()

  assert.equal(state.injectKey, 'conversation.view')
  assert.deepEqual(state.effects.map(effect => effect.label), ['trajectory-tool-insight: styles'])
  assert.equal(typeof state.effects[0].disposer, 'function')

  const { options, component } = state.registration
  assert.equal(options.name, 'conversation.view')
  assert.equal(options.id, 'trajectory-tool-insight')
  assert.equal(options.order, 20)
  assert.equal(options.label(), '解读')
  assert.equal(typeof component, 'function')
  // "trajectory" is the only id the Coding Tools switch hides.
  assert.notEqual(options.id, 'trajectory')
})

test('the injected face is session-addressed and posts to the exact /api routes', async () => {
  const { state, calls } = mount()
  const face = state.registration.options.inject('session-42')

  assert.deepEqual(Object.keys(face), ['api'])
  await face.api.listTurns(undefined)
  await face.api.analyzeTurn(7, undefined)

  assert.deepEqual(calls.map(call => [call.method, call.url, call.body]), [
    ['POST', '/api/trajectory-tool-insight.turns', { sessionId: 'session-42' }],
    ['POST', '/api/trajectory-tool-insight.analyze', { sessionId: 'session-42', turn: 7 }],
  ])
  assert.equal(calls[0].headers['content-type'], 'application/json')
})

test('an empty append is omitted from the analyze request entirely', async () => {
  const { state, calls } = mount()
  const face = state.registration.options.inject('session-1')

  await face.api.analyzeTurn(3, '')
  await face.api.analyzeTurn(3, undefined)

  for (const call of calls) {
    assert.deepEqual(call.body, { sessionId: 'session-1', turn: 3 })
    assert.ok(!('append' in call.body))
  }
})

test('a non-empty append rides along with the analyze request', async () => {
  const { state, calls } = mount()
  const face = state.registration.options.inject('session-1')

  await face.api.analyzeTurn(3, '只看风险')

  assert.deepEqual(calls[0].body, { sessionId: 'session-1', turn: 3, append: '只看风险' })
})

test('a structured host failure becomes a coded Error the panel can explain', async () => {
  const { state } = mount({
    respond: async () => ({ ok: false, error: { code: 'MODEL_NOT_CONFIGURED', message: 'no route', details: {} } }),
  })
  const face = state.registration.options.inject('session-1')

  await assert.rejects(face.api.listTurns(), error => {
    assert.equal(error.code, 'MODEL_NOT_CONFIGURED')
    assert.equal(error.message, 'no route')
    return true
  })
})

test('a non-2xx answer is reported with its status', async () => {
  const { state } = mount({ respond: async () => new Response('unauthorized', { status: 401 }) })
  const face = state.registration.options.inject('session-1')

  await assert.rejects(face.api.listTurns(), error => {
    assert.equal(error.code, 'http-401')
    assert.match(error.message, /HTTP 401/u)
    return true
  })
})

test('a 200 body that is not the expected envelope still surfaces a readable failure', async () => {
  const { state } = mount({
    respond: async () => new Response(JSON.stringify({ nope: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  })
  const face = state.registration.options.inject('session-1')

  await assert.rejects(face.api.listTurns(), /轨迹工具调用解读请求失败/u)
})

test('the view renders its loading state without throwing', () => {
  const { state } = mount()
  const text = renderView(state, 'session-1')
  assert.match(text, /轨迹工具调用解读/u)
  assert.match(text, /正在读取会话轨迹/u)
})

test('the view renders per-turn tool calls and the returned interpretation', () => {
  const listing = {
    status: 'ready',
    totalTurns: 4,
    route: { provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash', source: 'session' },
    turns: [{
      turn: 3,
      prompt: '去修一下这个 bug',
      assistant: '先复现。',
      droppedToolCalls: 0,
      toolCalls: [
        { callId: 'c1', name: 'read', args: '{"file_path":"a.ts"}', result: 'ok', isError: false },
        { callId: 'c2', name: 'grep', args: '{"pattern":"TODO"}', result: 'boom', isError: true },
      ],
    }],
    error: null,
  }
  const analyses = new Map([[3, {
    status: 'ready',
    text: '**这一轮在做什么**：定位并复现缺陷。',
    route: { provider: 'commandcode', model: 'flash' },
    truncated: false,
  }]])

  const text = renderView(mount({ stateSeeds: [listing, analyses, 0] }).state, 'session-1')
  assert.match(text, /共 4 轮轨迹 · 可解读 1 轮/u)
  assert.match(text, /当前会话 · deepseek\/deepseek-v4\.1-flash/u)
  assert.match(text, /第 3 轮/u)
  assert.match(text, /2 次工具调用 · 1 次失败/u)
  assert.match(text, /去修一下这个 bug/u)
  assert.match(text, /重新分析/u)
  assert.match(text, /这一轮在做什么/u)
})

test('the panel summarizes a turn with counts instead of listing tool details', () => {
  const listing = {
    status: 'ready',
    totalTurns: 1,
    route: null,
    error: null,
    turns: [{
      turn: 5,
      prompt: '跑测试',
      droppedToolCalls: 3,
      toolCalls: [
        { callId: 'c1', name: 'read', args: '{"file_path":"secret-path.ts"}', result: 'secret-output', isError: false },
        { callId: 'c2', name: 'grep', args: '{"pattern":"SECRET_PATTERN"}', result: 'boom', isError: true },
      ],
    }],
  }
  const text = renderView(mount({ stateSeeds: [listing] }).state, 's')

  assert.match(text, /2 次工具调用 · 1 次失败 · 另有 3 次未纳入/u)
  // Neither the tool names nor their arguments/results may leak into the panel.
  for (const leak of ['read', 'grep', 'secret-path.ts', 'SECRET_PATTERN', 'secret-output', 'file_path']) {
    assert.ok(!text.includes(leak), `panel must not render "${leak}"`)
  }
})

test('a truncated interpretation is flagged in the panel', () => {
  const listing = { status: 'ready', totalTurns: 1, route: null, error: null, turns: [{ turn: 1, prompt: '', toolCalls: [{ callId: 'c', name: 'read', args: '', isError: false }] }] }
  const analyses = new Map([[1, { status: 'ready', text: '一半', route: null, truncated: true }]])
  const text = renderView(mount({ stateSeeds: [listing, analyses, 0] }).state, 's')
  assert.match(text, /输出被 maxTokens 截断/u)
})

test('the view degrades to a message when no turn has tool calls', () => {
  const text = renderView(mount({ stateSeeds: [{ status: 'ready', totalTurns: 2, route: null, turns: [], error: null }] }).state, 's')
  assert.match(text, /还没有带工具调用的轮次/u)
  assert.match(text, /未确定模型/u)
})

test('the view reports a listing failure with its code and hint', () => {
  const listing = {
    status: 'error',
    totalTurns: 0,
    turns: [],
    route: null,
    error: { code: 'MODEL_NOT_CONFIGURED', message: 'no route', hint: '请先选一次模型。' },
  }
  const text = renderView(mount({ stateSeeds: [listing] }).state, 's')
  assert.match(text, /no route/u)
  assert.match(text, /请先选一次模型/u)
  assert.match(text, /MODEL_NOT_CONFIGURED/u)
})

test('the view asks for a session first when it has none', () => {
  const text = renderView(mount().state, '')
  assert.match(text, /请先打开一个会话/u)
})

test('the panel offers an empty append box whose note says empty means default', () => {
  const state = mount().state
  const tree = renderTree(state, 'session-1')
  const text = collectText(tree).join(' ')

  assert.match(text, /附加提示词（可选）/u)
  assert.match(text, /留空 = 默认提示词/u)

  const textarea = collectElements(tree).find(element => element.type === 'textarea')
  assert.ok(textarea, 'the panel renders a textarea')
  assert.equal(textarea.props.value, '')
  assert.equal(typeof textarea.props.onChange, 'function')
})

test('a typed append is shown with its length and is what analyze sends', async () => {
  const typed = '  只看风险，不要复述过程。 '
  const listing = { status: 'ready', totalTurns: 1, route: null, error: null, turns: [] }
  const { state, calls } = mount({ stateSeeds: [listing, new Map(), 0, typed] })
  const tree = renderTree(state, 'session-1')
  const text = collectText(tree).join(' ')

  assert.match(text, new RegExp(`将附加 ${typed.trim().length} 个字符到解读提示词`, 'u'))
  assert.ok(!text.includes('留空 = 默认提示词'))

  const textarea = collectElements(tree).find(element => element.type === 'textarea')
  assert.equal(textarea.props.value, typed)

  // Exactly what the analyze button sends: trimmed, and only then.
  await state.registration.options.inject('session-1').api.analyzeTurn(1, textarea.props.value.trim())
  assert.deepEqual(calls[0].body, { sessionId: 'session-1', turn: 1, append: typed.trim() })
})

test('the append note survives a remount for its own session only', () => {
  // The bundle factory runs once per page, so the module-level store lives as
  // long as the page: a note typed before tabbing away is still there on the
  // way back, and never leaks into another session's panel.
  const { state } = mount({ stateSeeds: [{ status: 'ready', totalTurns: 0, route: null, error: null, turns: [] }, new Map(), 0, ''] })
  const textareaOf = sessionId => collectElements(renderTree(state, sessionId))
    .find(element => element.type === 'textarea')

  assert.equal(textareaOf('session-9').props.value, '')
  textareaOf('session-9').props.onChange({ target: { value: '  记住我  ' } })

  // Remount (the stub consumes no further seeds, so the initializer re-reads).
  // The raw value is kept, not a trimmed copy, so what is in the box is what
  // comes back.
  assert.equal(textareaOf('session-9').props.value, '  记住我  ')
  assert.equal(textareaOf('session-other').props.value, '')
})
