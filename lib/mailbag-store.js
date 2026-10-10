/**
 * 邮包的落盘（mailbag file）：宿主要重启了，攒着没寄的平邮不该跟着没。
 *
 * 为什么要有这个文件。这只包存在的唯一理由就是「这一轮额度用完了，等下一次入站再寄」，
 * 而这台宿主今天重启了不止一次——桥一起来，内存里的包就是空的，攒的信全没了，
 * 用户看到的仍然是「消息没到」。所以包必须落在盘上，跟它服务的对象（会话档案、
 * 配对记录）一样跨重启。
 *
 * 只存平邮（任务完成），不存挂号信（等你回答的提问）：跑完的会话不会因为重启而变得
 * 没跑完，那条消息放一小时仍然为真；而「有问题等你回答」是否还成立只有活着的桥知道
 * （提问可能已被回答或随宿主一起消失），存下来补发就是拿一件可能过去了的事催人。
 *
 * 写盘纪律照 lib/settings-store.js 与 lib/session-store.js：同目录临时文件 + 原子
 * rename + POSIX `0600` + 目录按需创建；读不出来（半截写、被人改坏、版本不认识）
 * 一律读成空包 —— 这最坏等于「没有这个文件」，也就是没有落盘之前的行为，不会更差。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { defaultDataDir } from './pin-store.js'

/** 数据目录里的文件名。 */
export const MAILBAG_FILE_NAME = 'notify-mailbag.json'

/** 文档结构版本；对不上就当空包读。 */
export const MAILBAG_DOC_VERSION = 1

/** 一个文件最多存多少封（手改出来的文件不能把内存吃穿）。 */
export const MAILBAG_MAX_LETTERS = 32

/** 单封信标题/正文的长度上限。 */
export const MAILBAG_TEXT_MAX = 240

/** @returns {string} 邮包文件的绝对路径 */
export function mailbagPath(dataDir) {
  return join(dataDir, MAILBAG_FILE_NAME)
}

/** @returns {{ v: number, savedAt: number, ordinary: [] }} */
function emptyDocument() {
  return { v: MAILBAG_DOC_VERSION, savedAt: 0, ordinary: [] }
}

/** @param {unknown} value @returns {string} */
function str(value) {
  if (typeof value !== 'string') return ''
  return value.length > MAILBAG_TEXT_MAX ? value.slice(0, MAILBAG_TEXT_MAX) : value
}

/**
 * 把读到手的东西整形成文档形状。逐封整形成：一封坏的不该连累旁边那封好的。
 * @param {unknown} candidate
 */
function sanitizeDocument(candidate) {
  const doc = emptyDocument()
  if (!candidate || typeof candidate !== 'object') return doc
  if (candidate.v !== MAILBAG_DOC_VERSION) return doc
  doc.savedAt = Number.isFinite(candidate.savedAt) ? candidate.savedAt : 0
  const letters = Array.isArray(candidate.ordinary) ? candidate.ordinary : []
  for (const letter of letters) {
    if (doc.ordinary.length >= MAILBAG_MAX_LETTERS) break
    if (!letter || typeof letter !== 'object') continue
    const title = str(letter.title)
    const body = str(letter.body)
    if (!title && !body) continue
    doc.ordinary.push({
      key: str(letter.key) || `t:${title}`,
      title,
      body,
      inAt: Number.isFinite(letter.inAt) ? letter.inAt : doc.savedAt
    })
  }
  return doc
}

/**
 * 原子写入。
 * @param {string} filePath
 * @param {{ ordinary?: { key?: string, title?: string, body?: string, inAt?: number }[], savedAt?: number }} state
 * @returns {boolean} false ＝ 没写成
 */
export function writeMailbag(filePath, state) {
  const document = {
    v: MAILBAG_DOC_VERSION,
    savedAt: typeof state.savedAt === 'number' ? state.savedAt : Date.now(),
    ordinary: (Array.isArray(state.ordinary) ? state.ordinary : []).slice(0, MAILBAG_MAX_LETTERS)
  }
  const temporary = `${filePath}.${randomUUID()}.tmp`
  try {
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(temporary, `${JSON.stringify(document, undefined, 2)}\n`, { mode: 0o600 })
    renameSync(temporary, filePath)
    return true
  } catch {
    try {
      if (existsSync(temporary)) unlinkSync(temporary)
    } catch {
      // 调用方拿 false 当「没写成」处理，这里不再往上抛。
    }
    return false
  }
}

/**
 * @typedef {object} MailbagStore
 * @property {() => { ordinary: { key: string, title: string, body: string, inAt: number }[], savedAt: number }} load
 * @property {(state: Parameters<typeof writeMailbag>[1]) => boolean} save
 */

/**
 * @param {string} dataDir
 * @param {{ readFile?: typeof readFileSync, filePath?: string }} [hooks]
 * @returns {MailbagStore}
 */
export function createMailbagStore(dataDir, hooks = {}) {
  const filePath = hooks.filePath ?? mailbagPath(dataDir)
  const readFile = hooks.readFile ?? readFileSync
  return {
    load() {
      try {
        const doc = sanitizeDocument(JSON.parse(readFile(filePath, 'utf8')))
        return { ordinary: doc.ordinary, savedAt: doc.savedAt }
      } catch {
        // 没有文件、半截写、被人改坏：都是空包，跟没有落盘之前一样。
        return { ordinary: [], savedAt: 0 }
      }
    },
    save(state) {
      return writeMailbag(filePath, state)
    }
  }
}

/** @returns {MailbagStore} 数据目录用仓里那一个（和配对记录、设置档同处） */
export function createDefaultMailbagStore() {
  return createMailbagStore(defaultDataDir())
}
