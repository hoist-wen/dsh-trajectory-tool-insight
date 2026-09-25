import assert from 'node:assert/strict'
import { test } from 'node:test'

import { CONFIG_DEFAULTS, configuredFallbackRoute, normalizeConfig, turnLimits } from '../src/config.mjs'

test('omitted config yields every documented default', () => {
  const config = normalizeConfig()
  assert.deepEqual({ ...config }, { ...CONFIG_DEFAULTS })
  assert.ok(Object.isFrozen(config))
})

test('declared values override defaults and are trimmed', () => {
  const config = normalizeConfig({
    defaultProvider: '  commandcode ',
    defaultModel: ' deepseek/deepseek-v4.1-flash ',
    maxTurns: 5,
    timeoutMs: 2_000,
  })
  assert.equal(config.defaultProvider, 'commandcode')
  assert.equal(config.defaultModel, 'deepseek/deepseek-v4.1-flash')
  assert.equal(config.maxTurns, 5)
  assert.equal(config.timeoutMs, 2_000)
  assert.deepEqual(configuredFallbackRoute(config), {
    provider: 'commandcode',
    model: 'deepseek/deepseek-v4.1-flash',
  })
})

test('a half-configured fallback route is not a route', () => {
  assert.equal(configuredFallbackRoute(normalizeConfig({ defaultProvider: 'p' })), null)
  assert.equal(configuredFallbackRoute(normalizeConfig({ defaultModel: 'm' })), null)
})

test('an unknown key fails the load instead of being ignored', () => {
  assert.throws(() => normalizeConfig({ defualtProvider: 'typo' }), /unknown config "defualtProvider"/u)
})

test('out-of-range numbers fail explicitly', () => {
  assert.throws(() => normalizeConfig({ maxTurns: 0 }), /config\.maxTurns must be an integer between 1 and 500/u)
  assert.throws(() => normalizeConfig({ maxTurns: 501 }), /config\.maxTurns/u)
  assert.throws(() => normalizeConfig({ timeoutMs: 999 }), /config\.timeoutMs/u)
  assert.throws(() => normalizeConfig({ maxOutputTokens: 1.5 }), /config\.maxOutputTokens/u)
})

test('wrong types fail explicitly', () => {
  assert.throws(() => normalizeConfig({ defaultProvider: 42 }), /config\.defaultProvider must be a string/u)
  assert.throws(() => normalizeConfig({ maxTurns: '10' }), /config\.maxTurns must be an integer/u)
  assert.throws(() => normalizeConfig([]), /plugin config must be a mapping/u)
  assert.throws(() => normalizeConfig(null), /plugin config must be a mapping/u)
})

test('turnLimits maps the configuration onto the projection caps', () => {
  const limits = turnLimits(normalizeConfig({ maxTurns: 3, maxPromptChars: 100, maxAssistantChars: 200 }))
  assert.deepEqual(limits, {
    maxTurns: 3,
    maxToolCallsPerTurn: CONFIG_DEFAULTS.maxToolCallsPerTurn,
    maxArgsChars: CONFIG_DEFAULTS.maxArgsChars,
    maxResultChars: CONFIG_DEFAULTS.maxResultChars,
    promptChars: 100,
    assistantChars: 200,
  })
})
