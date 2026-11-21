# 自定义请求头（Headers）注入

面向前端 Agent 的模型连接设置，允许为每个 API 预设注入自定义 HTTP 请求头，例如：

```
x-opencode-session: your-session-id
HTTP-Referer: https://example.com
X-Title: SillyTavern
```

## 使用位置

有两个入口，各自独立保存：

**① 剧情总结 / 剧情规划 / 大纲 → 设置 → 模型连接**
（`modules/text-api/settings-ui.js`，API 预设编辑器的 `Model` 下方）

**② 小白助手 → 设置 → 共享 Agent API**，主助手与分身两个页签各有独立字段
（`modules/agent-core/ui/settings-markup.js`，`API Key` 下方）

格式为每行一条 `名称: 值`，也接受 JSON 对象（`{"x-opencode-session":"abc"}`）。
留空表示不注入任何额外头。

## 作用范围

| 通道 | 是否注入 |
| --- | --- |
| `openai-compatible`（直连） | ✅ |
| `openai-responses`（直连） | ✅ |
| `anthropic`（直连） | ✅ |
| `google`（直连） | ✅ |
| `sillytavern-openai-compatible` / `-claude` / `-google`（经酒馆后端） | ✅ 合并进宿主请求头 |
| 拉取模型列表 | ✅ |
| 联网搜索（Exa/Tavily） | ❌ 独立鉴权通道，不受此设置影响 |

## 合并规则

1. 自定义头覆盖协议默认头，**大小写不敏感**：填 `authorization` 会替换默认的 `Authorization`，不会产生重复头。
2. 因此可以用自定义头接管鉴权（例如中转站签发 token 时，把 Key 留空、在请求头里写 `Authorization: Bearer <token>`）。
3. 以下头被忽略（浏览器禁止设置或会破坏传输）：`Host`、`Content-Length`、`Connection`、`Transfer-Encoding`、`Upgrade`、`Keep-Alive`。
4. 值中的换行会被压成空格，**无法通过值注入额外的头**。
5. 只读取用户显式配置的值；**不读取**环境变量或 SDK 环境头（`OPENAI_CUSTOM_HEADERS`、`ANTHROPIC_CUSTOM_HEADERS` 等），保持既有环境隔离。

## 实现位置

| 文件 | 作用 |
| --- | --- |
| `modules/agent-core/request-headers.js` | 新增。`normalizeAgentHeaders`（文本/JSON → 头对象、过滤与单行化）、`mergeRequestHeaders`（大小写不敏感覆盖）、`formatAgentHeaders`（回填表单） |
| `modules/agent-core/config.js` | 预设新增 `headers` 字段，`normalizeAgentPreset` 负责规范化；旧预设无此字段时自动补 `{}`，无需版本迁移 |
| `modules/agent-core/provider-auth.js` | `resolveAgentAuth(provider, apiKey, customHeaders)` 合并自定义头到 `headers` / `requestHeaders` / `sdkOptions.defaultHeaders` / 覆盖后的 `fetch` |
| `modules/agent-core/adapters/{anthropic,google,openai-compatible,openai-responses}.js` | 传入 `config.headers` |
| `modules/agent-core/adapters/sillytavern-{openai-compatible,claude,google}.js` | 传入 `config.headers` 到宿主请求 |
| `shared/host-llm/chat-completions/client.js` | `buildHeaders` 接受 `extraHeaders`，经 `buildHostChatCompletionGenerateRequest` / `createHostChatCompletion` / `streamHostChatCompletion` 透传 |
| `modules/agent-core/model-list.js` | 拉取模型列表时同样注入 |
| `modules/agent-core/ui/settings-markup.js` | 主/子代理两处「自定义请求头」文本框 |
| `modules/agent-core/ui/settings-panel.js` | draft 读写、事件绑定、保存与回显 |
| `modules/text-api/copy.js` | 「模型连接」页的字段文案 |
| `modules/text-api/model.js` | Text API 预设新增 `headers`（字符串），`assertPreset` 校验；旧预设缺字段仍合法 |
| `modules/text-api/settings-ui.js` | 「模型连接」页渲染多行输入；`resolveConnection` 经 `structuredClone(assertPreset())` 自动把它带进 adapter |
| `modules/agent-core/tests/request-headers.test.js` | 新增 7 项测试 |
| `modules/text-api/tests/headers.test.js` | 新增 4 项测试 |

