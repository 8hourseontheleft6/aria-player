'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

// 显式展开文件列表，兼容 Windows cmd 与 Node 20，不依赖 shell 通配符。
const directory = path.join(__dirname, '..', 'backend-tests')
const files = fs.readdirSync(directory).filter((name) => name.endsWith('.test.js')).sort()
if (!files.length) throw new Error('没有找到后端回归测试')
const result = spawnSync(process.execPath, ['--test', ...files.map((name) => path.join(directory, name))], { stdio: 'inherit' })
if (result.error) throw result.error
process.exit(result.status === null ? 1 : result.status)
