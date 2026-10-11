/*
 * 滚动时序埋点收口端点 `/api/mobile-probe` 的契约（0.4.25 起随工具常设）。
 *
 * 这个端点的性质是「手机能往宿主的 pocket.log 里写一行」，所以四条都必须钉住：
 *  ① 没有手机 cookie 进不来（不是任意人可写的口子）；
 *  ② 落盘那一行只剩数字/字母/分隔符——`<` `>` `"` `()` 与**换行**一律进不去，
 *     换行能伪造出第二行日志（第一版白名单放过 `\s`，就是被这条抓出来的）；
 *  ③ 一秒内的连发丢弃（埋点自己 1.5 s 攒批，被丢的只少段时间线，不改结论方向）；
 *  ④ 开关要活过 SW 对 URL 的改写 —— 真机栽过一次：装的是 `/?revalidate=1`，标记丢了，
 *     用户点了半天，日志里 0 条。这条钉住「armed 必须自己发一条 on 可证」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mobilePageAssets } from '../lib/pages.js'
import { startBridge, httpFetch } from './helpers.js'

const LF = String.fromCharCode(10)
const DQUOTE = String.fromCharCode(34)

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
    // 危险样本用字符码显式造：把 \n 和引号混进字面量里出过转义事故
    const nasty = 'sc@900|120|2000|844|<script>alert(1)</script>'
      + LF + DQUOTE + 'x|rz@901|/api/x' + LF + '[info] forged-line'
    const first = await post(t.base, cookie, nasty)
    assert.equal(first.status, 200)
    assert.equal((await first.json()).logged, true, '第一件收下')

    const landed = probeLines(t).pop()
    assert.ok(landed, '落了一行可 grep 的 kbprobe')
    for (const ch of ['<', '>', DQUOTE, '(', ')']) {
      assert.ok(!landed.message.includes(ch), `危险字符 ${ch === DQUOTE ? '"' : ch} 进不了日志`)
    }
    assert.ok(!landed.message.includes(LF), '换行被折平 ⇒ 伪造不出第二行')
    assert.equal(probeLines(t).length, 1, '一发请求恰好一行，forged 那截只当文本跟在后面')
    assert.ok(landed.message.startsWith('kbprobe device='), '行首由服务端写，不被正文顶掉')
    assert.ok(landed.message.includes('rz@901'), '数字与竖线该留的都留了（取证要看的就是这些）')
    assert.ok(landed.message.includes('/api/x'), '斜杠与点保留（埋点里会出现路径样式）')

    const second = await post(t.base, cookie, 'sc@902|1|2|3')
    assert.equal((await second.json()).throttled, true, '一秒内的第二件丢掉')
    assert.equal(probeLines(t).length, 1, '被限流的那件不写日志')
  } finally {
    await t.stop()
  }
})

test('开关活过 SW 的 URL 改写，且 armed 可自证', () => {
  const js = mobilePageAssets({ locale: 'zh' }).js
  assert.match(js, /var PROBE_ON=false/, '不由 location.search 单独决定（默认关）')
  assert.match(js, /localStorage\.getItem\('pocketProbe'\)/, '读持久化凭据')
  assert.match(js, /localStorage\.setItem\('pocketProbe',String\(Date\.now\(\)\+216e5\)\)/,
    '命中或仍在期内就续一份 6 小时到期的凭据（临时仪器不该永久开着）')
  assert.match(js, /localStorage\.removeItem\('pocketProbe'\)/, '过期自己删掉，不留残余')
  assert.match(js, /if\(PROBE_ON\)setTimeout\(\(\)=>probeMark\('on'\),300\)/,
    'armed 后立刻发一条 on：有没有在记必须可证，不能靠缺席推断')
})
