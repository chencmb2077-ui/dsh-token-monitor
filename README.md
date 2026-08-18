# token-monitor

DSH（DeepSeek Harness）静态 Host 插件：在 Web 界面右下角实时显示 **token 用量**（当前会话 / 全部会话 / 在途调用 / 上下文压力）和 **DeepSeek 账户余额**（¥/货币、充值/赠送明细、可用状态）。

纯 Host 实现：注册两个 JSON HTTP 路由，并通过 `tapIndex` 向 web 壳的 index.html 注入一个内嵌 vanilla JS 浮窗小部件。**无 Client bundle、无构建步骤、无 Remote/typert 依赖**，随部署配置开机自启、重启不丢。

## 功能

- **Token 用量（真实值）**：监听 `session/event` 的 `assistant/message` 事件（持久化、去重后的 provider TokenUsage），按会话分桶 + 全局合计；`llm/stream` 提供在途调用与活跃会话实时视图；`tokenMeter.measure()` 提供当前上下文压力估算
- **余额**：经 `credentials` 解析 `DEEPSEEK_API_KEY`，用 node 子进程（OpenSSL TLS）请求 `https://api.deepseek.com/user/balance`，60 秒缓存 + 手动刷新；API key 仅在本机传递，绝不出现在页面或响应中
- **浮窗**：右下角固定卡片，2.5s 轮询用量、60s 轮询余额，可折叠为小药丸，样式使用主题 CSS 变量（`--dsw-alias-*`）自动适配明暗主题

## 安装（本机部署）

把 `token-monitor` 目录放到 profile 目录下，例如：

```
$DSH_HOME/profiles/web/token-monitor/
```

在 `$DSH_HOME/profiles/web/cordis.patch.yml` 追加：

```yaml
- insert:
    - id: token-monitor
      name: ./token-monitor
```

重启 `dsh web` 即可。插件启动后：

- `GET /api/token-monitor/usage` — 用量 JSON（sessions / total / activeSessionId / lastCall / live / context）
- `GET /api/token-monitor/balance` — 余额 JSON（`?force=1` 强制刷新）
- 每个页面加载时自动注入右下角浮窗

## 要求

- 任意 DSH 部署（token 用量统计与模型提供方无关）
- 余额查询需要：本机装有 node（PATH 可解析）、凭据中配置了 `DEEPSEEK_API_KEY`、使用 DeepSeek 官方 API（`llm-deepseek` 设置中的 `baseURL`，默认 `https://api.deepseek.com`）
- 非 DeepSeek 提供方（pi-ai / OpenRouter / 本地模型）：余额显示"查询失败"，用量统计不受影响

## 安全说明

- 两个路由无鉴权，但 web 服务默认绑定 localhost（`127.0.0.1`），仅本机可访问
- API key 只通过子进程环境变量传递给 node 脚本，不写入日志、不返回给浏览器

## License

MIT
