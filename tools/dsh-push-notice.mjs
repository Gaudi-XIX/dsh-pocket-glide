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
 * 落点说明（2026-10-11 从 `F:\work\scripts\` 搬来）：它一行都不依赖工作区根，
 * 全部行为都来自 `../lib/`；放在消费方这一侧，import 是相对的、跟着插件一起走，
 * 也再不会有「脚本在 A 盘、lib 写死在 F 盘」那种一搬家就断的路径。
 *
 * Usage: node tools/dsh-push-notice.mjs "<title>" "<body>"
 * Exit:  0 已送达 / 2 渠道未配置（静默跳过，不是失败）/ 1 配置或发送失败
 */
import process from 'node:process'

const POCKET_LIB = new URL('../lib/', import.meta.url)

/**
 * 诊断模式（0.4.26 起是面板上的一个开关）：开着时交给手机的公网入口一律带 ?probe=1，
 * 页内埋点据此武装并把滚动时序回传到 pocket.log。
 *
 * 桥自己推地址的两条路已经按开关走了——微信回话那条在 lib/bridge.js 的 inbound 分支，
 * 配对页那条在 /desktop 的渲染里。这个脚本是第三条路，而它以前得靠人记得手打 ?probe=1：
 * 开关关着照样能发带诊断的链接，等于开关只管两条半路。所以改成机械跟随：
 * 开关开着就补，关着就发裸地址，调用方不需要知道这件事。
 *
 * URL 的字符集刻意排除中文标点与右括号：推送文案里地址后面常紧跟「，进页面后…」，
 * 不排除的话问号会插到那个逗号后面，链接当场失效。已带 probe 参数的原样返回，重复调用幂等。
 */
function withProbeSuffix(text, probe) {
  if (!probe || typeof text !== 'string') return text
  return text.replace(/https?:\/\/[^\s，。、；：！？"'）】〉》]+/g, (raw) => {
    try {
      // 用 URL 类构造，不拼字符串：和桥那边出的 https://<host>/?probe=1 逐字节一致，
      // 两条路发的链接不会出现「有斜杠/没斜杠」两种形状。
      const url = new URL(raw)
      if (url.searchParams.get('probe')) return raw
      url.searchParams.set('probe', '1')
      return url.toString()
    } catch {
      return raw
    }
  })
}

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

  const probe = doc.diagnostics?.probe === true
  const delivered = await notifySend(notify, withProbeSuffix(title, probe), withProbeSuffix(body, probe), {
    log: (level, message) => console.error(`${level}: ${message}`)
  })
  // 状态行走 stderr，而 dsh-revive.ps1 在 PowerShell 5.1 下按 GBK 收它——写中文会变成乱码
  // （20:46 实测：`diagnostics: probe 宸插紑鍚?..`）。所以这行一律 ASCII。
  if (probe) console.error('diagnostics: probe is on, probe=1 appended to links in this push')
  console.log(delivered ? 'push-delivered' : 'push-failed')
  return delivered ? 0 : 1
}

main().then((code) => process.exit(code))
