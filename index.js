// token-monitor — DSH static host plugin.
// Real-time token usage (durable per-session, deduplicated) + DeepSeek account balance.
// Serves two JSON HTTP routes and injects a bottom-right floating widget into the
// web shell's index.html. No client bundle, no build step, no Remote/typert surgery:
// the widget is plain inline browser JS that polls the routes.
//
// Deployment: put this package beside the profile config, then add to cordis.patch.yml:
//   - insert:
//       - id: token-monitor
//         name: ./token-monitor

export const name = 'token-monitor'
export const inject = ['webServer']

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

const BALANCE_TTL_MS = 60000

export function apply(ctx) {
  const state = {
    perSession: new Map(),
    total: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, calls: 0 },
    activeSessionId: null,
    lastCall: null,
    live: null,
  }

  // ---- durable usage: assistant/message events carry provider TokenUsage ----
  ctx.on('session/event', (session, event) => {
    if (!event || event.type !== 'assistant/message') return
    const data = event.data
    if (!data || !data.usage) return
    const sid = session && session.id
    if (!sid) return
    const u = data.usage
    const input = num(u.inputTokens)
    const output = num(u.outputTokens)
    const cacheRead = num(u.cacheReadTokens)
    const cacheWrite = num(u.cacheWriteTokens)
    const reasoning = num(u.reasoningTokens)
    if (input + output + cacheRead + cacheWrite + reasoning === 0) return
    let bucket = state.perSession.get(sid)
    if (!bucket) {
      bucket = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, calls: 0 }
      state.perSession.set(sid, bucket)
    }
    bucket.input += input
    bucket.output += output
    bucket.cacheRead += cacheRead
    bucket.cacheWrite += cacheWrite
    bucket.reasoning += reasoning
    bucket.calls += 1
    const t = state.total
    t.input += input
    t.output += output
    t.cacheRead += cacheRead
    t.cacheWrite += cacheWrite
    t.reasoning += reasoning
    t.calls += 1
  }, { global: true })

  // ---- live visibility: active session + in-flight call (never counted here; replays would double count) ----
  const startLive = (options, next) => {
    const call = {
      sessionId: options && options.sessionId ? options.sessionId : null,
      provider: (options && options.provider) || null,
      model: (options && options.model) || null,
      purpose: (options && options.purpose) || null,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      at: Date.now(),
    }
    state.live = call
    if (call.sessionId) state.activeSessionId = call.sessionId
    return (async function* () {
      const source = await next()
      try {
        for await (const chunk of source) {
          if (chunk && chunk.type === 'usage' && chunk.usage) {
            call.input = num(chunk.usage.inputTokens)
            call.output = num(chunk.usage.outputTokens)
            call.cacheRead = num(chunk.usage.cacheReadTokens)
            call.cacheWrite = num(chunk.usage.cacheWriteTokens)
            call.reasoning = num(chunk.usage.reasoningTokens)
          }
          yield chunk
        }
        state.lastCall = {
          sessionId: call.sessionId,
          provider: call.provider,
          model: call.model,
          purpose: call.purpose,
          input: call.input,
          output: call.output,
          cacheRead: call.cacheRead,
          cacheWrite: call.cacheWrite,
          reasoning: call.reasoning,
          at: call.at,
        }
      } finally {
        if (state.live === call) state.live = null
      }
    })()
  }
  ctx.on('llm/stream', (options, next) => startLive(options, next), { global: true })

  // ---- current-session context pressure estimate ----
  const measureContext = () => {
    try {
      const tokenMeter = ctx.get('tokenMeter')
      const sessions = ctx.get('sessions')
      if (!tokenMeter || !sessions || !state.activeSessionId) return null
      const session = sessions.get(state.activeSessionId)
      if (!session) return null
      const m = tokenMeter.measure(session)
      if (!m || typeof m !== 'object') return null
      return { pressure: num(m.totalTokens), surface: num(m.surfaceTokens) }
    } catch (e) {
      return null
    }
  }

  // ---- balance: node subprocess (OpenSSL TLS, network allowed) ----
  const resolveBaseURL = () => {
    try {
      const settings = ctx.get('settings')
      if (settings) {
        const ns = settings.get('llm-deepseek')
        if (ns && typeof ns === 'object' && typeof ns.baseURL === 'string' && ns.baseURL) {
          return String(ns.baseURL).replace(/\/+$/, '')
        }
      }
    } catch (e) {
      // ignore
    }
    return 'https://api.deepseek.com'
  }

  const BALANCE_SCRIPT = [
    "const base = (process.env.DEEPSEEK_BALANCE_URL || 'https://api.deepseek.com');",
    "const url = base.endsWith('/') ? base.slice(0, -1) : base;",
    "const key = process.env.DEEPSEEK_API_KEY;",
    "const ctrl = new AbortController();",
    "const t = setTimeout(() => ctrl.abort(), 15000);",
    "fetch(url + '/user/balance', { headers: { Authorization: 'Bearer ' + key }, signal: ctrl.signal })",
    "  .then(async (r) => { const body = await r.text(); process.stdout.write(JSON.stringify({ status: r.status, body })); })",
    "  .catch((e) => { process.stdout.write(JSON.stringify({ error: String((e && e.message) || e) })); })",
    "  .finally(() => clearTimeout(t));",
  ].join('\n')

  let balanceCache = null
  let balancePromise = null

  const queryBalance = async () => {
    const now = Date.now()
    const credentials = ctx.get('credentials')
    let key = null
    if (credentials) {
      try {
        const hit = await credentials.resolve('DEEPSEEK_API_KEY')
        if (hit && typeof hit.value === 'string' && hit.value) key = hit.value
      } catch (e) {
        // ignore
      }
    }
    if (!key) return { status: 'no-key', message: '未找到 DEEPSEEK_API_KEY 凭据（可在 设置→模型 页配置）', fetchedAt: now }

    const subprocess = ctx.get('subprocess')
    if (!subprocess) return { status: 'error', message: 'subprocess 服务不可用', fetchedAt: now }

    let nodePath = null
    try {
      nodePath = await subprocess.resolveExecutable('node')
    } catch (e1) {
      try {
        nodePath = await subprocess.resolveExecutable('node.exe')
      } catch (e2) {
        nodePath = null
      }
    }
    if (!nodePath) return { status: 'error', message: '无法解析 node 可执行文件', fetchedAt: now }

    const sandboxPolicy = ctx.get('sandboxPolicy')
    const cwd = (sandboxPolicy && sandboxPolicy.workspaceRoot) || 'C:\\'

    let handle
    try {
      handle = subprocess.spawn({
        argv: [nodePath, '-e', BALANCE_SCRIPT],
        cwd,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 16384 },
          stderr: { maxBytes: 4096 },
        },
        graceMs: 2000,
        env: {
          DEEPSEEK_API_KEY: key,
          DEEPSEEK_BALANCE_URL: resolveBaseURL(),
        },
      })
    } catch (e) {
      return { status: 'error', message: 'spawn 失败: ' + String((e && e.message) || e), fetchedAt: now }
    }

    try {
      await handle.done
    } catch (e) {
      try { handle.terminate() } catch (e2) { /* ignore */ }
      return { status: 'error', message: '子进程失败: ' + String((e && e.message) || e), fetchedAt: now }
    }

    let text = ''
    try {
      const read = handle.collected.stdout.readFrom(0)
      if (read) text = read.text || ''
    } catch (e) {
      // ignore
    }
    if (!text) {
      let err = ''
      try {
        const read = handle.collected.stderr.readFrom(0)
        if (read) err = read.text || ''
      } catch (e2) {
        // ignore
      }
      return { status: 'error', message: '查询无输出' + (err ? '：' + err.slice(0, 300) : ''), fetchedAt: now }
    }

    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (e) {
      return { status: 'error', message: '响应解析失败: ' + text.slice(0, 200), fetchedAt: now }
    }
    if (parsed.error) return { status: 'error', message: String(parsed.error).slice(0, 300), fetchedAt: now }
    if (parsed.status !== 200) {
      return { status: 'error', message: 'HTTP ' + parsed.status + ': ' + String(parsed.body || '').slice(0, 200), fetchedAt: now }
    }
    let data = null
    try {
      data = JSON.parse(parsed.body || '{}')
    } catch (e) {
      return { status: 'error', message: '余额 JSON 无效', fetchedAt: now }
    }
    const infos = Array.isArray(data.balance_infos)
      ? data.balance_infos.map((b) => ({
          currency: String(b.currency || ''),
          totalBalance: b.total_balance != null ? String(b.total_balance) : null,
          grantedBalance: b.granted_balance != null ? String(b.granted_balance) : null,
          toppedUpBalance: b.topped_up_balance != null ? String(b.topped_up_balance) : null,
        }))
      : []
    return { status: 'ok', isAvailable: data.is_available !== false, infos, fetchedAt: now }
  }

  const getBalance = async (force) => {
    const now = Date.now()
    if (!force && balanceCache && now - balanceCache.at < BALANCE_TTL_MS) return balanceCache.value
    if (balancePromise) return balancePromise
    balancePromise = queryBalance()
      .then((value) => {
        balanceCache = { at: Date.now(), value }
        return value
      })
      .finally(() => {
        balancePromise = null
      })
    return balancePromise
  }

  // ---- HTTP routes ----
  const sendJson = (res, value, status = 200) => {
    try {
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      })
      res.end(JSON.stringify(value))
    } catch (e) {
      // client disconnected
    }
  }

  ctx.webServer.register({
    kind: 'exact',
    path: '/api/token-monitor/usage',
    handler: async (_req, res) => {
      const payload = {
        sessions: [],
        total: {
          input: state.total.input,
          output: state.total.output,
          cacheRead: state.total.cacheRead,
          cacheWrite: state.total.cacheWrite,
          reasoning: state.total.reasoning,
          calls: state.total.calls,
        },
        activeSessionId: state.activeSessionId,
        lastCall: state.lastCall,
        live: state.live,
        context: measureContext(),
      }
      for (const [sessionId, b] of state.perSession) {
        payload.sessions.push({
          sessionId,
          input: b.input,
          output: b.output,
          cacheRead: b.cacheRead,
          cacheWrite: b.cacheWrite,
          reasoning: b.reasoning,
          calls: b.calls,
        })
      }
      payload.sessions.sort((a, b) => (b.input + b.output + b.cacheRead + b.cacheWrite) - (a.input + a.output + a.cacheRead + a.cacheWrite))
      payload.sessions = payload.sessions.slice(0, 20)
      sendJson(res, payload)
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: '/api/token-monitor/balance',
    handler: async (req, res) => {
      const force = /[?&]force=1\b/.test(req.url || '')
      sendJson(res, await getBalance(force))
    },
  })

  // ---- index tap: inject the floating widget into the web shell ----
  ctx.webServer.tapIndex((html) => {
    if (html.includes('__dshTokenMonitor__')) return html
    const script = '<script>' + WIDGET_SCRIPT + '</script>'
    const marker = '</body>'
    if (html.includes(marker)) return html.replace(marker, script + marker)
    return html + script
  })
}