> `sillytavern-current`（当前酒馆）渠道走 `streamingGeneration`，请求头由酒馆自身构造，因此该渠道不显示此字段。

## 测试

```bash
npm test -- agent-core/tests/request-headers.test.js agent-core/tests/provider-auth.test.js
```

覆盖：文本/JSON 解析、危险头过滤、换行注入防护、大小写覆盖、预设往返、四个直连 provider 的 auth 暴露，以及**真实 HTTP 请求**断言 `x-opencode-session` 与 `HTTP-Referer` 确实出现在线上请求头中。


## 浏览器发不出去的请求头

浏览器有两条硬限制：

1. **不能设置 `User-Agent`** 等传输层头，写了也会被丢弃；
2. 上游若拒绝 CORS preflight，请求根本发不出去（`opencode.ai` 实测 `POST` 与 `OPTIONS` 都是 `ERR_FAILED`，而 `curl` 直连正常返回 200）。

这种情况需要让请求从 Node 进程发出。**推荐用仓库自带的转发脚本**：

```bash
node scripts/relay-proxy.cjs
```

然后把「模型连接」里的 Base URL 填成 `http://127.0.0.1:18787`，路径前缀选「自定义」并留空。实测该项配置下测试连接与拉取模型均正常（31 个模型）。

上游可用 `LWB_PROXY_UPSTREAM` 覆盖，默认 `https://opencode.ai/zen/go/v1`；端口用 `LWB_PROXY_PORT`，默认 18787。脚本只监听 `127.0.0.1`，并放行浏览器跨域所需的 CORS 头。

### 关于内置中转渠道（实验性，存在已知问题）

代码里另有一条集成路径：渠道选「OpenAI 兼容（经小白盒中转）」，由酒馆进程转发，不必额外跑脚本。它需要 `config.yaml` 的 `enableServerPlugins: true`，并把 `server-plugin/littlewhitebox-server/` 复制为 `SillyTavern/plugins/littlewhitebox-server/`。

| 文件 | 作用 |
| --- | --- |
| `server-plugin/littlewhitebox-server/chat-relay/routes.js` | 转发 `{url, method, headers, body, stream, timeoutMs}`，透传状态码/响应头/流式 body，规范化重复斜杠，拒收传输层头与含换行的头值 |
| `modules/agent-core/relay-transport.js` | 把 SDK 的 `fetch` 换成走中转；CSRF 取自 `/csrf-token`（iframe 页面不能导入 `script.js`，那里没有 jQuery） |
| `modules/agent-core/provider-auth.js` | `resolveAgentAuth(provider, key, headers, presetConfig)`，命中 relay 时替换 fetch |
| `modules/agent-core/provider-config.js` | 新渠道映射到 `OpenAICompatibleAdapter` + relay transport |

**已知问题**：中转端点本身可用（直接调用 `/api/plugins/littlewhitebox-server/v1/chat/relay` 能以真实配置拿到 `200` 与正常补全；单独构造 adapter 时其 `fetch` 也确实打到 `/csrf-token` 与中转端点），但走「模型连接 → 测试连接」的完整链路时，请求仍直连上游并被 CORS 拦下。根因尚未定位，因此**该渠道暂不建议使用**，请用上面的转发脚本。

## 构建注意
`vite.plugin.config.mjs` 用 `path.resolve(root, '../../../../..')` 把酒馆自身模块（`script.js`、`extensions.js` 等）改写为相对路径，**假定插件目录位于 `<SillyTavern>/public/scripts/extensions/third-party/<name>`**。

在其它位置（例如独立 clone 的 `F:\Programs\LittleWhiteBox`）构建会算错深度，产物里的 import 少两层，浏览器加载时直接失败。因此：

- **要发布产物，请在酒馆的扩展目录内构建**。
- `scripts/build-no-typecheck.mjs` 跳过了三项与本功能无关的门槛：`scripts/typecheck.mjs`（需要酒馆自身的 TS 类型，fork 中缺失）、`build-agent-core-node.mjs`（需要维护者发布签名私钥）、`validateBuild()`（需联网拉取上游参考）。
