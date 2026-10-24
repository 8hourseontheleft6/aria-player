#!/usr/bin/env node
/**
 * 把 GitHub Release 上某个版本的安装包拉回本地归档目录。
 *
 *   npm run fetch-release 0.1.0
 *
 * 归档位置与 `npm run clean:dist` 一致（那个命令默认就是把旧版本挪到这儿）：
 *   release/_archive/<版本>/          ← Aria
 *   release-player/_archive/<版本>/   ← Aria Player
 *   release-unified/_archive/<版本>/  ← Aria Unified
 *
 * 校验用 GitHub API 返回的 `digest`（sha256），不需要手抄 SHA256 表。
 * 已存在且校验通过的文件会跳过，所以可以反复跑。
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const repoUrl = String(pkg.repository && pkg.repository.url ? pkg.repository.url : '')
const match = /github\.com[/:]([^/]+)\/([^/.]+)/.exec(repoUrl)
if (!match) {
  console.error('package.json 里没有可用的 GitHub 仓库地址（repository.url）')
  process.exit(2)
}
const [, OWNER, REPO] = match

const version = String(process.argv[2] || '').replace(/^v/, '')
if (!version) {
  console.error('用法：npm run fetch-release <版本>（例如 npm run fetch-release 0.1.0）')
  process.exit(2)
}

const mb = (bytes) => (bytes / 1024 / 1024).toFixed(2)

/** 按文件名判断它属于哪个产品的目录 */
function dirOf (name) {
  if (/^Aria-Unified-/.test(name)) return 'release-unified'
  if (/^Aria-Player-/.test(name)) return 'release-player'
  return 'release'
}

function token () {
  try {
    const out = execFileSync('git', ['credential', 'fill'], {
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8',
      timeout: 15000
    })
    const line = String(out).split('\n').find((item) => item.startsWith('password='))
    return line ? line.slice('password='.length).trim() : ''
  } catch {
    return ''
  }
}

async function main () {
  const TOKEN = token()
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'aria-fetch-release',
    ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {})
  }

  const response = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/tags/v${version}`, { headers })
  if (!response.ok) throw new Error(`拿不到 v${version} 的 Release（HTTP ${response.status}）`)
  const release = await response.json()
  const assets = (release.assets || []).filter((asset) => /\.exe$/i.test(asset.name))
  if (!assets.length) throw new Error(`v${version} 的 Release 里没有 exe 附件`)

  let failed = 0
  for (const asset of assets) {
    const dir = dirOf(asset.name)
    const target = path.join(ROOT, dir, '_archive', version)
    fs.mkdirSync(target, { recursive: true })
    const file = path.join(target, asset.name)
    const expected = String(asset.digest || '').replace(/^sha256:/, '')

    if (fs.existsSync(file) && expected) {
      const existing = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
      if (existing === expected) {
        console.log(`  ✓ 已归档且校验通过：${dir}/_archive/${version}/${asset.name}`)
        continue
      }
    }

    process.stdout.write(`  下载 ${asset.name} …`)
    const download = await fetch(asset.browser_download_url, { redirect: 'follow', headers: { 'User-Agent': 'aria-fetch-release' } })
    if (!download.ok) { failed++; process.stdout.write(` HTTP ${download.status} ✗\n`); continue }
    const buffer = Buffer.from(await download.arrayBuffer())
    const digest = crypto.createHash('sha256').update(buffer).digest('hex')
    if (expected && digest !== expected) {
      failed++
      process.stdout.write(` ${mb(buffer.length)} MB  sha256 ✗ 不符（已丢弃）\n`)
      continue
    }
    fs.writeFileSync(file, buffer)
    process.stdout.write(` ${mb(buffer.length)} MB  sha256 ✓\n`)
  }

  console.log('')
  console.log(failed ? `  ${failed} 个附件失败` : `  v${version} 已归档到 release*/_archive/${version}/`)
  console.log('  用 npm run artifacts -- --all 看全部归档。')
  process.exit(failed ? 1 : 0)
}

main().catch((err) => {
  console.error('  失败：' + (err && err.message))
  process.exit(1)
})