// Inline browser widget: fixed bottom-right floating card, polls the two routes.
// Plain vanilla JS — no React, no bundler. Avoids backticks and ${ inside.
const WIDGET_SCRIPT = [
  '(function(){',
  "if(window.__dshTokenMonitor__)return;window.__dshTokenMonitor__=1;",
  "var CSS=" + JSON.stringify('\
.dsh-tm{position:fixed;right:14px;bottom:14px;z-index:2147483000;pointer-events:auto;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',\'PingFang SC\',\'Microsoft YaHei\',sans-serif}\
.dsh-tm-pill{display:inline-flex;align-items:center;gap:8px;padding:7px 12px;border-radius:999px;font-size:12px;cursor:pointer;background:var(--dsw-alias-bg-overlay,rgba(24,26,32,.92));border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12));color:var(--dsw-alias-label-primary,#e8eaef);box-shadow:0 4px 16px rgba(0,0,0,.28);user-select:none;white-space:nowrap}\
.dsh-tm-card{width:272px;border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-overlay,rgba(24,26,32,.95));border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12));box-shadow:0 8px 28px rgba(0,0,0,.32);color:var(--dsw-alias-label-primary,#e8eaef);font-size:12px;line-height:1.55}\
.dsh-tm-head{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));font-weight:600}\
.dsh-tm-head button{background:none;border:none;color:var(--dsw-alias-label-secondary,#9aa1ad);cursor:pointer;font-size:12px;padding:2px 8px;border-radius:6px}\
.dsh-tm-head button:hover{background:rgba(127,127,127,.15)}\
.dsh-tm-body{padding:8px 12px 10px}\
.dsh-tm-sec{margin-top:6px}\
.dsh-tm-sec:first-child{margin-top:0}\
.dsh-tm-sec-title{font-size:11px;color:var(--dsw-alias-label-secondary,#9aa1ad);margin-bottom:2px}\
.dsh-tm-row{display:flex;justify-content:space-between;gap:8px}\
.dsh-tm-val{font-variant-numeric:tabular-nums}\
.dsh-tm-live{color:var(--dsw-alias-brand-primary,#4c8dff)}\
.dsh-tm-ok{color:var(--dsw-alias-state-success-primary,#3fb56b)}\
.dsh-tm-warn{color:var(--dsw-alias-state-warn-primary,#d9a13b)}\
.dsh-tm-err{color:var(--dsw-alias-state-error-primary,#e05656)}\
.dsh-tm-muted{color:var(--dsw-alias-label-secondary,#9aa1ad)}\
.dsh-tm-refresh{margin-left:auto;background:none;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.14));color:var(--dsw-alias-label-primary,#e8eaef);border-radius:6px;padding:1px 8px;cursor:pointer;font-size:11px}\
.dsh-tm-refresh:disabled{opacity:.5;cursor:default}'),
  "var st=document.createElement('style');st.textContent=CSS;document.head.appendChild(st);",
  "var root=document.createElement('div');root.id='dsh-tm-root';document.body.appendChild(root);",
  "var usage=null,balance=null,busy=false,collapsed=false;",
  "function fmt(n){n=n||0;if(n>=1e9)return(n/1e9).toFixed(2)+'B';if(n>=1e6)return(n/1e6).toFixed(2)+'M';if(n>=1e3)return(n/1e3).toFixed(1)+'k';return String(Math.round(n));}",
  "function clock(ts){if(!ts)return '—';var d=new Date(ts),p=function(x){return String(x).padStart(2,'0')};return p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds());}",
  "function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}",
  "function loadUsage(){fetch('/api/token-monitor/usage').then(function(r){return r.json()}).then(function(v){usage=v;render()}).catch(function(){})}",
  "function loadBalance(force){if(busy)return;busy=true;render();fetch('/api/token-monitor/balance'+(force?'?force=1':'')).then(function(r){return r.json()}).then(function(v){balance=v;busy=false;render()}).catch(function(){busy=false;render()})}",
  "function render(){",
  "  var tot=usage&&usage.total?usage.total:null;",
  "  var sid=usage&&usage.activeSessionId?usage.activeSessionId:null;",
  "  var cur=null;if(sid&&usage&&usage.sessions){for(var i=0;i<usage.sessions.length;i++){if(usage.sessions[i].sessionId===sid){cur=usage.sessions[i];break;}}}",
  "  var live=usage&&usage.live?usage.live:null;",
  "  var context=usage&&usage.context?usage.context:null;",
  "  var last=usage&&usage.lastCall?usage.lastCall:null;",
  "  var totalTok=tot?(tot.input+tot.output+tot.cacheRead+tot.cacheWrite):0;",
  "  var curTok=cur?(cur.input+cur.output+cur.cacheRead+cur.cacheWrite):0;",
  "  var bMain='加载中…',bSub='',bCls='dsh-tm-muted',bDot='',bAvail='';",
  "  if(balance){",
  "    if(balance.status==='ok'){",
  "      var info=balance.infos&&balance.infos[0]?balance.infos[0]:null;",
  "      bCls=balance.isAvailable?'dsh-tm-ok':'dsh-tm-warn';",
  "      bAvail=balance.isAvailable?'<span class=\"dsh-tm-ok\">● 可用</span>':'<span class=\"dsh-tm-warn\">● 不可用</span>';",
  "      if(info&&info.totalBalance!=null){bMain=esc(info.currency||'¥')+' '+esc(info.totalBalance);var parts=[];if(info.toppedUpBalance!=null)parts.push('充值 '+esc(info.toppedUpBalance));if(info.grantedBalance!=null)parts.push('赠送 '+esc(info.grantedBalance));bSub=(parts.length?parts.join(' · '):'余额')+' · '+clock(balance.fetchedAt);}",
  "      else{bMain=balance.isAvailable?'可用':'不可用';bSub='更新于 '+clock(balance.fetchedAt);}",
  "    }else{bCls='dsh-tm-err';bMain='余额查询失败';bSub=esc(balance.message||'未知错误')+' · '+clock(balance.fetchedAt);}",
  "  }",
  "  if(collapsed){",
  "    root.innerHTML='<div class=\"dsh-tm\"><div class=\"dsh-tm-pill\" title=\"展开 Token/余额监控\"><span>⚡ '+fmt(totalTok)+'</span><span class=\"dsh-tm-muted\">|</span><span>'+bMain+'</span></div></div>';",
  "    var p=root.querySelector('.dsh-tm-pill');if(p)p.onclick=function(){collapsed=false;render()};",
  "    return;",
  "  }",
  "  var h='<div class=\"dsh-tm\"><div class=\"dsh-tm-card\">';",
  "  h+='<div class=\"dsh-tm-head\"><span>Token 用量监控</span><button title=\"收起\">—</button></div>';",
  "  h+='<div class=\"dsh-tm-body\">';",
  "  if(live){h+='<div class=\"dsh-tm-sec dsh-tm-live\"><div>▶ 生成中'+(live.model?' · '+esc(live.model):'')+'</div><div class=\"dsh-tm-val\">输入 '+fmt(live.input)+' · 输出 '+fmt(live.output)+'</div></div>';}",
  "  h+='<div class=\"dsh-tm-sec\"><div class=\"dsh-tm-sec-title\">当前会话'+(cur?' · '+cur.calls+' 次调用':'')+'</div>';",
  "  if(cur){h+='<div class=\"dsh-tm-val\">输入 '+fmt(cur.input)+' · 输出 '+fmt(cur.output)+' · 缓存 '+fmt(cur.cacheRead)+(cur.reasoning?'<div>推理 '+fmt(cur.reasoning)+'</div>':'')+'<div>合计 '+fmt(curTok)+'</div></div>';}",
  "  else{h+='<div class=\"dsh-tm-muted\">暂无记录</div>';}",
  "  if(context){h+='<div class=\"dsh-tm-muted\">上下文压力 ≈ '+fmt(context.pressure)+' · 表面 '+fmt(context.surface)+'</div>';}",
  "  h+='</div>';",
  "  h+='<div class=\"dsh-tm-sec\"><div class=\"dsh-tm-sec-title\">全部会话'+(tot?' · '+tot.calls+' 次调用':'')+'</div>';",
  "  h+='<div class=\"dsh-tm-val\">输入 '+fmt(tot?tot.input:0)+' · 输出 '+fmt(tot?tot.output:0)+' · 缓存 '+fmt(tot?tot.cacheRead:0)+'<div>合计 '+fmt(totalTok)+(tot&&tot.reasoning?'（推理 '+fmt(tot.reasoning)+'）':'')+'</div></div></div>';",
  "  if(last){h+='<div class=\"dsh-tm-sec dsh-tm-muted\"><div class=\"dsh-tm-sec-title\">最近一次调用</div><div>'+esc(last.model||'—')+' · '+clock(last.at)+' · in '+fmt(last.input)+' / out '+fmt(last.output)+'</div></div>';}",
  "  h+='<div class=\"dsh-tm-sec\"><div class=\"dsh-tm-sec-title\" style=\"display:flex;align-items:center;gap:4px\"><span>DeepSeek 余额</span><button class=\"dsh-tm-refresh\" '+(busy?'disabled':'')+'>'+(busy?'刷新中…':'刷新')+'</button></div>';",
  "  h+='<div class=\"dsh-tm-row\"><span class=\"dsh-tm-val '+bCls+'\">'+bMain+'</span>'+bAvail+'</div>';",
  "  if(bSub){h+='<div class=\"dsh-tm-muted\">'+bSub+'</div>';}",
  "  h+='</div></div></div></div>';",
  "  root.innerHTML=h;",
  "  var btn=root.querySelector('.dsh-tm-head button');if(btn)btn.onclick=function(){collapsed=true;render()};",
  "  var rf=root.querySelector('.dsh-tm-refresh');if(rf)rf.onclick=function(){loadBalance(true)};",
  "}",
  "loadUsage();loadBalance(false);",
  "setInterval(loadUsage,2500);",
  "setInterval(function(){loadBalance(false)},60000);",
  "render();",
  "})();",
].join('\n')
