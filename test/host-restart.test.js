// 远程重启宿主（0.4.34）：手机主页头部电源钮调脚本——桥只负责「武装」圈外的
// 一次性计划任务（scripts/dsh-restart-now.ps1 → DSH-ReviveOnce），杀/拉/推送
// 全是 revive 脚本现成的活；宿主进程树在同一 Job Object 里，从圈内既杀不死也
// 拉不起，这是按钮只能当「遥控器」的物理原因。端点 POST /api/host/restart 的
// 权限边界＝配对漏斗（同源＋在册手机会话，与 /api/opened-at 同门）。契约：
// 未配对 401；跨站 403；有会话推进 409 带名单且绝不武装；空闲 200 armed；
// 武装失败 502 带原因。有会话推进时 force=true 走强制结束路径（用户
// 2026-10-15 REQ5②③）：先 session.cancel 全部 busy 会话，全成功才武装；
// 部分 cancel 失败 502 不武装。2026-10-12 的「无强制口子」裁定由本条覆盖。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startBridge, httpFetch } from './helpers.js'

const JSON_HEADERS = { 'content-type': 'application/json' }

test('the phone home document carries the header button and the confirm card says the ugly truths', async () => {
  const t = await startBridge({ harness: 'fake' })
  try {
    const cookie = await t.pairMobile()
    const res = await httpFetch(t.base + '/', { headers: { cookie } })
    assert.equal(res.status, 200)
    const html = await res.text()
    assert.match(html, /id="hostRestart" class="head-icon"/, 'the power button sits in the home header')
    assert.match(html, /id="hostCard" class="host-card"/)
    assert.match(html, /id="hostGo" type="button" class="is-danger"/)
    // REQ5②③: 页面结构带强制结束按钮（默认 hidden）、转圈中间态（.host-spin）、
    // busy 名单改 <ul> 每名一行——这些都在壳 JS /app.js 里不在 HTML，但按钮和
    // 文案地标在 HTML 中，它们缺席说明结构没补上。
    assert.match(html, /id="hostForce" type="button" class="host-force"/, 'the force-stop button is in the confirm card')
    assert.match(html, /强制结束这些会话并重启/, 'the force button carries its own label')
    // 用户 2026-10-12 定的丑话，2026-10-17 追加「一行一行」的排法（原三条长句拆成
    // 八个 <li>，一条一个事实），要点必须写全，让用户自适应：
    assert.match(html, /所有会话中断/)
    assert.match(html, /唯一回执是微信推送/)
    assert.match(html, /任意回复/)
    assert.match(html, /隧道默认关着/)
    assert.match(html, /<li>点确认后约 8 秒，桌面端整体关闭。<\/li>/, 'each truth is its own line')
    // 页面 JS 在外链 /app.js（壳资产）里：退出调用要在那里验，不在文档里。
    const appJs = await httpFetch(t.base + '/app.js', { headers: { cookie } })
    assert.equal(appJs.status, 200)
    const app = await appJs.text()
    assert.match(app, /location\.replace\('\/bye'\)/, 'a confirmed restart exits the page to the goodbye')
    // 2026-10-18 用户追加：转圈圈直接在按钮上改 UI（btn 挂 .host-spin），不在下方新打一行。
    assert.match(app, /hostBusyRefuse\+'<ul>'/, 'the busy list is one line per session')
    assert.match(app, /btn\.innerHTML='<span class="host-spin"/, 'the restarting state is a spinner directly on the button')
    assert.match(app, /L\.hostRestarting/, 'the spinner still carries its accessible label')
    assert.match(app, /confirmHostRestart\(true\)/, 'the force button routes to the forced path')
  } finally { await t.stop() }
})

test('the english document carries the same bones', async () => {
  const t = await startBridge({ harness: 'fake', bridgeOptions: { locale: 'en' } })
  try {
    const cookie = await t.pairMobile()
    const res = await httpFetch(t.base + '/', { headers: { cookie } })
    const html = await res.text()
    assert.match(html, /aria-label="Restart host"/)
    assert.match(html, /the only receipt is the WeChat push/i)
  } finally { await t.stop() }
})

test('the goodbye page answers on /bye and the service worker lets it through', async () => {
  const t = await startBridge({ harness: 'fake' })
  try {
    const bye = await httpFetch(t.base + '/bye')
    assert.equal(bye.status, 200)
    const body = await bye.text()
    assert.match(body, /in case i don't see you/, 'the farewell page opens with the four-line quote')
    assert.match(body, /and good night/)
    assert.match(body, /任意回复/, 'the goodbye page still points at the reply-for-address path')
    assert.doesNotMatch(body, /<br>/, 'the hints are separate lines, not one <br>-stacked paragraph')
    assert.doesNotMatch(body, /<script/, 'a page shown while the host dies must carry no script')
    const sw = await httpFetch(t.base + '/sw.js')
    assert.match(await sw.text(), /consent\|bye\)/, 'the SW must not hijack /bye back into the cached shell')
  } finally { await t.stop() }
})

test('unpaired restart is refused and nothing is armed', async () => {
  const armed = []
  const t = await startBridge({
    harness: 'fake',
    harnessOptions: {
      respond: (pathname) => (pathname === '/api/session/list' ? { ok: true, value: { items: [] } } : undefined),
    },
    bridgeOptions: { hostRestartInvoker: async () => { armed.push(1) } },
  })
  try {
    const res = await httpFetch(t.base + '/api/host/restart', { method: 'POST', headers: { ...JSON_HEADERS, origin: t.base }, body: '{}' })
    assert.equal(res.status, 401)
    assert.equal(armed.length, 0)
  } finally { await t.stop() }
})

test('cross-site restart is refused at the same gate as every other POST', async () => {
  const armed = []
  const t = await startBridge({
    harness: 'fake',
    bridgeOptions: { hostRestartInvoker: async () => { armed.push(1) } },
  })
  try {
    const cookie = await t.pairMobile()
    const res = await httpFetch(t.base + '/api/host/restart', {
      method: 'POST',
      headers: { ...JSON_HEADERS, cookie, origin: 'https://evil.example' },
      body: '{}',
    })
    assert.equal(res.status, 403)
    assert.equal(armed.length, 0)
  } finally { await t.stop() }
})

test('busy sessions refuse with the list and never arm', async () => {
  const armed = []
  const t = await startBridge({
    harness: 'fake',
    harnessOptions: {
      respond: (pathname) => (pathname === '/api/session/list'
        ? { ok: true, value: { items: [{ sessionId: 's-run', running: true }, { sessionId: 's-idle', running: false }] } }
        : undefined),
    },
    bridgeOptions: { hostRestartInvoker: async () => { armed.push(1) } },
  })
  try {
    const cookie = await t.pairMobile()
    const res = await httpFetch(t.base + '/api/host/restart', {
      method: 'POST',
      headers: { ...JSON_HEADERS, cookie, origin: t.base },
      body: '{}',
    })
    assert.equal(res.status, 409)
    const j = await res.json()
    assert.equal(j.ok, false)
    assert.deepEqual(j.busy.map((b) => b.sessionId), ['s-run'])
    assert.equal(armed.length, 0, 'a refused restart must not even start arming')
  } finally { await t.stop() }
})

test('idle sessions arm the restart script and answer with the fire delay', async () => {
  const scripts = []
  const t = await startBridge({
    harness: 'fake',
    harnessOptions: {
      respond: (pathname) => (pathname === '/api/session/list' ? { ok: true, value: { items: [] } } : undefined),
    },
    bridgeOptions: { hostRestartInvoker: async (script) => { scripts.push(script) } },
  })
  try {
    const cookie = await t.pairMobile()
    const res = await httpFetch(t.base + '/api/host/restart', {
      method: 'POST',
      headers: { ...JSON_HEADERS, cookie, origin: t.base },
      body: '{}',
    })
    assert.equal(res.status, 200)
    const j = await res.json()
    assert.equal(j.ok, true)
    assert.equal(j.delaySec, 8)
    assert.deepEqual(scripts, ['F:\\defws\\scripts\\dsh-restart-now.ps1'],
      'the button calls the existing script — no second restart mechanism')
  } finally { await t.stop() }
})

test('a failed arming answers 502 and carries the reason', async () => {
  const t = await startBridge({
    harness: 'fake',
    harnessOptions: {
      respond: (pathname) => (pathname === '/api/session/list' ? { ok: true, value: { items: [] } } : undefined),
    },
    bridgeOptions: {
      hostRestartInvoker: async () => { throw new Error('schtasks refused') },
    },
  })
  try {
    const cookie = await t.pairMobile()
    const res = await httpFetch(t.base + '/api/host/restart', {
      method: 'POST',
      headers: { ...JSON_HEADERS, cookie, origin: t.base },
      body: '{}',
    })
    assert.equal(res.status, 502)
    const j = await res.json()
    assert.match(j.error, /schtasks refused/)
  } finally { await t.stop() }
})

test('force=true cancels every busy session then arms the restart', async () => {
  const armed = []
  const cancelled = []
  const t = await startBridge({
    harness: 'fake',
    harnessOptions: {
      respond: (pathname, args) => {
        if (pathname === '/api/session/list')
          return { ok: true, value: { items: [{ sessionId: 's-run', running: true }, { sessionId: 's-idle', running: false }] } }
        if (pathname === '/api/session/cancel') {
          cancelled.push(args?.request?.sessionId)
          return { ok: true, value: { cancelled: true } }
        }
        return undefined
      },
    },
    bridgeOptions: { hostRestartInvoker: async () => { armed.push(1) } },
  })
  try {
    const cookie = await t.pairMobile()
    const res = await httpFetch(t.base + '/api/host/restart', {
      method: 'POST',
      headers: { ...JSON_HEADERS, cookie, origin: t.base },
      body: JSON.stringify({ force: true }),
    })
    assert.equal(res.status, 200)
    const j = await res.json()
    assert.equal(j.ok, true)
    assert.deepEqual(cancelled, ['s-run'], 'only the running session is cancelled')
    assert.equal(armed.length, 1, 'restart is armed after all cancels succeed')
  } finally { await t.stop() }
})

test('force=true proceeds with restart even if session cancel fails or subagent is busy', async () => {
  const armed = []
  const t = await startBridge({
    harness: 'fake',
    harnessOptions: {
      respond: (pathname) => {
        if (pathname === '/api/session/list')
          return { ok: true, value: { items: [{ sessionId: 's-run', running: true }] } }
        if (pathname === '/api/session/cancel')
          return { ok: false, error: { message: 'session is wedged' } }
        return undefined
      },
    },
    bridgeOptions: { hostRestartInvoker: async () => { armed.push(1) } },
  })
  try {
    const cookie = await t.pairMobile()
    const res = await httpFetch(t.base + '/api/host/restart', {
      method: 'POST',
      headers: { ...JSON_HEADERS, cookie, origin: t.base },
      body: JSON.stringify({ force: true }),
    })
    assert.equal(res.status, 200)
    const j = await res.json()
    assert.equal(j.ok, true)
    assert.equal(armed.length, 1, 'force restart arms even when cancel is refused or agent is busy')
  } finally { await t.stop() }
})
