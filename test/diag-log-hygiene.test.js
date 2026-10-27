// /__diag 的日志卫生（审核 B2-P2-6）。这个端点故意不鉴权、不回包、只写一行 warn：
// 它是手机页在未配对状态唯一能到达的报障口。原先的清洗只有 `\s+ → ' '`，而 ESC(0x1b)
// 不是空白字符，于是带 ANSI 的 beacon 能把颜色码与光标控制序列原样写进 pocket.log——
// 足以伪造日志行、破坏 grep。修法是把清洗做全：先剥 CSI 序列，再剔 C0/C1 控制字符，
// 最后才折叠空白。这条测试钉住「控制字符一个都不进日志」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startBridge, httpFetch } from './helpers.js'

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/

test('a diag beacon cannot carry ANSI escapes into the desktop log', async () => {
  const t = await startBridge({ harness: 'fake' })
  try {
    // 真实的 ANSI 颜色串 + 一个裸 BEL：前者是 CSI 序列，后者是必须被剔掉的单字节控制符。
    const payload = '\u001b[31mred\u001b[0m \u0007bell'
    const res = await httpFetch(t.base + '/__diag', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: payload,
    })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { ok: true })

    const lines = t.logs.filter(({ message }) => message.includes('client diag'))
    assert.equal(lines.length, 1, 'the beacon is logged exactly once')
    const line = lines[0].message
    assert.doesNotMatch(line, CONTROL, 'no control character reaches the log line')
    assert.match(line, /red/, 'the payload itself stays readable')
    assert.match(line, /bell/, 'both halves of the payload survive as text')
    assert.equal(line.split('\n').length, 1, 'the log entry is one line')
  } finally { await t.stop() }
})

test('a diag beacon that is pure ANSI noise still writes one clean line', async () => {
  const t = await startBridge({ harness: 'fake' })
  try {
    const res = await httpFetch(t.base + '/__diag', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '\u001b[2J\u001b[H\u001b[38;5;196m',
    })
    assert.equal(res.status, 200)
    const lines = t.logs.filter(({ message }) => message.includes('client diag'))
    assert.equal(lines.length, 1)
    assert.doesNotMatch(lines[0].message, CONTROL)
    assert.equal(lines[0].message.trim(), 'client diag', 'nothing but stripped noise was sent')
  } finally { await t.stop() }
})
