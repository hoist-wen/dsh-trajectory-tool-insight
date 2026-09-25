import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ROUTE_SOURCE_LABELS, resolveRoute } from '../src/route.mjs'

const FALLBACK = { provider: 'configured', model: 'fallback-model' }
const DEFAULT = { provider: 'deployment', model: 'default-model' }
const LOGGED = { provider: 'logged', model: 'logged-model' }

test('the session projection wins, so the panel reuses the dialog model', () => {
  const route = resolveRoute({
    projection: { lastUsed: { provider: 'p1', model: 'used' }, next: { provider: 'p2', model: 'next' } },
    loggedConfig: LOGGED,
    defaultSelection: DEFAULT,
    fallback: FALLBACK,
  })
  assert.deepEqual(route, { provider: 'p2', model: 'next', source: 'session' })
})

test('the host-state projection form (pending) is accepted as well as the wire form (next)', () => {
  const route = resolveRoute({ projection: { lastUsed: null, pending: { provider: 'p', model: 'pending' } } })
  assert.deepEqual(route, { provider: 'p', model: 'pending', source: 'session' })
})

test('a consumed selection still counts as the session model', () => {
  const route = resolveRoute({ projection: { lastUsed: { provider: 'p', model: 'used' }, next: null } })
  assert.deepEqual(route, { provider: 'p', model: 'used', source: 'session' })
})

test('reasoning effort survives resolution when the selector reports one', () => {
  const route = resolveRoute({ projection: { next: { provider: 'p', model: 'm', reasoningEffort: 'high' } } })
  assert.deepEqual(route, { provider: 'p', model: 'm', reasoningEffort: 'high', source: 'session' })
})

test('the chain degrades session -> logged header -> deployment default -> plugin config', () => {
  assert.equal(resolveRoute({ loggedConfig: LOGGED, defaultSelection: DEFAULT, fallback: FALLBACK }).source, 'session')
  assert.deepEqual(resolveRoute({ loggedConfig: LOGGED, defaultSelection: DEFAULT, fallback: FALLBACK }), { ...LOGGED, source: 'session' })
  assert.deepEqual(resolveRoute({ defaultSelection: DEFAULT, fallback: FALLBACK }), { ...DEFAULT, source: 'default' })
  assert.deepEqual(resolveRoute({ fallback: FALLBACK }), { ...FALLBACK, source: 'config' })
})

test('nothing configured resolves to null rather than a guessed route', () => {
  assert.equal(resolveRoute(), null)
  assert.equal(resolveRoute({}), null)
  assert.equal(resolveRoute({ projection: { next: { provider: '', model: 'm' } } }), null)
  assert.equal(resolveRoute({ projection: { next: { provider: 'p', model: '   ' } } }), null)
  assert.equal(resolveRoute({ projection: { next: null, lastUsed: null }, loggedConfig: {}, defaultSelection: null }), null)
})

test('every source has a label for the panel', () => {
  assert.deepEqual(Object.keys(ROUTE_SOURCE_LABELS).sort(), ['config', 'default', 'session'])
})
