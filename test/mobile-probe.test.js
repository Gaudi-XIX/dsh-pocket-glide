/*
 * F 埋点收口端点 `/api/mobile-probe` 的契约（0.4.19，临时取证用）。
 *
 * 这个端点的性质是「手机能往宿主的 pocket.log 里写一行」，所以三条都必须钉住：
 *  ① 没有手机 cookie 进不来（不是任意人可写的口子）；
 *  ② 落盘的那一行只剩数字/字母/分隔符，`<` `>` `"` `(` 一律进不去（日志会被别人读，
 *     也不能被一行手机发来的文本伪造出别的事件）；
 *  ③ 一秒内的连发丢掉 —— 埋点自己就有 1.5 s 攒批窗口，限流只少段时间线，不改结论方向。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startBridge, httpFetch } from './helpers.js'

function post(base, cookie, body) {
  return httpFetch(`${base}/api/mobile-probe`, {
    method: 'POST',
    headers: {
      'content-type': 'text/plain',
      origin: base, // 同源：这本来就是手机页发给自己 origin 的相对请求
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body,
  })
}

const probeLines = (t) => t.logs.filter(({ message }) => message.includes('kbprobe'))

test('the probe sink refuses an unauthenticated phone', async () => {
  const t = await startBridge()
  try {
    const res = await post(t.base, null, 'rz@10|20|854|844|420|420|0')
    assert.notEqual(res.status, 200, '没配对的请求不能写宿主日志')
    assert.equal(probeLines(t).length, 0, '而且一行都不落')
  } finally {
    await t.stop()
  }
})

test('a probe line lands sanitised, and a burst inside a second is dropped', async () => {
  const t = await startBridge()
  try {
    const cookie = await t.pairMobile()
    const first = await post(
      t.base,
      cookie,
      'sc@900|120|2000|844|<script>alert(1)</script>"x|rz@901|/api/x\n[info] forged-line',
    )
    assert.equal(first.status, 200)
    assert.equal((await first.json()).logged, true, '第一件收下')

    const landed = probeLines(t).pop()
    assert.ok(landed, '落了一行可 grep 的 kbprobe')
    for (const bad of ['<', '>', '"', '(', ')']) {
      assert.ok(!landed.message.includes(bad), `危险字符 ${bad} 进不了日志`)
    }
    // 这条是真正的要害：一次手机请求**不得造出第二行日志**（换行折成空格，整条仍是一行）
    assert.ok(!landed.message.includes('\n'), '换行被折平 ⇒ 伪造不出第二行')
    assert.equal(probeLines(t).length, 1, '一发请求恰好一行， forged 的那截只当文本跟在后面')
    assert.ok(landed.message.startsWith('kbprobe device='), '行首仍由服务端写，不被正文顶掉')
    assert.ok(landed.message.includes('rz@901'), '数字与竖线该留的都留了（取证要看的就是这些）')
    assert.ok(landed.message.includes('/api/x'), '斜杠与点保留（埋点里会出现路径样式）')

    const second = await post(t.base, cookie, 'sc@902|1|2|3')
    assert.equal((await second.json()).throttled, true, '一秒内的第二件丢掉')
    assert.equal(probeLines(t).length, 1, '被限流的那件不写日志')
  } finally {
    await t.stop()
  }
})
