/**
 * 轨迹工具调用解读 · 浏览器半部分.
 *
 * Registers one entry in the conversation view ring (`conversation.view`), so
 * the analysis surface renders as a sibling tab of the built-in 对话 / 轨迹
 * tabs. It claims no layout of its own: no shell overlay, no width drag, no
 * DOM injection outside its own subtree.
 *
 * Everything the panel shows comes from the host channel `/trajectory-tool-insight`; this
 * bundle never reads the session log directly, so the raw log stays the single
 * source of truth.
 *
 * The bundle body is authored source, not a build artifact: it is one
 * self-contained factory whose only external is React, exactly like the
 * built-in Web Client packages.
 */
window.__ModuleLoader__.load({
  id: '@hoist-wen/dsh-trajectory-tool-insight',
  factory: (require) => {
    const React = require('react')
    const { createElement: h, useCallback, useEffect, useRef, useState } = React

    const PLUGIN_ID = '@hoist-wen/dsh-trajectory-tool-insight'
    const VIEW_SLOT = 'conversation.view'
    const VIEW_ID = 'trajectory-tool-insight'
    const VIEW_ORDER = 20
    const VIEW_LABEL = '解读'
    // Exact routes on the shared `/api` channel, not a private RPC channel.
    const TURNS_PATH = '/api/trajectory-tool-insight.turns'
    const ANALYZE_PATH = '/api/trajectory-tool-insight.analyze'

    /**
     * Transient per-session system-prompt overrides. Module-level on purpose:
     * the view is unmounted whenever the user switches tabs, and a replacement
     * prompt typed one moment ago should still be there on the way back — but
     * it must not outlive the page, because it is not saved state.
     */
    const overrideNotes = new Map()

    const ROUTE_SOURCE_LABELS = {
      session: '当前会话',
      default: '部署默认',
      config: '插件配置',
    }

    const ERROR_HINTS = {
      MODEL_NOT_CONFIGURED: '无法确定该会话使用的模型。请先在对话框的模型选择器里选一次模型，或在插件配置里设置 defaultProvider 与 defaultModel。',
      LLM_UNAVAILABLE: '本部署没有可用的 llm 服务，无法调用模型。',
      MODEL_TIMEOUT: '模型调用超时。可在插件配置里调大 timeoutMs。',
      MODEL_ABORTED: '模型调用已取消。',
      MODEL_TOOL_CALL: '解读模型尝试调用工具，已中止。',
      MODEL_EMPTY_OUTPUT: '模型没有返回可见文本。',
      MODEL_NO_OUTPUT: '模型把全部输出预算用在了推理上，没有产出正文。预算是「推理 + 正文」的合计上限，无法只算正文；请把 maxOutputTokens 调大，或把 reasoningEffort 调低。',
      TURN_NOT_FOUND: '该轮次没有可解读的工具调用，请刷新后重试。',
      'bad-request': '请求参数不合法，插件与宿主版本可能不一致。',
      'http-401': '浏览器会话未鉴权，请刷新页面。',
      'http-403': '请求被 Host/Origin 校验拒绝。',
      'http-404': '宿主没有注册该路由，插件可能未加载成功 —— 请检查「设置 → 插件」里 @hoist-wen/dsh-trajectory-tool-insight 的加载状态。',
    }

    const STYLE_TEXT = `
.ttis-root {
  --ttis-line: var(--dsh-border, rgba(128, 138, 158, 0.24));
  --ttis-text: var(--dsh-text, inherit);
  --ttis-muted: var(--dsh-text-secondary, rgba(128, 138, 158, 0.95));
  --ttis-surface: var(--dsh-surface, rgba(128, 138, 158, 0.06));
  --ttis-alert: #b25c05;
  height: 100%;
  min-height: 0;
  overflow: auto;
  padding: 16px 20px 32px;
  font-size: 13px;
  line-height: 1.65;
  color: var(--ttis-text);
}
.ttis-head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--ttis-line);
}
.ttis-head-text { flex: 1 1 auto; min-width: 0; }
.ttis-title { margin: 0; font-size: 14px; font-weight: 600; }
.ttis-sub { margin: 4px 0 0; color: var(--ttis-muted); font-size: 12px; }
.ttis-head-side { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }
.ttis-route {
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 3px 8px;
  border: 1px solid var(--ttis-line);
  border-radius: 999px;
  color: var(--ttis-muted);
  font-size: 11px;
}
.ttis-route-missing { color: var(--ttis-alert); border-color: currentColor; }
.ttis-btn {
  font: inherit;
  font-size: 12px;
  padding: 4px 10px;
  border: 1px solid var(--ttis-line);
  border-radius: 6px;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.ttis-btn:hover:not(:disabled) { background: var(--ttis-surface); }
.ttis-btn:disabled { opacity: 0.55; cursor: default; }
.ttis-btn-primary { border-color: currentColor; font-weight: 600; }
.ttis-override { padding: 10px 0 2px; }
.ttis-override-label { display: block; font-size: 11px; font-weight: 600; margin-bottom: 4px; }
.ttis-override-input {
  display: block;
  width: 100%;
  box-sizing: border-box;
  resize: vertical;
  font: inherit;
  font-size: 12px;
  line-height: 1.55;
  padding: 6px 8px;
  border: 1px solid var(--ttis-line);
  border-radius: 6px;
  background: transparent;
  color: inherit;
}
.ttis-override-input:focus { outline: none; border-color: currentColor; }
.ttis-override-note { margin: 4px 0 0; color: var(--ttis-muted); font-size: 11px; }
.ttis-body { padding-top: 8px; }
.ttis-empty { color: var(--ttis-muted); padding: 24px 0; }
.ttis-turn { padding: 12px 0; border-bottom: 1px solid var(--ttis-line); }
.ttis-turn-head { display: flex; align-items: center; gap: 10px; }
.ttis-turn-no { font-weight: 600; }
.ttis-turn-count { flex: 1 1 auto; color: var(--ttis-muted); font-size: 12px; }
.ttis-prompt {
  margin: 6px 0 0;
  padding: 6px 10px;
  border-left: 2px solid var(--ttis-line);
  color: var(--ttis-muted);
  font-size: 12px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.ttis-analysis { margin-top: 10px; padding: 10px 12px; border: 1px solid var(--ttis-line); border-radius: 8px; background: var(--ttis-surface); }
.ttis-analysis-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; font-size: 11px; font-weight: 600; }
.ttis-analysis-head .ttis-muted { font-weight: 400; flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ttis-analysis-error { background: transparent; border-color: var(--ttis-alert); }
.ttis-warn { color: var(--ttis-alert); font-weight: 400; }
.ttis-muted { color: var(--ttis-muted); }
.ttis-code { margin: 4px 0 0; font-size: 11px; color: var(--ttis-muted); }
.ttis-text p { margin: 0 0 6px; overflow-wrap: anywhere; }
.ttis-text p:last-child { margin-bottom: 0; }
.ttis-h { font-weight: 600; }
.ttis-li { padding-left: 14px; position: relative; }
.ttis-li::before { content: '·'; position: absolute; left: 4px; color: var(--ttis-muted); }
.ttis-gap { height: 4px; }
.ttis-text code {
  padding: 1px 4px;
  border-radius: 4px;
  background: rgba(128, 138, 158, 0.18);
  font-size: 11px;
}
`

    function installStyle() {
      const existing = document.querySelector(`style[data-plugin-css="${PLUGIN_ID}"]`)
      if (existing !== null) return () => {}
      const style = document.createElement('style')
      style.dataset.plugin = PLUGIN_ID
      style.dataset.pluginCss = PLUGIN_ID
      style.textContent = STYLE_TEXT
      document.head.appendChild(style)
      return () => style.remove()
    }

    function describe(error) {
      const code = typeof error?.code === 'string' ? error.code : ''
      return {
        code,
        message: typeof error?.message === 'string' && error.message ? error.message : String(error ?? '未知错误'),
        hint: ERROR_HINTS[code] ?? '',
      }
    }

    function makeApi(sessionId) {
      // Same-origin POST to an exact `/api` route. Admission (Host/Origin
      // fence + browser auth) is applied by the shared `/api` carrier before
      // this route runs, so a 401/403 here means the browser session, not the
      // plugin. A business failure arrives as HTTP 200 with `{ ok: false }`.
      const call = async (path, payload, signal) => {
        const response = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          credentials: 'same-origin',
          signal,
        })
        if (!response.ok) {
          const failure = new Error(`轨迹工具调用解读请求失败（HTTP ${response.status}）`)
          failure.code = `http-${response.status}`
          throw failure
        }
        const body = await response.json().catch(() => null)
        if (body?.ok === true) return body.value
        const error = body?.error ?? {}
        const failure = new Error(error.message || '轨迹工具调用解读请求失败')
        failure.code = typeof error.code === 'string' ? error.code : ''
        failure.details = error.details ?? {}
        throw failure
      }
      return {
        listTurns: signal => call(TURNS_PATH, { sessionId }, signal),
        // An empty override is omitted entirely, so an untouched box produces
        // exactly the request the plugin made before the box existed.
        analyzeTurn: (turn, override, signal) => call(
          ANALYZE_PATH,
          { sessionId, turn, ...(override ? { override } : {}) },
          signal,
        ),
      }
    }

    function inline(text, keyPrefix) {
      return String(text)
        .split(/(\*\*[^*]+\*\*|`[^`]+`)/gu)
        .filter(part => part !== '')
        .map((part, index) => {
          if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
            return h('strong', { key: `${keyPrefix}-${index}` }, part.slice(2, -2))
          }
          if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
            return h('code', { key: `${keyPrefix}-${index}` }, part.slice(1, -1))
          }
          return part
        })
    }

    /** Minimal Markdown pass: headings, bullets, bold, inline code, paragraphs. */
    function renderText(text) {
      const lines = String(text).split(/\r?\n/u)
      return h('div', { className: 'ttis-text' }, lines.map((line, index) => {
        const trimmed = line.trim()
        if (trimmed === '') return h('div', { className: 'ttis-gap', key: `gap-${index}` })
        const heading = /^#{1,6}\s+(.*)$/u.exec(trimmed)
        if (heading !== null) return h('p', { className: 'ttis-h', key: `h-${index}` }, inline(heading[1], `h${index}`))
        const bullet = /^(?:[-*]|\d+\.)\s+(.*)$/u.exec(trimmed)
        if (bullet !== null) return h('p', { className: 'ttis-li', key: `li-${index}` }, inline(bullet[1], `li${index}`))
        return h('p', { key: `p-${index}` }, inline(trimmed, `p${index}`))
      }))
    }

    function subtitle(listing) {
      if (listing.status === 'loading') return '正在读取会话轨迹…'
      if (listing.status === 'error') return '读取失败'
      return `共 ${listing.totalTurns} 轮轨迹 · 可解读 ${listing.turns.length} 轮`
    }

    function turnCard(entry, analysis, onAnalyze) {
      const running = analysis?.status === 'running'
      const failed = entry.toolCalls.filter(call => call.isError).length
      // Counts only: the panel deliberately does not enumerate tool names,
      // arguments, or results — the interpretation is the whole point.
      const summary = [
        `${entry.toolCalls.length} 次工具调用`,
        failed > 0 ? `${failed} 次失败` : '',
        entry.droppedToolCalls > 0 ? `另有 ${entry.droppedToolCalls} 次未纳入` : '',
      ].filter(Boolean).join(' · ')
      return h('section', { className: 'ttis-turn', key: entry.turn },
        h('div', { className: 'ttis-turn-head' },
          h('span', { className: 'ttis-turn-no' }, `第 ${entry.turn} 轮`),
          h('span', { className: 'ttis-turn-count' }, summary),
          h('button', {
            className: 'ttis-btn ttis-btn-primary',
            type: 'button',
            disabled: running,
            onClick: () => onAnalyze(entry.turn),
          }, running ? '分析中…' : analysis ? '重新分析' : '分析'),
        ),
        entry.prompt ? h('p', { className: 'ttis-prompt' }, entry.prompt) : null,
        analysis ? analysisPanel(analysis) : null,
      )
    }

    function analysisPanel(analysis) {
      if (analysis.status === 'running') {
        return h('div', { className: 'ttis-analysis' }, h('p', { className: 'ttis-muted' }, '正在调用模型解读这一轮…'))
      }
      if (analysis.status === 'error') {
        return h('div', { className: 'ttis-analysis ttis-analysis-error' },
          h('p', null, analysis.error.message),
          analysis.error.hint ? h('p', { className: 'ttis-muted' }, analysis.error.hint) : null,
          analysis.error.code ? h('p', { className: 'ttis-code' }, analysis.error.code) : null,
        )
      }
      return h('div', { className: 'ttis-analysis' },
        h('div', { className: 'ttis-analysis-head' },
          h('span', null, '解读'),
          analysis.route
            ? h('span', { className: 'ttis-muted' }, `${analysis.route.provider} / ${analysis.route.model}`)
            : null,
          analysis.truncated ? h('span', { className: 'ttis-warn' }, '输出被 maxTokens 截断') : null,
        ),
        renderText(analysis.text),
      )
    }

    function ToolInsightView(props) {
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
      // The injected face is rebuilt per binding, so it is held in a ref: the
      // listing effect must depend on the session alone, never on a function
      // identity that changes every render.
      const apiRef = useRef(props.api)
      apiRef.current = props.api

      const [listing, setListing] = useState({ status: 'loading', turns: [], totalTurns: 0, route: null, error: null })
      const [analyses, setAnalyses] = useState(() => new Map())
      const [reloadToken, setReloadToken] = useState(0)
      // Seeded from the module-level store so the override survives this view
      // being unmounted and remounted, while still dying with the page: it is
      // transient instruction text, not saved state.
      const [override, setOverride] = useState(() => overrideNotes.get(sessionId) ?? '')
      const overrideRef = useRef(override)
      overrideRef.current = override

      const updateOverride = useCallback(value => {
        setOverride(value)
        if (value.trim() === '') overrideNotes.delete(sessionId)
        else overrideNotes.set(sessionId, value)
      }, [sessionId])

      useEffect(() => {
        if (sessionId === '' || typeof apiRef.current?.listTurns !== 'function') return undefined
        const controller = new AbortController()
        let cancelled = false
        setListing(previous => ({ ...previous, status: previous.turns.length > 0 ? 'refreshing' : 'loading', error: null }))
        apiRef.current.listTurns(controller.signal).then(value => {
          if (cancelled) return
          setListing({
            status: 'ready',
            turns: Array.isArray(value?.turns) ? value.turns : [],
            totalTurns: Number.isSafeInteger(value?.totalTurns) ? value.totalTurns : 0,
            route: value?.route ?? null,
            error: null,
          })
        }).catch(error => {
          if (cancelled) return
          setListing(previous => ({ ...previous, status: 'error', error: describe(error) }))
        })
        return () => {
          cancelled = true
          controller.abort()
        }
      }, [sessionId, reloadToken])

      const analyze = useCallback(turn => {
        setAnalyses(previous => new Map(previous).set(turn, { status: 'running' }))
        apiRef.current.analyzeTurn(turn, overrideRef.current.trim()).then(value => {
          setAnalyses(previous => new Map(previous).set(turn, {
            status: 'ready',
            text: typeof value?.text === 'string' ? value.text : '',
            route: value?.route ?? null,
            truncated: value?.truncated === true,
          }))
        }).catch(error => {
          setAnalyses(previous => new Map(previous).set(turn, { status: 'error', error: describe(error) }))
        })
      }, [])

      if (sessionId === '') {
        return h('div', { className: 'ttis-root' }, h('p', { className: 'ttis-empty' }, '请先打开一个会话。'))
      }

      const route = listing.route
      const busy = listing.status === 'loading' || listing.status === 'refreshing'
      const overrideLength = override.trim().length
      return h('div', { className: 'ttis-root' },
        h('header', { className: 'ttis-head' },
          h('div', { className: 'ttis-head-text' },
            h('h2', { className: 'ttis-title' }, '轨迹工具调用解读'),
            h('p', { className: 'ttis-sub' }, subtitle(listing)),
          ),
          h('div', { className: 'ttis-head-side' },
            route
              ? h('span', { className: 'ttis-route', title: `${route.provider} / ${route.model}` },
                `${ROUTE_SOURCE_LABELS[route.source] ?? route.source} · ${route.model}`)
              : h('span', { className: 'ttis-route ttis-route-missing' }, '未确定模型'),
            h('button', {
              className: 'ttis-btn',
              type: 'button',
              disabled: busy,
              onClick: () => setReloadToken(token => token + 1),
            }, busy ? '刷新中…' : '刷新'),
          ),
        ),
        h('div', { className: 'ttis-override' },
          h('label', { className: 'ttis-override-label', htmlFor: 'ttis-override-input' }, '覆盖提示词（可选）'),
          h('textarea', {
            id: 'ttis-override-input',
            className: 'ttis-override-input',
            rows: 2,
            value: override,
            placeholder: '非空时完全替换默认系统提示词，例如：只关注风险，不要复述过程。留空则使用默认提示词。',
            onChange: event => updateOverride(event.target.value),
          }),
          h('p', { className: 'ttis-override-note' }, overrideLength === 0
            ? '留空 = 使用默认提示词；填写后将完全替换系统提示词。只影响后续的「分析」，不写入会话日志。'
            : `将用 ${overrideLength} 个字符覆盖解读提示词（对所有轮次的「分析」生效，不写入会话日志）。默认提示词的安全边界也会被一并替换。`),
        ),
        h('div', { className: 'ttis-body' },
          listing.status === 'error'
            ? h('div', { className: 'ttis-analysis ttis-analysis-error' },
              h('p', null, listing.error.message),
              listing.error.hint ? h('p', { className: 'ttis-muted' }, listing.error.hint) : null,
              listing.error.code ? h('p', { className: 'ttis-code' }, listing.error.code) : null,
            )
            : listing.status === 'loading'
              ? h('p', { className: 'ttis-empty' }, '正在读取会话轨迹…')
              : listing.turns.length === 0
                ? h('p', { className: 'ttis-empty' }, '这个会话还没有带工具调用的轮次。')
                : listing.turns.map(entry => turnCard(entry, analyses.get(entry.turn), analyze)),
        ),
      )
    }

    return {
      name: 'trajectory-tool-insight',
      // Only the view ring: the routes are plain same-origin `fetch` calls, so
      // no client Connection service is involved.
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => installStyle(), 'trajectory-tool-insight: styles')
        ctx.slots.inject(VIEW_SLOT, () => ctx.slots.register({
          name: VIEW_SLOT,
          id: VIEW_ID,
          order: VIEW_ORDER,
          label: () => VIEW_LABEL,
          inject: sessionId => ({ api: makeApi(sessionId) }),
        }, ToolInsightView))
      },
    }
  },
})
