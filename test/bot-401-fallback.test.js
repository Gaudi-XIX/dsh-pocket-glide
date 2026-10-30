// Q4 配套② · `/bot` 401 兜底（判据：ui-unify-pocket-bot-20261030「第 4 条补充 · Q4 返回键行为」）
//
// 背景：Pocket 落地页用 `location.replace('/bot')` 交出自己的历史条目，于是 `/bot`
// 变成无前序文档可退的最后一跳。若未授权时它只回一行纯文本 401，手机上就彻底
// 失去回到 Pocket 重新配对的入口。所以只对 `/bot` 这条路回一个带按钮的 401 页，
// 其余未授权路径的 401 形状（纯文本 `Pair your phone again.`）必须原样不动。
import test from 'node:test'
import assert from 'node:assert/strict'
import { httpFetch, startBridge } from './helpers.js'

test('an unpaired /bot answers 401 with a page that carries the way back to Pocket', async () => {
  const app = await startBridge()
  try {
    const res = await httpFetch(`${app.base}/bot`, {
      headers: { 'user-agent': 'PocketUnpaired/1.0' },
    })
    const body = await res.text()
    assert.equal(res.status, 401, 'the refusal still is a refusal')
    assert.match(body, /<button[^>]*id="pocket-back"/, 'the page carries a button')
    assert.match(body, /location\.replace\('\/'\)/, 'the button goes back to the Pocket root')
    assert.match(body, /<script nonce="[^"]+"/, 'the inline script rides the per-request nonce')
  } finally {
    await app.stop()
  }
})

test('every other unauthenticated path keeps the plain-text 401', async () => {
  const app = await startBridge()
  try {
    const res = await httpFetch(`${app.base}/api/status`, {
      headers: { 'user-agent': 'PocketUnpaired/1.0' },
    })
    const body = await res.text()
    assert.equal(res.status, 401, 'the refusal is unchanged')
    assert.equal(body, 'Pair your phone again.', 'and it is still that one line of prose')
    assert.doesNotMatch(body, /<button/, 'no button was spread to the other paths')
    assert.doesNotMatch(body, /location\.replace/, 'and no script either')
  } finally {
    await app.stop()
  }
})
