/**
 * Resolve the model route one session's interpretation should use.
 *
 * The requirement is "use the same model as the conversation by default", so
 * the session's own durable model-selection projection wins. DSH's wire view of
 * that projection is `{ lastUsed, next }` where `next` already falls back to
 * `lastUsed`, i.e. `next` is exactly what the next message in that conversation
 * would use — the honest reading of "the dialog's model".
 *
 * The chain is explicit and its winner is reported back to the browser as
 * `source`, so a surprising model is never silent:
 *
 *   1. `session`  — the session's `modelSelection.next`;
 *   2. `session`  — the provider/model of its last logged request header, for a
 *                   deployments where the projection key is not registered;
 *   3. `default`  — the deployment's default model, also the answer for a cold
 *                   session that has no live Agent and therefore no selection;
 *   4. `config`   — this plugin's configured fallback.
 */

function routeFrom(selection, source) {
  if (selection === null || typeof selection !== 'object') return null
  const provider = typeof selection.provider === 'string' ? selection.provider.trim() : ''
  const model = typeof selection.model === 'string' ? selection.model.trim() : ''
  if (!provider || !model) return null
  const reasoningEffort = typeof selection.reasoningEffort === 'string' ? selection.reasoningEffort.trim() : ''
  return {
    provider,
    model,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    source,
  }
}

/**
 * Pick the route for one session, in documented priority order.
 *
 * @param input - the candidate selections, each optional.
 * @param input.projection - the session's `modelSelection` projection value;
 *   the host-state form `{ lastUsed, pending }` and the wire form
 *   `{ lastUsed, next }` are both accepted.
 * @param input.loggedConfig - `provider`/`model` read from the session's last
 *   logged request header.
 * @param input.defaultSelection - the deployment's default model selection.
 * @param input.fallback - this plugin's configured fallback route.
 * @returns a route carrying its `source`, or `null` when nothing is configured.
 */
export function resolveRoute({ projection, loggedConfig, defaultSelection, fallback } = {}) {
  return routeFrom(projection?.next ?? projection?.pending, 'session')
    ?? routeFrom(projection?.lastUsed, 'session')
    ?? routeFrom(loggedConfig, 'session')
    ?? routeFrom(defaultSelection, 'default')
    ?? routeFrom(fallback, 'config')
    ?? null
}

/** Human-readable provenance, shown in the panel next to the model id. */
export const ROUTE_SOURCE_LABELS = Object.freeze({
  session: '当前会话',
  default: '部署默认',
  config: '插件配置',
})
