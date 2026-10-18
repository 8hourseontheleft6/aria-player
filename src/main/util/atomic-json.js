'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

/** 同目录临时文件 + fsync + rename；失败时保留原文件，不留下半份 JSON。 */
async function writeJsonAtomic (file, value, { backup = false } = {}) {
  const text = JSON.stringify(value, null, 2)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  let handle
  try {
    handle = await fs.open(temporary, 'wx', 0o600)
    await handle.writeFile(text, 'utf8')
    await handle.sync()
    await handle.close()
    handle = null
    if (backup) {
      let previous
      try {
        previous = JSON.parse(await fs.readFile(file, 'utf8'))
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
      if (previous !== undefined) await writeJsonAtomic(`${file}.bak`, previous)
    }
    await fs.rename(temporary, file)
  } finally {
    if (handle) await handle.close().catch(() => {})
    await fs.rm(temporary, { force: true }).catch(() => {})
  }
}

module.exports = { writeJsonAtomic }
