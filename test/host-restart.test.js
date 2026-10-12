// 远程重启宿主（0.4.34）：按钮调脚本——桥只负责「武装」圈外的一次性计划任务
// （scripts/dsh-restart-now.ps1 → DSH-ReviveOnce），杀/拉/推送全是 revive 脚本
// 现成的活；宿主进程树在同一 Job Object 里，从圈内既杀不死也拉不起，这是按钮
// 只能当「遥控器」的物理原因。契约四条：未鉴权 403；有会话推进 409 带名单且
// 绝不武装；空闲 200 armed；武装失败 502 带原因。硬拒没有强制口子——卡死的
// 会话由用户手动结束（用户 2026-10-12 裁）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderDesktopPairingPage } from '../lib/pages.js'
import { startBridge, httpFetch } from './helpers.js'

const page = (overrides = {}) => renderDesktopPairingPage({
  locale: 'zh',
  pairingUrl: 'http://127.0.0.1/pair?token=x',
  qrSvg: '<svg></svg>',
  expiresAt: Date.now() + 60_000,
  ...overrides,
})

test('the pairing page carries the host panel and the confirm page says the ugly truths', () => {
  const html = page()
  assert.match(html, /id="hostPanel" class="pin-panel show"/)
  assert.match(html, /id="hostConfirmPanel" class="pin-panel"/)
  assert.match(html, /data-action="host-restart-ask"/)
  assert.match(html, /data-action="host-restart-confirm" class="is-danger"/)
  // 用户 2026-10-12 定的四条丑话，确认页必须写全，让用户自适应：
  assert.match(html, /所有会话中断/)
  assert.match(html, /唯一回执是微信推送/)
  assert.match(html, /回任意一句话/)
  assert.match(html, /公网隧道是关着的/)
  assert.doesNotMatch(html, /id="hostConfirmPanel" class="pin-panel show"/,
    'the confirm page stays hidden until the button opens it')
})

test('the english page carries the same bones', () => {
  const html = page({ locale: 'en' })
  assert.match(html, /Restart host…/)
  assert.match(html, /the only receipt is the WeChat push/)
})

test('unauthenticated restart is refused and nothing is armed', async () => {
  const armed = []
  const t = await startBridge({
    harness: 'fake',
    harnessOptions: {
      respond: (pathname) => (pathname === '/api/session/list' ? { ok: true, value: { items: [] } } : undefined),
    },
    bridgeOptions: { hostRestartInvoker: async () => { armed.push(1) } },
  })
  try {
    const res = await httpFetch(t.base + '/desktop/host/restart', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
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
    const desktop = await t.pairDesktop()
    const res = await httpFetch(t.base + '/desktop/host/restart', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: desktop, origin: t.base },
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
    const desktop = await t.pairDesktop()
    const res = await httpFetch(t.base + '/desktop/host/restart', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: desktop, origin: t.base },
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
    const desktop = await t.pairDesktop()
    const res = await httpFetch(t.base + '/desktop/host/restart', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: desktop, origin: t.base },
      body: '{}',
    })
    assert.equal(res.status, 502)
    const j = await res.json()
    assert.match(j.error, /schtasks refused/)
  } finally { await t.stop() }
})
