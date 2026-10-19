// 桌面配对页「连上手机就锁死」的两条用户口述（2026-10-12）：
//   ① 连上以后想提前把 Cloudflare 的固定地址填好，进不去；
//   ② 「设备与消息」那页，手机连接成功的提示把消息提醒（待确认接入）遮掉了。
// 两条都不是安全约束：桥侧 /desktop/tunnel/toggle 早就写明「A live phone is not a reason
// to refuse」(M4)，/desktop/tunnel/config 从来没有连接态门禁 —— 拦住人的只有页面自己。
//
// 变异标尺（改回旧行为时这几条必须变红）：
//   A 把 #tunnelConfigPanel 塞回 #deviceExtras 里 -> A 红
//   B 把 #pendingPairings 放回 .pairing-content   -> B 红
//   C 给 body 重新加 phone-connected 并按连接态隐藏 .pairing-content -> C 红
//   D 连上时给两个连接模式键去掉 disabled / 去掉 switchMode 的 phoneConnected 早退 -> D 红
//
// D 的取向是用户 2026-10-12 09:3x 定的（原话：这个风险还不如不让切换呢）：
// 连接态切模式会真把隧道切掉，正走公网的手机会掉线 —— 该风险大于「提前填固定地址」的收益，
// 所以两键在连接态保持禁用。桥侧能力不变（M4「A live phone is not a reason to refuse」
// 与 /desktop/tunnel/config 无门禁都还在），被禁的只是页面这一层。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createSettingsStore } from '../lib/settings-store.js'
import { renderDesktopPairingPage } from '../lib/pages.js'
import { startBridge, httpFetch } from './helpers.js'

const PAGES_SOURCE = fs.readFileSync(new URL('../lib/pages.js', import.meta.url), 'utf8')

const connectedPage = (overrides = {}) => renderDesktopPairingPage({
  locale: 'zh',
  connected: true,
  pairingUrl: 'http://127.0.0.1/pair?token=x',
  qrSvg: '<svg></svg>',
  tunnelActive: true,
  expiresAt: Date.now() + 60_000,
  ...overrides,
})

const freshPage = (overrides = {}) => renderDesktopPairingPage({
  locale: 'zh',
  pairingUrl: 'http://127.0.0.1/pair?token=x',
  qrSvg: '<svg></svg>',
  expiresAt: Date.now() + 60_000,
  ...overrides,
})

// Ancestor chain of an element id, as the div/body tags it sits under. Same shape as
// the M-4 helper in connected-devices.test.js: a /device-view/ substring scan was true
// for CSS and JS too, so read the real nesting instead of matching text.
function chainOf (html, id) {
  const at = html.indexOf(`id="${id}"`)
  assert.notEqual(at, -1, `#${id} is rendered`)
  const stack = []
  const re = /<(\/?)(div|body)\b([^>]*)>/g
  let m
  while ((m = re.exec(html.slice(0, at)))) {
    const [full, slash, tag, attrs] = m
    if (full.endsWith('/>')) continue
    if (!slash) {
      const cls = (attrs.match(/class="([^"]*)"/) ?? [, ''])[1]
      stack.push(`${tag}${cls ? '.' + cls.split(' ')[0] : ''}`)
    } else {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].startsWith(tag)) { stack.length = i; break }
      }
    }
  }
  return stack
}

test('A the fixed-hostname panel is reachable: it is not a descendant of the devices container', () => {
  for (const [name, page] of [['connected', connectedPage()], ['fresh', freshPage()]]) {
    const chain = chainOf(page, 'tunnelConfigPanel')
    assert.ok(!chain.includes('div.deviceExtras') && !chain.includes('div#deviceExtras') &&
      !/div#deviceExtras/.test(chain.join(' ')),
      `connected=${name}: #tunnelConfigPanel must not live under #deviceExtras (${chain.join(' > ')})`)
    assert.ok(chain.includes('div.wrap'), `#tunnelConfigPanel stays inside .wrap (${chain.join(' > ')})`)
    assert.ok(!chain.some((item) => item.includes('pairing-content')),
      `#tunnelConfigPanel is not inside .pairing-content either (${chain.join(' > ')})`)
  }
  // Its own gate is the tunnel view. Reachable on a fresh page; with a phone on the
  // line the mode keys are disabled (see D), so it is reachable once that phone goes away.
  assert.match(freshPage(), /<div id="tunnelConfigPanel" class="pin-panel show"/,
    'the fresh page lands on the tunnel view, so the panel opens')
  assert.match(connectedPage(), /<div id="tunnelConfigPanel" class="pin-panel"/,
    'the connected page lands on the devices view, so it starts closed')
})

