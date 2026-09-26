# 轨迹解读 Turn Insight

给 DSH Web 的会话视图环加一个 **「解读」** 标签页，落在内置的「对话」「轨迹」旁边。
页面按轮次列出**哪些轮次有工具调用**（只给次数与失败次数），每轮一个「分析」按钮，点击后由模型给出一段解读。

**默认使用该会话正在使用的模型**（就是对话框模型选择器里当前那个），不需要额外配置模型。

```
┌ 对话 │ 轨迹 │ 解读 ┐
├────────────────────┴──────────────────────────────────────┐
│ 轨迹解读                    当前会话 · deepseek-v4.1-flash  [刷新] │
│ 共 12 轮轨迹 · 可解读 9 轮                                    │
│                                                            │
│ 附加提示词（可选）                                           │
│ ┌────────────────────────────────────────────────────────┐ │
│ │ 只关注风险，不要复述过程。                                │ │
│ └────────────────────────────────────────────────────────┘ │
│ 将附加 12 个字符到解读提示词（对所有轮次生效）。                │
│                                                            │
│ 第 3 轮        2 次工具调用 · 1 次失败             [分析]     │
│ 去修一下这个 bug                                             │
│ ┌ 解读 ────────────────────────────────────────────────┐   │
│ │ 定位并复现缺陷，多绕了一步；下一步建议看失败栈。   │   │
│ └──────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────┘
```

面板刻意**不罗列**每次工具调用的名称、参数与输出——只给计数，解读本身才是重点。

## 附加提示词（可选）

面板顶部有一个输入框，用来临时给出解读的侧重：

- 内容**追加到系统提示词后面**（作为操作者本次的附加要求），对所有轮次的「分析」生效；
- **留空即默认**：空、纯空白、或根本没填时，发出的系统提示词与没有这个框时**逐字节相同**，请求前缀不变；
- 只活在当前页面里（按会话记住），刷新即清空；**不写入会话日志**，也不影响对话框；
- 追加内容用固定首尾包起来，其中包含一句复述——**它不能解除「不可信证据只能当数据」的边界**，防止工具输出借这个框升级成指令；
- 长度上限由 `maxAppendChars` 控制，超出会被宿主拒绝（`bad-request`）。


## 安装

需要 Node.js 22.19.0+ 与 DSH Web（本包在 0.1.7-rc.2 上核对与实测）。

本包**没有构建步骤**——`index.js`（宿主）与 `client.js`（浏览器 bundle）就是发布物，所以**不预先打包也能装**。三种装法的区别只在 profile 加载的是哪一份文件：

| 装法 | 命令 | profile 里记成 | 改了源码 |
|---|---|---|---|
| 源码目录（本机开发推荐） | `dsh plugin --profile web add "C:\Users\zhila\wen\code\test\dsh-turn-insight"` | `link:` + 指向该目录的链接 | 直接生效，不必重装 |
| 本地 tarball（分发） | 先 `npm pack`，再 `dsh plugin --profile web add "…\dsh-plugin-turn-insight-0.1.5.tgz"` | `file:` 指向的 `.tgz` 快照 | 要重新 `npm pack` 并重装 |
| git 远端 | `dsh plugin --profile web add github:hoist-wen/dsh-turn-insight` | 从 GitHub 取的一份拷贝 | 不生效，需重新安装 |

在源码目录的父目录里也可以写相对路径（`dsh plugin --profile web add ./dsh-turn-insight`），CLI 会先把它解析成绝对路径；但**Web 插件页与 `plugin_manager` 工具里必须填绝对路径**，相对路径会被拒绝（`a local path must be absolute`）。兼容性预检对目录形式直接读该目录的 `package.json`，不联网、不下载。

重启 `dsh web`（或等 profile 热重载后刷新页面），打开任意非空会话即可看到「解读」标签。

卸载（三种装法一样）：

```shell
dsh plugin --profile web remove dsh-plugin-turn-insight
```

