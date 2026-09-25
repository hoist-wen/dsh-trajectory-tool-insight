/**
 * Manifest and packaging guards: the facts the Web Client and the profile
 * launcher read before any of this plugin's code runs.
 */
import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { test } from 'node:test'

const root = new URL('../', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
const clientSource = await readFile(new URL('client.js', root), 'utf8')
const hostSource = await readFile(new URL('index.js', root), 'utf8')
const patchSource = await readFile(new URL('cordis.patch.yml', root), 'utf8')

/** The shell's static module table: everything a bundle may require synchronously. */
const PLATFORM_SEED_TABLE = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
])

async function exists(relative) {
  await access(new URL(relative, root))
  return true
}

test('every path the manifest advertises exists in the package', async () => {
  assert.equal(manifest.type, 'module')
  await exists(manifest.main)
  await exists(manifest.exports['./client'])
  await exists(manifest.exports['./cordis.patch.yml'])
  await exists(manifest.dsh.bundle.patch)
  for (const entry of manifest.files) await exists(entry)
})

test('the client declaration is what client-modules requires', () => {
  assert.equal(manifest.dsh.manifestVersion, 1)
  assert.equal(manifest.dsh.client.platform, 'web')
  // client-modules throws when dsh.client is declared without exports["./client"].
  assert.equal(typeof manifest.exports['./client'], 'string')
  for (const dependency of manifest.dsh.client.inject ?? []) {
    assert.match(dependency, /^@deepseek-ai\/dsh-client-/u)
  }
})

