/**
 * 复用 dsh-pocket 自己的推送实现，把一条通知发出去（给 dsh-revive.ps1 用）。
 *
 * 为什么走 node 而不是在 PowerShell 里重写一遍：lib/notify.js 已经实现了
 * 三个渠道的完整语义（含 WxPusher 必须读 body `code === 1000` 才算送达，
 * HTTP 200 本身是假成功）。在这里重抄一份必然和 pocket 那边漂移。
 *
 * 配置也从同一个地方读：createDefaultSettingsStore() 的 notify 段，也就是
 * 桌面端 `/desktop` 面板配的那份文件。不新增第二份凭据存储，密钥因此
 * 从不进这个脚本、不进命令行、不进日志。
 *
 * 落点说明（2026-10-11 从 `F:\defws\scripts\` 搬来）：它一行都不依赖工作区根，
 * 全部行为都来自 `../lib/`；放在消费方这一侧，import 是相对的、跟着插件一起走，
 * 也再不会有「脚本在 A 盘、lib 写死在 F 盘」那种一搬家就断的路径。
 *
 * Usage: node tools/dsh-push-notice.mjs "<title>" "<body>"
 * Exit:  0 已送达 / 2 渠道未配置（静默跳过，不是失败）/ 1 配置或发送失败
 */
import process from 'node:process'

const POCKET_LIB = new URL('../lib/', import.meta.url)

async function main() {
  const [title, body] = process.argv.slice(2)
  if (!title || !body) {
    console.error('usage: dsh-push-notice.mjs <title> <body>')
    return 1
  }

  let notifySend
  let createDefaultSettingsStore
  try {
    ;({ notifySend } = await import(new URL('notify.js', POCKET_LIB)))
    ;({ createDefaultSettingsStore } = await import(new URL('settings-store.js', POCKET_LIB)))
  } catch (error) {
    console.error(`cannot load pocket notify libs: ${error?.message ?? error}`)
    return 1
  }

  const doc = createDefaultSettingsStore().load()
  const notify = doc.notify
  if (notify.enabled !== true || notify.channel === 'off' || notify.key === '') {
    // 没配渠道是预期状态，不是错误：重启照做，只是不推。
    console.log('channel-not-configured: skipped')
    return 2
  }

  const delivered = await notifySend(notify, title, body, {
    log: (level, message) => console.error(`${level}: ${message}`)
  })
  console.log(delivered ? 'push-delivered' : 'push-failed')
  return delivered ? 0 : 1
}

main().then((code) => process.exit(code))