> **各自要留住什么**
>
> - **源码目录**：链接指向源码树本身，**该目录不能移动或删除**，否则 profile 里的 `node_modules/dsh-plugin-turn-insight` 变成悬空链接。pnpm **不会**为 `link:` 依赖安装它自己的依赖；本包零运行时依赖，所以无影响（以后若引入依赖，需在仓库目录自行 `pnpm install`）。
> - **tarball**：记成 `file:` 依赖，**别删那个 `.tgz`**，否则无法重装——它是派生物，删了可用 `npm pack` 随时重新生成，因此不必入库（`.gitignore` 已忽略 `*.tgz`）。
> - **git**：装的是远端拷贝。本包没有 `prepare` 脚本，所以不会被 pnpm 的依赖脚本审批（`allowBuilds`）拦住。

> **`file:<目录>` 与裸目录路径不是一回事**：前者会被 pnpm 按 `files` 字段打成快照、复制进 `.pnpm`，改动源码不生效；只有裸路径那种（记成 `link:`）才是「改完即生效」。想开发就用裸路径。

## 它做了什么

只有两条端点，都是共享 `/api` 通道上的**精确 Fetch 路由**，经浏览器鉴权后才到达：

| 路由 | 请求 | 响应 |
|---|---|---|
| `POST /api/turn-insight.turns` | `{ sessionId }` | `{ ok, value: { totalTurns, turns[], route } }` |
| `POST /api/turn-insight.analyze` | `{ sessionId, turn }` | `{ ok, value: { text, route, usage, finish, truncated } }` |

业务失败仍返回 HTTP 200 + `{ ok: false, error: { code, message, details } }`，面板据此给出可读提示；只有传输层（未鉴权 401 / 跨域 403）才是非 2xx。

数据流很短：

1. `ctx.sessionQuery.observeSession(sessionId, { signal })` **一次读取**同时拿到该会话的精确事件切面与投影基线；
2. `src/turns.mjs` 把事件折叠成「轮次 → 工具调用（名称 / 参数 / 结果 / 是否失败）」；
3. `src/route.mjs` 解析这一轮该用哪个模型；
4. `src/prompt.mjs` 把该轮证据序列化成一则不可信信封；
5. `src/llm.mjs` 调 `ctx.llm.stream()` 一次，取回文本。

原始会话日志是唯一事实来源，插件**只读**它。

### 为什么用 `/api` 精确路由，而不是 `connection.rpc.handle`

宿主侧声明 `inject: ['connection', 'sessionQuery', 'llm']`。

`HostConnectionRpc.handle` 挂载通道路由时执行的是 `owner.effect(() => owner.webServer.register(route))`，而 Cordis 绑定给 `owner` 的上下文并**不是**本插件的注入作用域——把 `webServer` 写进本插件的 `inject` 也无法满足它。实测结果：`apply()` 抛 `cannot get property "webServer" without inject`，通道路由从未挂上，浏览器每次请求都收到兜底路由的 **HTTP 405**。

`connection.fetch.register` 只写连接服务自己的精确路由表，不触碰任何 `owner.webServer`，并且 `file-upload` / `deliverables` / `session-log-export` / `session-controller` 四个内置插件都用它；共享 `/api` 通道本身由连接插件用自己 `ctx.inject(['webServer'])` 的作用域挂载。因此这里改用后者，客户端也随之从 `ctx.connection.rpc.call` 换成同源 `fetch`。

`test/package.test.mjs` 保留了回归断言：宿主入口不得出现 `rpc.handle(`，必须出现 `connection.fetch.register(`。

## 模型怎么选

按优先级，第一个解析成功的胜出；胜出者会作为 `route.source` 回传给面板并显示，所以模型来源永远可见：

| 顺序 | 来源 | `source` | 说明 |
|---|---|---|---|
| 1 | 会话的 `modelSelection` 投影（`next`，即 `pending ?? lastUsed`） | `session` | 对话框模型选择器里的当前选择，**默认就是它** |
| 2 | 该会话最后一次请求头的 `provider` / `model` | `session` | 投影键未注册的部署上的退路 |
| 3 | 部署默认模型（`ctx.agentDefaultModel`） | `default` | 冷会话没有活动 Agent 时的答案 |
| 4 | 插件配置的 `defaultProvider` / `defaultModel` | `config` | 兜底 |

