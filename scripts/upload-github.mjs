// upload-github.mjs — create (or reuse) the GitHub repo and upload the package files
// via the REST API (no git binary needed). Simpler sibling of publish-github.mjs:
// no topics, no release, no zip asset.
// Usage: node scripts/upload-github.mjs   (requires DSH_GH_TOKEN in env)
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const token = process.env.DSH_GH_TOKEN
if (!token) throw new Error('DSH_GH_TOKEN env missing')

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const NAME = 'dsh-token-monitor'
const DESC = 'DSH 静态 Host 插件：Web 界面右下角实时监控 token 用量与 DeepSeek 账户余额'
const FILES = [
  'index.js',
  'package.json',
  'README.md',
  'LICENSE',
  '.gitignore',
  'cordis.patch.yml',
  'scripts/build-zip.mjs',
  'scripts/publish-github.mjs',
  'scripts/upload-github.mjs',
]

async function gh(method, pathname, body) {
  const res = await fetch('https://api.github.com' + pathname, {
    method,
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'token-monitor-upload',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* non-json */ }
  if (!res.ok) {
    const err = new Error(`${method} ${pathname} -> HTTP ${res.status}: ${text.slice(0, 300)}`)
    err.status = res.status
    throw err
  }
  return json
}

const me = await gh('GET', '/user')
console.log('auth as @' + me.login)

let repo
try {
  repo = await gh('POST', '/user/repos', { name: NAME, private: false, description: DESC })
  console.log('created repo ' + repo.full_name)
} catch (e) {
  if (e.status !== 422) throw e
  repo = await gh('GET', '/repos/' + me.login + '/' + NAME)
  console.log('repo already exists: ' + repo.full_name)
}

for (const file of FILES) {
  const buf = fs.readFileSync(path.join(REPO_ROOT, file))
  const content = buf.toString('base64')
  const pathname = `/repos/${repo.full_name}/contents/${file}`
  try {
    await gh('PUT', pathname, { message: 'Add ' + file, content })
  } catch (e) {
    if (e.status !== 422) throw e
    const existing = await gh('GET', pathname)
    await gh('PUT', pathname, { message: 'Update ' + file, content, sha: existing.sha })
  }
  console.log('uploaded ' + file)
}

console.log('DONE: https://github.com/' + repo.full_name)
