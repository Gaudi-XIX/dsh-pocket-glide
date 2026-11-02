// Q4 配套② · `/bot` 的退场（判据①「BOT 整页取消」，change 2026-11-02-feature-pocket-page-refactor）
//
// 背景：2026-11-02 页面重构后 `/bot` 不再是自己的文档，路由里只留一条 302 指回 `/`
// （lib/bridge.js:6402-6404）。这条 302 放在授权检查之前（:6406），所以未配对手机与已配对
// 手机走同一跳，旧「未配对时回带按钮的 401 页」的特判随 BOT 页一并删除。此处钉状态码
// 302 与 `location` 头，其余未授权路径的 401 形状（纯文本 `Pair your phone again.`）必须原样不动。
import test from 'node:test'
import assert from 'node:assert/strict'
import { httpFetch, startBridge } from './helpers.js'

test('an unpaired /bot is a 302 back to the landing page', async () => {
  const app = await startBridge()
  try {
    const res = await httpFetch(`${app.base}/bot`, {
      headers: { 'user-agent': 'PocketUnpaired/1.0' },
    })
    assert.equal(res.status, 302, 'the hop is the redirect itself, not a document')
    assert.equal(res.headers.get('location'), '/', 'and it lands on the one page that exists now')
    assert.equal(await res.text(), '', 'the 302 carries no body of its own')
  } finally {
    await app.stop()
  }
})

test('a paired /bot takes the same 302 hop as an unpaired one', async () => {
  const app = await startBridge()
  try {
    const { base } = app
    const cookie = await app.pairMobile()
    const res = await httpFetch(`${base}/bot`, { headers: { cookie } })
    assert.equal(res.status, 302, 'the redirect sits above the authorization check')
    assert.equal(res.headers.get('location'), '/', 'so both branches land on /')
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