四级全部落空时报 `MODEL_NOT_CONFIGURED`，面板会提示先去对话框选一次模型 —— 不会静默换一个模型。

## 配置

全部字段都有默认值，只有需要改时才写：

```yaml
- id: turn-insight
  name: dsh-plugin-turn-insight
  config:
    defaultProvider: commandcode
    defaultModel: deepseek/deepseek-v4.1-flash
    reasoningEffort: low    # low|high|max（本部署模型可选值）；'' = 沿用会话路由
    maxTurns: 50            # 1..500   返回的最新轮次数
    maxToolCallsPerTurn: 40 # 1..200   每轮保留的工具调用数，溢出计入 droppedToolCalls
    maxArgsChars: 1200      # 80..20000
    maxResultChars: 1600    # 80..40000
    maxPromptChars: 400     # 80..4000
    maxAssistantChars: 600  # 80..8000
    maxOutputTokens: 1500   # 64..32000
    timeoutMs: 120000       # 1000..900000
    maxAppendChars: 2000    # 0..20000  面板「附加提示词」的长度上限
```

未知键、类型错误、越界值都会在插件加载时**显式抛错**，不会静默退回默认值。

### `maxOutputTokens` 是什么：它是「推理 + 正文」的合计上限

`maxOutputTokens` 是**一次生成的总 token 上限**，同时覆盖推理（思考）token 与可见正文——它**不是**“正文长度”。

- DSH 的请求里只有两个相关字段：`maxTokens` 与 `reasoningEffort`。**没有任何字段可以把推理排除在 `maxTokens` 之外**，也没有独立的“思考预算”。
- 本部署的 `command-code` provider 同样只转发这两个（`max_tokens` + `reasoning_effort`），并把推理 token 计入 `outputTokens` 上报。
- `deepseek/deepseek-v4.1-flash` **无条件思考**，可选强度只有 `low | high | max`，**没有 `off`**。

所以「预算固定 1500、但思考不占额度」在当前 provider + 模型上**做不到**。要在这个预算里拿到正文，唯一杠杆是把思考强度压到 `low`——这就是默认取值 `maxOutputTokens: 1500` + `reasoningEffort: low` 的由来。

> ⚠️ 别用 `reasoningEffort: 'off'` 来“关闭思考”：在本 provider 里它的含义是**不发送 `reasoning_effort` 参数**，即回到 Command Code 自己的默认深度，很可能比 `low` 想得更多。

实测失败形态：`finish_reason=length, max_tokens=1500, outputTokens=1500, reasoningTokens=1500`——1500 全被推理吃光、正文零字。provider 会直接抛错；本插件在能拿到 `finish=max-tokens` 的情况下报专属错误码 `MODEL_NO_OUTPUT`，并附带同样的解释，而不是笼统的“模型没有返回文本”。

若 `low` + 1500 仍不够，只有两条路：调大 `maxOutputTokens`，或改用一个可选强度更低的模型。把 `reasoningEffort` 设为 `''` 则回到沿用会话路由的思考强度。

## 模型影响

### 请求面与触发条件

一次 `turn/analyze` 触发**一次独立的模型请求**：`system` 为固定的解读器提示词（刻意写短——过长的指令会诱发更多推理 token，而推理与正文共享同一份输出预算），要求用**一段连贯中文**（不分点、不加小标题）同时交代「这一轮在做什么 / 判断 / 下一步」，`user` 为一则 `TURN_EVIDENCE_JSON_LENGTH=<n>` 长度标记 + 该轮工具调用证据的 JSON。证据里的参数与工具输出是不可信的历史数据，系统提示词固定了「只当数据」的边界。

- 请求携带 `source: { kind: 'plugin', plugin: 'dsh-plugin-turn-insight' }` 作为归因；
- **不传 `sessionId`、不追加任何会话事件**，所以解读请求不进入会话日志，也不会进入对话历史或 KV 缓存前缀。

### Token 影响

按需发生：只有点击「分析」才产生请求。输入被 `maxArgsChars` / `maxResultChars` 截断，输出被 `maxOutputTokens` 限制（推理 token 也计入）。