test('the plugin is dependency-free and free of DSH runtime imports', () => {
  assert.equal(manifest.dependencies, undefined)
  assert.equal(manifest.peerDependencies, undefined)
  assert.doesNotMatch(hostSource, /from\s+'@deepseek-ai\//u)
  const imported = [...hostSource.matchAll(/from\s+'([^']+)'/gu)].map(match => match[1])
  for (const specifier of imported) {
    assert.ok(specifier.startsWith('./') || specifier.startsWith('node:'), `unexpected import ${specifier}`)
  }
})

test('the bundle requests only modules the shell already has', () => {
  const requested = [...clientSource.matchAll(/require\(\s*'([^']+)'\s*\)/gu)].map(match => match[1])
  assert.ok(requested.length > 0, 'the bundle requires React')
  for (const specifier of requested) {
    assert.ok(PLATFORM_SEED_TABLE.has(specifier), `"${specifier}" is not in the platform seed table`)
  }
  assert.doesNotMatch(clientSource, /^\s*(?:import|export)\s/mu, 'the bundle is a plain script, not a module')
})

test('the bundle id is the package name, as the module loader requires', () => {
  assert.match(clientSource, new RegExp(`id:\\s*'${manifest.name.replace('.', '\\.')}'`, 'u'))
})

test('the bundle patch inserts this package as a loader row', () => {
  assert.match(patchSource, /- insert:/u)
  assert.ok(patchSource.includes(`name: ${manifest.name}`), 'the inserted row names this package')
  assert.match(patchSource, /- id: turn-insight/u)
})

test('the host entry exports the Cordis plugin contract', async () => {
  const host = await import(new URL('index.js', root))
  assert.equal(host.name, 'turn-insight')
  assert.equal(typeof host.apply, 'function')
  // `connection` carries the shared `/api` exact-route registry; the other two
  // are the required data sources. `agents` and `agentDefaultModel` are
  // optional and looked up lazily.
  assert.deepEqual(host.inject, ['connection', 'sessionQuery', 'llm'])
})

test('routes are registered as exact /api Fetch routes, never through rpc.handle', () => {
  // Regression guard. `connection.rpc.handle` mounts its route with
  // `owner.effect(() => owner.webServer.register(route))`, and the context
  // Cordis binds as `owner` is not this plugin's inject scope — declaring
  // `webServer` in `inject` does not satisfy it, so apply() throws
  // "cannot get property \"webServer\" without inject" and the browser sees an
  // HTTP 405 from the fallback route while the client tab still renders.
  // `connection.fetch.register` touches no such property.
  assert.doesNotMatch(hostSource, /rpc\.handle\(/u)
  assert.match(hostSource, /connection\.fetch\.register\(/u)
})

test('a bad configuration fails the load instead of registering routes', async () => {
  const host = await import(new URL('index.js', root))
  let registrations = 0
  const ctx = {
    connection: { fetch: { register: () => { registrations += 1; return () => {} } } },
  }
  assert.throws(() => host.apply(ctx, { nope: true }), /unknown config "nope"/u)
  assert.equal(registrations, 0)

  assert.throws(
    () => host.apply({ connection: {} }, {}),
    /ctx\.connection\.fetch is unavailable/u,
  )
})

test('a valid configuration registers exactly the two documented routes', async () => {
  const host = await import(new URL('index.js', root))
  const routes = []
  const ctx = {
    get: () => undefined,
    connection: { fetch: { register: route => { routes.push(route); return () => {} } } },
  }
  host.apply(ctx, { maxTurns: 7, defaultProvider: 'p', defaultModel: 'm' })

  assert.deepEqual(routes.map(route => [route.path, route.methods, route.requestBody]), [
    ['/api/turn-insight.turns', ['POST'], 'buffered'],
    ['/api/turn-insight.analyze', ['POST'], 'buffered'],
  ])
  for (const route of routes) assert.equal(typeof route.fetch, 'function')
})

/** Minimal stand-in for the Fetch route's `Request`. */
function request(body) {
  return {
    signal: new AbortController().signal,
    json: async () => {
      if (body === undefined) throw new SyntaxError('Unexpected end of JSON input')
      if (typeof body === 'string') throw new SyntaxError('Unexpected token')
      return body
    },
  }
}

/** Apply the plugin on a minimal context, then call one registered route. */
async function callRoute(host, path, body, extra = {}) {
  const routes = []
  host.apply({
    get: () => undefined,
    ...extra,
    connection: { fetch: { register: route => { routes.push(route); return () => {} } } },
  }, {})
  const route = routes.find(candidate => candidate.path === path)
  assert.ok(route, `${path} is registered`)
  return (await route.fetch(request(body))).json()
}

test('malformed requests answer structurally instead of throwing', async () => {
  const host = await import(new URL('index.js', root))

  const missingBody = await callRoute(host, '/api/turn-insight.turns', undefined)
  assert.equal(missingBody.ok, false)
  assert.equal(missingBody.error.code, 'bad-request')
  assert.match(missingBody.error.message, /JSON object/u)

  const notAnObject = await callRoute(host, '/api/turn-insight.turns', 'nope')
  assert.equal(notAnObject.ok, false)
  assert.equal(notAnObject.error.code, 'bad-request')

  const noSession = await callRoute(host, '/api/turn-insight.turns', {})
  assert.equal(noSession.ok, false)
  assert.match(noSession.error.message, /sessionId/u)

  const badTurn = await callRoute(host, '/api/turn-insight.analyze', { sessionId: 's' })
  assert.equal(badTurn.ok, false)
  assert.match(badTurn.error.message, /turn/u)
})

test('a failing session read becomes an internal failure, not an unhandled rejection', async () => {
  const host = await import(new URL('index.js', root))
  const answer = await callRoute(host, '/api/turn-insight.turns', { sessionId: 's-1' }, {
    sessionQuery: { observeSession: async () => { throw new Error('session is gone') } },
  })
  assert.equal(answer.ok, false)
  assert.equal(answer.error.code, 'internal')
  assert.match(answer.error.message, /session is gone/u)
})

/** One turn carrying one tool call, plus a readable model selection. */
function observationWithOneTurn() {
  return {
    events: [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 1, time: 2, data: { content: [{ type: 'text', text: '看一下这个文件' }] } },
      { type: 'tool/call', seq: 2, time: 3, data: { turn: 1, step: 0, callId: 'c1', name: 'read', arguments: '{"file_path":"a.ts"}' } },
      { type: 'tool/result', seq: 3, time: 4, data: { message: { toolCallId: 'c1', source: { callId: 'c1' }, content: [{ type: 'text', text: 'ok' }] } } },
      { type: 'turn/end', seq: 4, time: 5, data: { turn: 1, reason: { kind: 'stop' } } },
    ],
    projections: { values: { modelSelection: { lastUsed: null, next: { provider: 'p', model: 'm' } } } },
    [Symbol.dispose]() {},
  }
}

/** An llm stub that records the request and answers with one line of text. */
function recordingLlm() {
  const calls = []
  return {
    calls,
    async *stream(options) {
      calls.push(options)
      yield { type: 'text-delta', index: 0, text: '解读结果' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

test('an absent append sends the default system prompt unchanged', async () => {
  const host = await import(new URL('index.js', root))
  const { SYSTEM_PROMPT } = await import(new URL('src/prompt.mjs', root))
  const llm = recordingLlm()
  const answer = await callRoute(host, '/api/turn-insight.analyze', { sessionId: 's', turn: 1 }, {
    sessionQuery: { observeSession: async () => observationWithOneTurn() },
    llm,
  })

  assert.equal(answer.ok, true)
  assert.equal(answer.value.appendApplied, false)
  assert.equal(answer.value.text, '解读结果')
  assert.equal(llm.calls.length, 1)
  assert.equal(llm.calls[0].system, SYSTEM_PROMPT)
})

test('an append is trimmed onto the system prompt and reported as applied', async () => {
  const host = await import(new URL('index.js', root))
  const { SYSTEM_PROMPT } = await import(new URL('src/prompt.mjs', root))
  const llm = recordingLlm()
  const answer = await callRoute(host, '/api/turn-insight.analyze', {
    sessionId: 's',
    turn: 1,
    append: '  只看风险，不要复述过程。  ',
  }, {
    sessionQuery: { observeSession: async () => observationWithOneTurn() },
    llm,
  })

  assert.equal(answer.ok, true)
  assert.equal(answer.value.appendApplied, true)
  const { system } = llm.calls[0]
  assert.ok(system.startsWith(SYSTEM_PROMPT))
  assert.ok(system.includes('只看风险，不要复述过程。'))
  // The evidence envelope is untouched by the append.
  assert.ok(llm.calls[0].messages[0].content[0].text.startsWith('TURN_EVIDENCE_JSON_LENGTH='))
})

test('the append is validated at the boundary', async () => {
  const host = await import(new URL('index.js', root))
  const extra = { sessionQuery: { observeSession: async () => observationWithOneTurn() }, llm: recordingLlm() }

  const wrongType = await callRoute(host, '/api/turn-insight.analyze', { sessionId: 's', turn: 1, append: 42 }, extra)
  assert.equal(wrongType.ok, false)
  assert.equal(wrongType.error.code, 'bad-request')
  assert.match(wrongType.error.message, /append/u)

  const tooLong = await callRoute(host, '/api/turn-insight.analyze', {
    sessionId: 's',
    turn: 1,
    append: 'x'.repeat(2_001),
  }, extra)
  assert.equal(tooLong.ok, false)
  assert.equal(tooLong.error.code, 'bad-request')
  assert.equal(tooLong.error.details.maxAppendChars, 2_000)
  assert.equal(tooLong.error.details.received, 2_001)

  // A whitespace-only append is "empty", so it must not be rejected as long.
  const blank = await callRoute(host, '/api/turn-insight.analyze', { sessionId: 's', turn: 1, append: '   ' }, extra)
  assert.equal(blank.ok, true)
  assert.equal(blank.value.appendApplied, false)
})

test('maxAppendChars is enforced from configuration, not hard-coded', async () => {
  const host = await import(new URL('index.js', root))
  const routes = []
  const llm = recordingLlm()
  host.apply({
    get: () => undefined,
    sessionQuery: { observeSession: async () => observationWithOneTurn() },
    llm,
    connection: { fetch: { register: route => { routes.push(route); return () => {} } } },
  }, { maxAppendChars: 5 })

  const route = routes.find(candidate => candidate.path === '/api/turn-insight.analyze')
  const answer = await (await route.fetch(request({ sessionId: 's', turn: 1, append: '123456' }))).json()
  assert.equal(answer.ok, false)
  assert.equal(answer.error.details.maxAppendChars, 5)
})