test('B the pairing requests are never behind the connection card', () => {
  const page = connectedPage({
    pendingPairings: [{ id: 'p1', label: 'Pixel 9', remoteAddress: '203.0.113.7', expiresAt: Date.now() + 30_000 }],
  })
  const chain = chainOf(page, 'pendingPairings')
  assert.ok(!chain.some((item) => item.includes('pairing-content')),
    `#pendingPairings must not be a descendant of .pairing-content (${chain.join(' > ')})`)
  assert.ok(chain.includes('div.wrap'), `#pendingPairings stays inside .wrap (${chain.join(' > ')})`)
  const card = page.indexOf('<div id="connection"')
  const pending = page.indexOf('<div id="pendingPairings"')
  const pairing = page.indexOf('<div class="pairing-content"')
  assert.ok(card !== -1 && pending !== -1 && pairing !== -1, 'all three blocks are rendered')
  assert.ok(card < pending, 'the pending host is emitted after the connection card, not under it')
  assert.ok(pending < pairing, 'and before the pairing block, so it is above the fold with two phones')
  assert.match(page, /待确认接入/, 'the card copy still ships')
  assert.match(page, /data-action="pair-approve" data-id="p1"/, 'and the approve handle is tappable')
  // An empty list still emits the host: the page script fills it from /desktop/status
  // and renderPendingPairings bails out when #pendingPairings is missing.
  assert.match(connectedPage(), /<div id="pendingPairings" class="pin-panel" style="text-align:left"><\/div>/,
    'the host element exists with no pending request, so polling can paint it later')
})

test('C nothing is hidden because a phone is connected', () => {
  // Scope to THIS page's <style>: the mobile page ships its own block earlier in the
  // file, and a whole-file slice would grade the wrong stylesheet.
  const deskStart = PAGES_SOURCE.indexOf('export function renderDesktopPairingPage')
  const css = PAGES_SOURCE.slice(deskStart, PAGES_SOURCE.indexOf('</style>', deskStart))
  assert.ok(deskStart !== -1 && css.length > 1000, 'the desktop stylesheet was located')
  assert.ok(!css.includes('.phone-connected'), 'the connected-state rule is gone')
  assert.ok(!PAGES_SOURCE.includes('phone-connected'), 'and no page state carries that class any more')
  assert.match(connectedPage(), /<body class="manage-connected device-view"/,
    'the connected body keeps the two classes the views actually read')
  // The devices view hides the pairing block with ONE container rule instead of four
  // per-child rules, so a new child cannot leak into it (that is how #pendingPairings
  // and the hostname panel got trapped in the first place).
  assert.match(css, /body\.device-view \.pairing-content\{display:none\}/, 'one rule, on the container')
  for (const dead of ['.qr{display:none}', '.url-row{display:none}', '.expires{display:none}', '#pinPanel{display:none}']) {
    assert.ok(!css.includes(`body.device-view ${dead}`), `the per-child rule for ${dead} is folded away`)
  }
})

test('D the connection-mode keys are disabled while a phone is connected', () => {
  const page = connectedPage()
  for (const id of ['btnLan', 'btnTunnel']) {
    const tag = (page.match(new RegExp(`<button id="${id}"[^>]*>`)) ?? [''])[0]
    assert.ok(tag, `${id} renders`)
    assert.ok(tag.includes('disabled'), `${id} is gated on the connection state`)
  }
  // A fresh page has no phone, so the keys are live and the mode can be chosen.
  for (const id of ['btnLan', 'btnTunnel']) {
    const tag = (freshPage().match(new RegExp(`<button id="${id}"[^>]*>`)) ?? [''])[0]
    assert.ok(!tag.includes('disabled'), `${id} is live when nothing is connected`)
  }
  assert.match(PAGES_SOURCE, /function syncModeControls\(connected\)\{phoneConnected=connected;const disabled=connected\|\|modeSwitching/,
    'a live phone disables the keys, as does an in-flight switch')
  assert.match(PAGES_SOURCE, /async function switchMode\(enableTunnel,force\)\{if\(phoneConnected\|\|modeSwitching\)return/,
    'and switchMode refuses to swap the tunnel out from under a connected phone')
})

test('E a live phone does not stop the desktop from saving the tunnel hostname', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pocket-desklock-'))
  const t = await startBridge({ bridgeOptions: { settingsStore: createSettingsStore(dir) } })
  try {
    await t.pairMobile('PocketDesklock/1.0')
    assert.equal((await httpFetch(`${t.base}/desktop/status`)).status, 403, 'the desktop gate is the real one')
    const desktop = await t.pairDesktop()
    assert.equal((await (await httpFetch(`${t.base}/desktop/status`, { headers: { Cookie: desktop } })).json()).connected, true)
    const save = await httpFetch(`${t.base}/desktop/tunnel/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: desktop },
      body: JSON.stringify({ hostname: 'pocket.example.com' }),
    })
    assert.equal(save.status, 200, 'prefilling the fixed hostname works with a phone on the line')
    assert.equal((await save.json()).hostname, 'pocket.example.com')
    const readback = await httpFetch(`${t.base}/desktop/tunnel/config`, { headers: { Cookie: desktop } })
    assert.equal((await readback.json()).hostname, 'pocket.example.com', 'and it is the value the panel will show')
  } finally {
    await t.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
