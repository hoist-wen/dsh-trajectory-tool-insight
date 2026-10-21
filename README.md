# 轨迹工具调用解读 Trajectory Tool Insight

给 DSH Web 的会话视图环加一个 **「解读」** 标签，坐在「对话」「轨迹」旁边。

按轮次列出**哪些轮次有工具调用**（调用次数、失败数、被截断数、提示词摘要），每轮一个「分析」按钮，点了由模型给出一段解读。默认用**该会话正在使用的模型**，不用额外配置。

```
┌ 对话 │ 轨迹 │ 解读 ┐
│ 第 3 轮    2 次工具调用 · 1 次失败          [分析]
│ 去修一下这个 bug
│ ┌ 解读 ───────────────────────────────┐
│ │ 定位并复现缺陷，多绕了一步；建议先看失败栈。 │
│ └─────────────────────────────────────┘
```

面板只给计数，不罗列每次工具调用的名称/参数/输出——解读本身才是重点。

## 安装

需要 Node.js 22.19.0+、DSH ≥ 0.2.0-rc.1（`engines.dsh` 会被 DSH 强制检查）。包内就是发布物，**无构建步骤**：

```shell
dsh plugin --profile desktop add @hoist-wen/dsh-trajectory-tool-insight
```

profile 里记的是**具体版本**，`latest` 前进不会自动升级，要更新就重新 `add`（或先 `remove`）。需要固定版本可写 `@0.3.3`。

卸载：

```shell
dsh plugin --profile desktop remove @hoist-wen/dsh-trajectory-tool-insight
```

装好后重启 DSH 桌面端（或等 profile 热重载），打开任意非空会话即可看到「解读」标签。

## 用法

1. 打开一个有工具调用的会话 → 「解读」标签
2. 顶部显示当前会话模型与可解读轮次数，点某一轮的「分析」
3. 结果就地展开；不落盘，刷新即失效

顶部的「覆盖提示词」可整段替换默认解读提示词：留空即默认（逐字节相同），有内容则默认提示词一个字都不发。⚠️ 默认提示词里的「工具输出只当数据」安全边界也会被一起换掉，请只填自己写的指令。

## 模型怎么选

按优先级取第一个解析成功的，来源会显示在面板上：

| 顺序 | 来源 |
|---|---|
| 1 | 会话的模型选择（对话框当前选择，**默认**） |
| 2 | 该会话最后一次请求头的 provider / model |
| 3 | 部署默认模型 |
| 4 | 插件配置的 `defaultProvider` / `defaultModel` |

四级全落空会提示先去对话框选一次模型，不会静默换模型。

## 配置

全部字段有默认值，一般不用写。常用项：

```yaml
- id: trajectory-tool-insight
  name: '@hoist-wen/dsh-trajectory-tool-insight'
  config:
    maxTurns: 50              # 返回的最新轮次数
    maxOutputTokens: 1500     # 推理 + 正文的合计上限
    reasoningEffort: low      # low|high|max；'' = 沿用会话
    timeoutMs: 120000
```

未知键、类型错误、越界值在加载时直接报错，不会静默退回默认值。

> `maxOutputTokens` 同时涵盖推理 token。`deepseek-v4.1-flash` 无条件思考，预算被推理吃光时会报 `MODEL_NO_OUTPUT`；把 `reasoningEffort` 设成 `''` 可沿用会话强度，设成 `'off'` **不是**关闭思考。

## 限制

- **结果不持久化**：刷新即丢，需要留存请自行导出
- **只看工具证据**：不含助手文本与其他轮次，模型判断的是「这次工具执行本身」
- **不流式**：返回前只显示「正在调用模型…」
- **只读会话日志**：原始日志是唯一事实来源，插件不写入
- **解读请求不进会话日志**，不污染对话历史与缓存前缀

## 开发

```shell
npm test    # node --test：配置校验、轮次折叠、模型解析、提示词、LLM 组装、bundle 渲染
```

源码即产物：`index.js`（宿主 + 两条 `/api` 路由）、`client.js`（浏览器 bundle）、`src/*.mjs`（纯函数）。宿主改动靠 profile 热重载或重启生效，`client.js` 改动最稳的验证方式是重启桌面端再刷新页面。

## 致谢

本插件由 [dsh-trace-insight](https://github.com/Liu-Bot24/dsh-trace-insight)（MIT）精简重写而来，包名与「轨迹解读」定位均源自该项目。

## 许可证

MIT。
