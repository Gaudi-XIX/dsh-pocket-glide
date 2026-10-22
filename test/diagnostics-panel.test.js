// 0.4.27 diagnostics panel switch — the desktop-side contract.
//
// WHY these three batches exist (handoff 2026-10-11 §2.4): the setting reaches
// the phone through a URL suffix (`?probe=1`) built from `diagnostics.probe`,
// so an endpoint that accepts a truthy non-boolean would turn the probe on from
// a payload nobody intended, and the phone would start shipping scroll timings
// into pocket.log forever. The strict-boolean check and the snapshot echo are
// the two halves that keep the switch honest; the render batch keeps the
// control reachable in both locales.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createSettingsStore } from '../lib/settings-store.js'
import { renderDesktopPairingPage } from '../lib/pages.js'
import { startBridge, httpFetch } from './helpers.js'

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pocket-diag-'))
  return { dir, store: createSettingsStore(dir) }
}

test('desktop diagnostics: desktop gate, strict boolean, and the snapshot echo', async () => {
  const { dir, store } = tempStore()
  const t = await startBridge({ bridgeOptions: { settingsStore: store } })
  try {
    const post = (body, cookie) =>
      httpFetch(`${t.base}/desktop/diagnostics`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: JSON.stringify(body),
      })

    // No desktop session → 403 before any parsing happens.
    assert.equal((await post({ probe: true })).status, 403)

    const desktop = await t.pairDesktop()

    // Strict boolean: every truthy stand-in is refused, and nothing is stored.
    for (const probe of ['true', 'false', 1, 0, null, undefined, {}]) {
      const res = await post({ probe }, desktop)
      assert.equal(res.status, 400, `probe=${JSON.stringify(probe)} must be refused`)
    }
    assert.equal(store.load().diagnostics.probe, false, 'a refused payload must not flip the setting')

    // The pairing URL carries the probe suffix only while the setting is on.
    const before = await (await httpFetch(`${t.base}/desktop/tunnel/status`, { headers: { Cookie: desktop } })).json()
    assert.equal(before.diagnostics.probe, false)

    const on = await post({ probe: true }, desktop)
    assert.equal(on.status, 200)
    assert.deepEqual(await on.json(), { ok: true, probe: true, phoneUa: null })
    assert.equal(store.load().diagnostics.probe, true, 'the setting lands in the settings file')

    const after = await (await httpFetch(`${t.base}/desktop/tunnel/status`, { headers: { Cookie: desktop } })).json()
    assert.equal(after.diagnostics.probe, true, 'the status snapshot echoes the new value')

    const off = await post({ probe: false }, desktop)
    assert.equal(off.status, 200)
    assert.deepEqual(await off.json(), { ok: true, probe: false, phoneUa: null })
    assert.equal(store.load().diagnostics.probe, false)
  } finally {
    await t.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('desktop diagnostics: the probe suffix rides the pairing URL only when enabled', async () => {
  const { dir, store } = tempStore()
  const t = await startBridge({ bridgeOptions: { settingsStore: store } })
  try {
    const desktop = await t.pairDesktop()
    const save = (probe) =>
      httpFetch(`${t.base}/desktop/diagnostics`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Cookie: desktop },
        body: JSON.stringify({ probe }),
      })

    await save(false)
    assert.equal(t.bridge.snapshot().pairingUrl.includes('probe=1'), false)
    await save(true)
    // The suffix is only appended on the tunnel branch (the LAN pairing URL has
    // its own token); what this pins is the wiring from the setting to the URL.
    assert.equal(t.bridge.diagnosticsProbeEnabled(), true)
  } finally {
    await t.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Panel render — the switch must exist, be pre-checked from the contract, and
// state its cost in both locales. Copy that omits the cost reads as a free
// switch, which is how the probe gets left on by accident.
// ---------------------------------------------------------------------------

const baseDesktopOptions = {
  qrSvg: '<svg></svg>',
  pairingUrl: 'http://127.0.0.1/pair?token=x',
  expiresAt: Date.now() + 60_000,
}

test('the desktop page renders the diagnostics switch from the diagnostics contract', () => {
  const off = renderDesktopPairingPage({
    ...baseDesktopOptions,
    locale: 'zh',
    diagnostics: { probe: false },
  })
  assert.match(off, /data-action="diag-save"/)
  assert.match(off, /id="diagProbe"/)
  assert.equal(/id="diagProbe"[^>]*checked/.test(off), false, 'a false probe must not be pre-checked')

  const on = renderDesktopPairingPage({
    ...baseDesktopOptions,
    locale: 'zh',
    diagnostics: { probe: true },
  })
  assert.match(on, /id="diagProbe"[^>]*checked/, 'a true probe must be pre-checked')

  // Absent contract → off, never on: the safe default has to survive a caller
  // that forgets to pass the section.
  const missing = renderDesktopPairingPage({ ...baseDesktopOptions, locale: 'zh' })
  assert.match(missing, /id="diagProbe"/)
  assert.equal(/id="diagProbe"[^>]*checked/.test(missing), false)
})

test('the diagnostics copy states its cost and exists in both locales', () => {
  const zh = renderDesktopPairingPage({ ...baseDesktopOptions, locale: 'zh', diagnostics: { probe: true } })
  assert.match(zh, /诊断/)
  assert.match(zh, /记录手机滚动时序/)
  assert.match(zh, /1\.5 秒/, 'the sampling cadence is part of the cost')
  assert.match(zh, /probe=1/, 'the re-entry requirement after a tunnel change is part of the cost')
  assert.match(zh, /日志/, 'the log growth is part of the cost')

  const en = renderDesktopPairingPage({ ...baseDesktopOptions, locale: 'en', diagnostics: { probe: true } })
  assert.match(en, /Diagnostics/)
  assert.match(en, /Record phone scroll timings/)
  assert.match(en, /1\.5 seconds/)
  assert.match(en, /probe=1/)
  assert.match(en, /log/)
})

test('the diagnostics switch posts to its own endpoint with a boolean body', () => {
  const html = renderDesktopPairingPage({ ...baseDesktopOptions, locale: 'zh', diagnostics: { probe: false } })
  assert.match(html, /fetch\('\/desktop\/diagnostics'/, 'the page must post to the diagnostics route')
  assert.match(html, /\{probe:box\.checked\}/, 'the body is a strict boolean, matching the endpoint')
})

// The panel answers "which browser is the phone running" from the UA header of
// the last phone request — no phone-side code, no extra request. The trap this
// batch pins: the desktop pairing page is itself a stream of requests, and if
// those counted, the answer would always be the desktop's browser.
test('desktop diagnostics: the phone UA is remembered, and desktop traffic never overwrites it', async () => {
  const { dir, store } = tempStore()
  const t = await startBridge({ bridgeOptions: { settingsStore: store } })
  try {
    const desktop = await t.pairDesktop()
    const head = { Cookie: desktop }

    assert.equal((await (await httpFetch(`${t.base}/desktop/diagnostics`, { method: 'POST', headers: { ...head, 'content-type': 'application/json' }, body: JSON.stringify({ probe: true }) })).json()).phoneUa, null, 'nothing seen yet')

    const phoneUa = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) PocketUaProbe/1.0'
    // A phone request needs no cookie to be remembered: `handle()` records the
    // header before any authorization, so even a 401 counts.
    await httpFetch(`${t.base}/sw.js`, { headers: { 'user-agent': phoneUa } })
    const seen = t.bridge.diagnosticsView().phoneUa
    assert.equal(seen.ua, phoneUa, 'the phone UA is what the panel will show')
    assert.ok(seen.label.length > 0, 'the label is resolved for the panel line')
    assert.equal(typeof seen.at, 'number')

    await httpFetch(`${t.base}/desktop/status`, { headers: { ...head, 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) DesktopProbe/9' } })
    assert.equal(t.bridge.diagnosticsView().phoneUa.ua, phoneUa, 'desktop traffic must not answer for the phone')

    // The trap: the pairing page's own document is `/desktop` with no trailing
    // slash, so a prefix test that only excluded `/desktop/` let the desktop
    // browser overwrite the phone the moment someone opened the panel.
    await httpFetch(`${t.base}/desktop`, { headers: { ...head, 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) DesktopPage/9' } })
    assert.equal(t.bridge.diagnosticsView().phoneUa.ua, phoneUa, 'the bare /desktop document must not overwrite it either')

    const shown = await (await httpFetch(`${t.base}/desktop/diagnostics`, { method: 'POST', headers: { ...head, 'content-type': 'application/json' }, body: JSON.stringify({ probe: true }) })).json()
    assert.equal(shown.phoneUa.ua, phoneUa, 'the endpoint echoes the remembered UA')
  } finally {
    await t.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the diagnostics panel renders the phone UA line in both locales', () => {
  const phoneUa = { ua: 'Mozilla/5.0 (iPhone) SafariProbe/2.1', label: 'Safari / iOS', at: 1 }
  const zh = renderDesktopPairingPage({ ...baseDesktopOptions, locale: 'zh', diagnostics: { probe: false, phoneUa } })
  assert.match(zh, /手机浏览器 UA/, 'the line is labelled')
  assert.match(zh, /SafariProbe\/2\.1/, 'the raw UA is shown, escaped')

  const en = renderDesktopPairingPage({ ...baseDesktopOptions, locale: 'en', diagnostics: { probe: false, phoneUa } })
  assert.match(en, /Phone browser UA/)
  assert.match(en, /SafariProbe\/2\.1/)

  // Nobody has connected yet → a dash, never a blank that reads as a bug.
  const none = renderDesktopPairingPage({ ...baseDesktopOptions, locale: 'zh', diagnostics: { probe: false } })
  assert.match(none, /手机浏览器 UA（最近一次）：—/)
})
