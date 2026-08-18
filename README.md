# dsh-token-monitor

Real-time **token usage** and **DeepSeek account balance** monitor for the DeepSeek Harness (DSH) web shell — a floating widget pinned to the bottom-right corner of the page.

A pure **static host plugin**: no client bundle, no build step, no Remote/typert surgery. It registers two JSON HTTP routes and injects a small vanilla-JS widget into `index.html` via `tapIndex`. Loads automatically with the deployment config and survives restarts.

---

## English

### Features

- **Token usage (provider-reported)**: listens to `session/event` `assistant/message` events (durable, deduplicated `TokenUsage`), accumulated per session plus a global total. `llm/stream` provides live in-flight call visibility and the active session; `tokenMeter.measure()` estimates current context pressure.
- **Balance**: resolves `DEEPSEEK_API_KEY` through the credentials seam and queries `https://api.deepseek.com/user/balance` via a node subprocess (OpenSSL TLS, works under the sandbox). 60s cache + manual refresh. The API key never leaves the machine and never reaches the browser.
- **Widget**: fixed bottom-right card; polls usage every 2.5s and balance every 60s; collapsible to a compact pill; uses theme CSS variables (`--dsw-alias-*`) so it adapts to light/dark themes.

### Install

Put the `token-monitor` directory next to the profile config:

```
$DSH_HOME/profiles/web/token-monitor/
```

Append to `$DSH_HOME/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: token-monitor
      name: ./token-monitor/index.js
```

> Note: point `name` at the entry file, not the directory — the DSH loader imports
> relative entries as ES modules, and Node does not support directory imports
> (`ERR_UNSUPPORTED_DIR_IMPORT`).

Restart `dsh web`. After boot:

- `GET /api/token-monitor/usage` — usage JSON (`sessions` / `total` / `activeSessionId` / `lastCall` / `live` / `context`)
- `GET /api/token-monitor/balance` — balance JSON (`?force=1` forces a refresh)
- Every page load injects the bottom-right widget

### Requirements

- Any DSH deployment (token usage tracking is provider-agnostic)
- Balance query needs: `node` resolvable on PATH, a configured `DEEPSEEK_API_KEY` credential, and the DeepSeek official API (uses the `baseURL` from the `llm-deepseek` settings, default `https://api.deepseek.com`)
- Non-DeepSeek providers (pi-ai / OpenRouter / local models): balance shows "query failed", usage tracking still works

### Security notes

- The two routes are unauthenticated, but the web server binds to localhost (`127.0.0.1`) by default
- The API key is passed to the node subprocess only through its environment; it is never logged or returned to the browser

### License

MIT

---

## 中文

### 功能

- **Token 用量（真实值）**：监听 `session/event` 的 `assistant/message` 事件（持久化、去重后的 provider TokenUsage），按会话分桶 + 全局合计；`llm/stream` 提供在途调用与活跃会话实时视图；`tokenMeter.measure()` 提供当前上下文压力估算
- **余额**：经 `credentials` 解析 `DEEPSEEK_API_KEY`，用 node 子进程（OpenSSL TLS）请求 `https://api.deepseek.com/user/balance`，60 秒缓存 + 手动刷新；API key 仅在本机传递，绝不出现在页面或响应中
- **浮窗**：右下角固定卡片，2.5s 轮询用量、60s 轮询余额，可折叠为小药丸，样式使用主题 CSS 变量（`--dsw-alias-*`）自动适配明暗主题

### 安装（本机部署）

把 `token-monitor` 目录放到 profile 目录下：

```
$DSH_HOME/profiles/web/token-monitor/
```

在 `$DSH_HOME/profiles/web/cordis.patch.yml` 追加：

```yaml
- insert:
    - id: token-monitor
      name: ./token-monitor/index.js
```

> 注意：`name` 要指向入口文件而不是目录——DSH 加载器把相对路径当 ES 模块导入，
> Node 不支持目录导入（`ERR_UNSUPPORTED_DIR_IMPORT`）。

重启 `dsh web` 即可。插件启动后：

- `GET /api/token-monitor/usage` — 用量 JSON（sessions / total / activeSessionId / lastCall / live / context）
- `GET /api/token-monitor/balance` — 余额 JSON（`?force=1` 强制刷新）
- 每个页面加载时自动注入右下角浮窗

### 要求

- 任意 DSH 部署（token 用量统计与模型提供方无关）
- 余额查询需要：本机装有 node（PATH 可解析）、凭据中配置了 `DEEPSEEK_API_KEY`、使用 DeepSeek 官方 API（`llm-deepseek` 设置中的 `baseURL`，默认 `https://api.deepseek.com`）
- 非 DeepSeek 提供方（pi-ai / OpenRouter / 本地模型）：余额显示"查询失败"，用量统计不受影响

### 安全说明

- 两个路由无鉴权，但 web 服务默认绑定 localhost（`127.0.0.1`），仅本机可访问
- API key 只通过子进程环境变量传递给 node 脚本，不写入日志、不返回给浏览器

### 许可证

MIT

---

## Publishing / 发布

The repo ships its own publish tooling under `scripts/` — zero dependencies, plain Node + the GitHub REST API (no `git` binary needed). Both read the token from `DSH_GH_TOKEN` in the environment and never print it.

仓库自带发布脚本（`scripts/` 目录），零依赖，纯 Node + GitHub REST API，不需要安装 `git`。token 从环境变量 `DSH_GH_TOKEN` 读取，脚本从不打印它。

```bash
export DSH_GH_TOKEN=ghp_xxx          # your GitHub PAT / 你的 GitHub 令牌
node scripts/publish-github.mjs      # sync files + topics + release + zip asset（同步文件/话题/发布/zip 资产）
node scripts/upload-github.mjs       # create (or reuse) repo and upload files only（仅建仓库 + 传文件）
node scripts/build-zip.mjs           # just rebuild dist/dsh-token-monitor-<tag>.zip（仅重建 zip）
```

`DSH_GH_TAG` (default `v1.0.0`) controls the release tag. `publish-github.mjs` is idempotent — re-running updates files/topics and recreates the tag/release. `DSH_GH_TAG`（默认 `v1.0.0`）控制发布标签；`publish-github.mjs` 可重复执行，重复运行会更新文件/话题并重建 tag 与 release。
