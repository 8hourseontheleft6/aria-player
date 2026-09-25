/**
 * 外部模型 API：调用**用户自己填**的接口。
 *
 * 为什么放在主进程：
 *  1. 渲染层的 CSP 只允许 self / app: / media: / remote:，外部 HTTP 请求发不出去；
 *  2. 密钥留在主进程更安全 —— 设置页只把新填的值送进来，从不把已存的密钥读回渲染层；
 *  3. 主进程已经有一套带超时与重试的 net.fetch 用法（见 services/online.js），照抄风格即可。
 *
 * 协议按 **OpenAI 兼容的 /chat/completions** 实现。这样一来不止 OpenAI：
 * DeepSeek、Moonshot、通义、以及本地跑的 Ollama / LM Studio / vLLM 都只需要改
 * 「接口地址」一个字段（本地地址常见形如 http://127.0.0.1:11434/v1）。
 *
 * 目前只有**一个用途**：判断歌曲风格，用来挑均衡器预设。
 * 发给模型的只有歌曲信息与本地算出的三个特征；**音频文件不会上传**。
 */

const { net } = require('electron')

/** 默认超时：推理接口比普通 HTTP 慢得多，给足 30 秒 */
const DEFAULT_TIMEOUT = 30000

function normalizeBase (baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '')
}

/** 错误信息里绝不能出现密钥 */
function redact (message, key) {
  const text = String(message || '')
  if (!key) return text
  return text.split(key).join('***')
}

function createAiService (ctx) {
  const settings = ctx.get('settings')

  function config () {
    const ai = settings.get().ai || {}
    return {
      enabled: ai.enabled === true,
      baseUrl: normalizeBase(ai.baseUrl),
      key: typeof ai.key === 'string' ? ai.key : '',
      model: typeof ai.model === 'string' ? ai.model : '',
      timeout: Number.isFinite(ai.timeout) ? ai.timeout : DEFAULT_TIMEOUT
    }
  }

  function configured () {
    const conf = config()
    return Boolean(conf.baseUrl && conf.model)
  }

  /**
   * 发一次对话请求，返回助手文本。
   * @param {object} payload { messages, temperature, maxTokens }
   */
  async function chat (payload = {}) {
    const conf = config()
    if (!conf.enabled) return { ok: false, message: '外部模型未启用' }
    if (!conf.baseUrl) return { ok: false, message: '还没有填写接口地址' }
    if (!conf.model) return { ok: false, message: '还没有填写模型名' }

    const messages = Array.isArray(payload.messages) ? payload.messages : []
    if (!messages.length) return { ok: false, message: '没有要发送的内容' }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), conf.timeout)
    try {
      const response = await net.fetch(`${conf.baseUrl}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(conf.key ? { Authorization: `Bearer ${conf.key}` } : {})
        },
        body: JSON.stringify({
          model: conf.model,
          messages,
          temperature: payload.temperature ?? 0,
          max_tokens: payload.maxTokens ?? 200,
          stream: false
        })
      })

      const text = await response.text()
      if (!response.ok) {
        return {
          ok: false,
          status: response.status,
          message: redact(`接口返回 ${response.status}：${text.slice(0, 200)}`, conf.key)
        }
      }

      let data = null
      try {
        data = JSON.parse(text)
      } catch {
        return { ok: false, message: '接口返回的不是 JSON' }
      }
      const content = data?.choices?.[0]?.message?.content
      if (typeof content !== 'string' || !content.trim()) {
        return { ok: false, message: '接口没有返回内容' }
      }
      return { ok: true, content: content.trim(), model: data.model || conf.model }
    } catch (err) {
      const aborted = err?.name === 'AbortError'
      return {
        ok: false,
        message: redact(aborted ? `请求超时（${conf.timeout / 1000}s）` : `请求失败：${err?.message || err}`, conf.key)
      }
    } finally {
      clearTimeout(timer)
    }
  }

  /** 设置页的「测试连接」：发一句最小请求，看能不能通 */
  async function test () {
    if (!config().enabled) return { ok: false, message: '先打开「启用」再测试' }
    if (!configured()) return { ok: false, message: '接口地址与模型名都要填' }
    const result = await chat({
      messages: [
        { role: 'system', content: '你是一个连通性测试端点，只回复 OK。' },
        { role: 'user', content: 'ping' }
      ],
      maxTokens: 8
    })
    if (!result.ok) return result
    return { ok: true, message: `连接成功（${result.model}）：${result.content.slice(0, 40)}`, model: result.model }
  }

  return { chat, test, configured, config }
}

module.exports = { createAiService }
