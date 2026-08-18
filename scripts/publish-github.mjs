// publish-github.mjs — publish dsh-token-monitor to GitHub:
// sync package files, set topics, (re)create the release, build and upload the zip asset.
// Idempotent: re-running updates files/topics and recreates the tag/release.
// Usage: node scripts/publish-github.mjs   (requires DSH_GH_TOKEN in env; DSH_GH_TAG optional)
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildZip } from './build-zip.mjs'

const token = process.env.DSH_GH_TOKEN
if (!token) throw new Error('DSH_GH_TOKEN env missing')

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const NAME = 'dsh-token-monitor'
const TAG = process.env.DSH_GH_TAG || 'v1.0.0'
const TOPICS = ['deepseek-harness', 'dsh-plugin', 'token-monitor', 'monitoring', 'deepseek']
// Every file synced into the repo, including the scripts themselves.
const FILES = [
  'index.js',
  'package.json',
  'README.md',
  'LICENSE',
  '.gitignore',
  'scripts/build-zip.mjs',
  'scripts/publish-github.mjs',
  'scripts/upload-github.mjs',
]
// The release zip asset: only the install files (what you copy into $DSH_HOME/profiles/web/).
const ZIP_FILES = ['index.js', 'package.json', 'README.md', 'LICENSE', '.gitignore']
const ZIP = path.join(REPO_ROOT, 'dist', `dsh-token-monitor-${TAG}.zip`)

async function gh(method, pathname, body, headers = {}) {
  const res = await fetch('https://api.github.com' + pathname, {
    method,
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'token-monitor-publish',
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* non-json */ }
  if (!res.ok) {
    const e = new Error(`${method} ${pathname} -> HTTP ${res.status}: ${text.slice(0, 300)}`)
    e.status = res.status
    throw e
  }
  return json
}

const me = await gh('GET', '/user')
const full = `${me.login}/${NAME}`
console.log('auth as @' + me.login)

// 1. sync all repo files (creates or updates)
for (const file of FILES) {
  const buf = fs.readFileSync(path.join(REPO_ROOT, file))
  const pathname = `/repos/${full}/contents/${file}`
  try {
    await gh('PUT', pathname, { message: 'chore: sync ' + file, content: buf.toString('base64') })
  } catch (e) {
    if (e.status !== 422) throw e
    const existing = await gh('GET', pathname)
    await gh('PUT', pathname, { message: 'chore: sync ' + file, content: buf.toString('base64'), sha: existing.sha })
  }
  console.log('synced ' + file)
}

// 2. topics
await gh('PUT', `/repos/${full}/topics`, { names: TOPICS })
console.log('topics set: ' + TOPICS.join(', '))

// 3. tag + release (idempotent: drop a previous release first)
try { await gh('DELETE', `/repos/${full}/git/refs/tags/${TAG}`) } catch { /* absent */ }
try {
  const existing = await gh('GET', `/repos/${full}/releases/tags/${TAG}`)
  await gh('DELETE', `/repos/${full}/releases/${existing.id}`)
} catch { /* absent */ }
const release = await gh('POST', `/repos/${full}/releases`, {
  tag_name: TAG,
  name: TAG,
  body: [
    'v1.0.0 — DSH 静态 Host 插件：Web 界面右下角实时监控 token 用量与 DeepSeek 账户余额。',
    '',
    '- 真实 token 用量（provider usage）按会话/全局累计，含在途调用与上下文压力',
    '- DeepSeek 账户余额实时查询（60s 缓存 + 手动刷新）',
    '- 纯 Host 插件，无构建步骤，随部署配置自启、重启不丢',
    '',
    '安装与使用见 README。',
  ].join('\n'),
  draft: false,
  prerelease: false,
})
console.log('release created: ' + release.html_url)

// 4. build + upload zip asset
const zipBuf = fs.readFileSync(buildZip(ZIP_FILES.map((f) => ({ name: f, buffer: fs.readFileSync(path.join(REPO_ROOT, f)) })), ZIP))
const assetUrl = release.upload_url.replace('{?name,label}', '') + '?name=' + encodeURIComponent(`dsh-token-monitor-${TAG}.zip`)
const assetRes = await fetch(assetUrl, {
  method: 'POST',
  headers: {
    Authorization: 'Bearer ' + token,
    'User-Agent': 'token-monitor-publish',
    'Content-Type': 'application/zip',
    Accept: 'application/vnd.github+json',
  },
  body: zipBuf,
})
const assetText = await assetRes.text()
if (!assetRes.ok) throw new Error('asset upload -> HTTP ' + assetRes.status + ': ' + assetText.slice(0, 300))
const asset = JSON.parse(assetText)
console.log('asset uploaded: ' + asset.browser_download_url)
console.log('DONE: ' + release.html_url)