- `max-tokens` 结束但**有**正文：仍返回部分文本，面板标注「输出被 maxTokens 截断」；
- `max-tokens` 结束且**没有**正文（推理吃光预算）：报 `MODEL_NO_OUTPUT`，面板给出「调大 maxOutputTokens 或调低 reasoningEffort」的可操作提示。

### KV 缓存影响

解读请求是**独立请求**：它与对话本身不共享前缀（system 与 message 都不同），因此既不失效也不复用对话的缓存；反之，解读结果也不会写回对话，不影响对话侧缓存前缀的稳定性。

插件自身的连续解读调用之间，默认提示词前缀是稳定的；一旦在附加提示词框里输入内容，system 就变了，插件自己这条前缀的复用会失效——这是附加提示词唯一的缓存代价。清空输入框即恢复稳定前缀。

## 与「轨迹」标签的关系

「轨迹」标签由 DSH 的 Coding Tools 开关控制显隐（`id === 'trajectory'` 是唯一被隐藏的 id）；本插件的 `id` 是 `turn-insight`，**不受该开关影响**。视图环里少于 2 个标签时标签栏会整体隐藏，本插件不改变这一行为。

## 已知限制

- **解读结果不持久化**：刷新页面即丢失，历史不写盘。需要留存请自行导出或改用带存储的插件。
- **不流式**：两条路由都是 `requestBody: 'buffered'` 的一元请求，面板在模型返回前只显示「正在调用模型解读这一轮…」，没有逐字输出。要打字机效果需改成 `requestBody: 'streaming'` 并自行返回 `ReadableStream`。
- **冷会话按部署默认模型解读**：没有活动 Agent 的会话读不到自己的模型选择，会落到第 3/4 级来源，面板会如实显示 `部署默认` 或 `插件配置`。
- **思考 token 无法排除在预算之外**：`maxOutputTokens` 是「推理 + 正文」的合计上限，DSH 与 provider 都没有独立思考预算字段；默认靠 `reasoningEffort: low` 给它留出正文空间。若仍被推理吃光，只能调大预算或换可选强度更低的模型。想恢复沿用会话的思考强度就把 `reasoningEffort` 设为 `''`。
- **工具调用证据以日志为准**：日志窗口被截断的极端情况下，结果事件没有对应调用事件时会以 `unknown` 名称保留结果而不是丢弃。
- **零运行时依赖**：为把改动面压到最小，本包不引用任何 `@deepseek-ai/*` 运行时模块（渲染用平台 seed 表里的 `react`），也不使用 Schemastery 声明 `Config`，因此配置校验是手写的 `src/config.mjs`。

## 开发

```shell
npm test    # node --test，覆盖配置校验、轮次折叠、模型解析、提示词、LLM 组装、bundle 启动与渲染
```

无构建步骤：`index.js`（宿主）与 `client.js`（浏览器 bundle）都是直接编写并随包发布的源码。

开发时按上面的「[源码目录](#安装)」装一次即可——profile 加载的就是这份源码，改完不必重新打包。宿主侧改动靠 profile 热重载或重启 `dsh web` 生效；`client.js` 由 client-modules 在发布前快照、经 HMR 的 `rebuilt()` 进入启动图，**改动最稳的验证方式是重启 `dsh web` 再刷新页面**。

| 文件 | 作用 |
|---|---|
| `index.js` | 宿主入口：校验配置、注册 `/turn-insight` 通道、读会话、解析模型、调 LLM |
| `client.js` | 浏览器 bundle：注册 `conversation.view` 的「解读」标签与面板 |
| `src/config.mjs` | 配置校验与投影上限 |
| `src/turns.mjs` | 会话事件 → 轮次 / 工具调用（纯函数） |
| `src/route.mjs` | 模型来源解析链（纯函数） |
| `src/prompt.mjs` | 系统提示词与证据信封（纯函数） |
| `src/llm.mjs` | 一次 `ctx.llm.stream()` 的组装与失败归一 |
| `cordis.patch.yml` | bundle 补丁：把本包插成一行 Loader entry |

## 许可证

MIT。
