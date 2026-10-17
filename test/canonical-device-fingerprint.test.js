import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalDeviceAgent, deviceFingerprint, isCompatibleLegacyProfile } from '../lib/bridge.js'
import { createSessionStore, sessionsStorePath } from '../lib/session-store.js'
import { startBridge, httpFetch } from './helpers.js'

test('canonicalDeviceAgent: WeChat WiFi vs 5G vs 4G produces identical identity', () => {
  const uaWifi = 'Mozilla/5.0 (Linux; Android 12; NOH-AN00; Build/HUAWEINOH-AN00; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.122 Mobile Safari/537.36 XWEB/1260117 MMWEBSDK/20240501 MMWEBID/1234 MicroMessenger/8.0.50.2700(0x2800325B) UnifiedIPCode/2 Process/toolsmp WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64'
  const ua5G   = 'Mozilla/5.0 (Linux; Android 12; NOH-AN00; Build/HUAWEINOH-AN00; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.122 Mobile Safari/537.36 XWEB/1260117 MMWEBSDK/20240501 MMWEBID/1234 MicroMessenger/8.0.50.2700(0x2800325B) UnifiedIPCode/2 Process/toolsmp WeChat/arm64 Weixin NetType/5G Language/zh_CN ABI/arm64'
  const ua4G   = 'Mozilla/5.0 (Linux; Android 12; NOH-AN00) AppleWebKit/537.36 Mobile Safari/537.36 MicroMessenger/8.0.50 NetType/4G Language/en'

  const cWifi = canonicalDeviceAgent(uaWifi)
  const c5G   = canonicalDeviceAgent(ua5G)
  const c4G   = canonicalDeviceAgent(ua4G)

  assert.equal(cWifi, 'Android 12; NOH-AN00; MicroMessenger')
  assert.equal(c5G,   'Android 12; NOH-AN00; MicroMessenger')
  assert.equal(c4G,   'Android 12; NOH-AN00; MicroMessenger')

  assert.equal(deviceFingerprint(uaWifi), deviceFingerprint(ua5G))
  assert.equal(deviceFingerprint(uaWifi), deviceFingerprint(ua4G))
})

test('canonicalDeviceAgent: Option B separates different browsers on the same phone', () => {
  const uaWeChat = 'Mozilla/5.0 (Linux; Android 12; NOH-AN00) AppleWebKit/537.36 Mobile Safari/537.36 MicroMessenger/8.0.50 NetType/WIFI'
  const uaHuawei = 'Mozilla/5.0 (Linux; Android 12; NOH-AN00) AppleWebKit/537.36 Mobile Safari/537.36 HuaweiBrowser/14.0.5.300'
  const uaChrome = 'Mozilla/5.0 (Linux; Android 12; NOH-AN00) AppleWebKit/537.36 Chrome/129.0.6668.100 Mobile Safari/537.36'

  assert.equal(canonicalDeviceAgent(uaWeChat), 'Android 12; NOH-AN00; MicroMessenger')
  assert.equal(canonicalDeviceAgent(uaHuawei), 'Android 12; NOH-AN00; HuaweiBrowser')
  assert.equal(canonicalDeviceAgent(uaChrome), 'Android 12; NOH-AN00; Chrome')

  const fpWeChat = deviceFingerprint(uaWeChat)
  const fpHuawei = deviceFingerprint(uaHuawei)
  const fpChrome = deviceFingerprint(uaChrome)

  assert.notEqual(fpWeChat, fpHuawei)
  assert.notEqual(fpWeChat, fpChrome)
  assert.notEqual(fpHuawei, fpChrome)
})

test('canonicalDeviceAgent: separates different phone models', () => {
  const uaMate40 = 'Mozilla/5.0 (Linux; Android 12; NOH-AN00) AppleWebKit/537.36 Mobile Safari/537.36 MicroMessenger/8.0.50 NetType/WIFI'
  const uaP40    = 'Mozilla/5.0 (Linux; Android 10; ANA-AN00) AppleWebKit/537.36 Mobile Safari/537.36 MicroMessenger/8.0.50 NetType/WIFI'
  const uaIPhone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 MicroMessenger/8.0.50 NetType/WIFI'

  assert.equal(canonicalDeviceAgent(uaMate40), 'Android 12; NOH-AN00; MicroMessenger')
  assert.equal(canonicalDeviceAgent(uaP40),    'Android 10; ANA-AN00; MicroMessenger')
  assert.equal(canonicalDeviceAgent(uaIPhone), 'iPhone; iOS 17; MicroMessenger')

  assert.notEqual(deviceFingerprint(uaMate40), deviceFingerprint(uaP40))
  assert.notEqual(deviceFingerprint(uaMate40), deviceFingerprint(uaIPhone))
})

test('isCompatibleLegacyProfile: recognizes raw User-Agent labels from previous sessions', () => {
  const legacyLabel = 'Mozilla/5.0 (Linux; Android 12; NOH-AN00'
  const incomingCanonical = 'Android 12; NOH-AN00; MicroMessenger'

  assert.equal(isCompatibleLegacyProfile(legacyLabel, incomingCanonical), true)
  assert.equal(isCompatibleLegacyProfile('PocketPeer/1.0', incomingCanonical), false)
})

test('full stack: phone paired on WiFi restores directly with PIN when on 5G (no desktop stop)', async () => {
  const t = await startBridge()
  try {
    const desktop = await t.pairDesktop()
    const uaWifi = 'Mozilla/5.0 (Linux; Android 12; NOH-AN00) AppleWebKit/537.36 Mobile Safari/537.36 MicroMessenger/8.0.50 NetType/WIFI'
    const ua5G   = 'Mozilla/5.0 (Linux; Android 12; NOH-AN00) AppleWebKit/537.36 Mobile Safari/537.36 MicroMessenger/8.0.50 NetType/5G'

    const tunnelHeadersWifi = {
      'cf-connecting-ip': '198.51.100.11',
      'cf-ray': '8c1a-wifi-SJC',
      'user-agent': uaWifi,
    }

    // Step 1: initial pairing on WiFi
    t.bridge.ephemeralPin = '123456'
    t.bridge.ephemeralPinExpiresAt = Date.now() + 5 * 60_000
    const pin = '123456'
    const verify1 = await httpFetch(`${t.base}/pair/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...tunnelHeadersWifi },
      body: JSON.stringify({ pin }),
    })
    const body1 = await verify1.json()
    assert.equal(body1.pending, true, 'first contact requires desktop confirmation')

    // Approve on desktop
    const approve = await httpFetch(`${t.base}/desktop/pair/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: desktop },
      body: JSON.stringify({ id: body1.confirmId, approve: true }),
    })
    assert.equal((await approve.json()).ok, true)

    // Complete poll
    const poll = await httpFetch(`${t.base}/pair/pending?confirmId=${body1.confirmId}`, {
      headers: tunnelHeadersWifi,
    })
    const pollBody = await poll.json()
    assert.equal(pollBody.approved, true)

    // Step 2: Now switch to 5G and enter PIN on a rotated tunnel URL (no cookie presented)
    const tunnelHeaders5G = {
      'cf-connecting-ip': '203.0.113.88',
      'cf-ray': '8c1a-5g-HKG',
      'user-agent': ua5G,
    }

    const verify2 = await httpFetch(`${t.base}/pair/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...tunnelHeaders5G },
      body: JSON.stringify({ pin }),
    })
    const body2 = await verify2.json()
    assert.equal(body2.ok, true, 'PIN accepted')
    assert.equal(body2.pending, false, 'Option B: recognized as same device+browser, NO desktop stop')
    assert.match(verify2.headers.get('set-cookie') ?? '', /^dsh_mobile=/)
  } finally {
    await t.stop()
  }
})

test('session-store backup: writes create .bak and unreadable recovery merges historical devices', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-session-bak-'))
  try {
    const file = sessionsStorePath(dir)
    const bakFile = `${file}.bak`
    const store = createSessionStore(dir)

    // 1. Save state with 2 historical devices
    const state1 = {
      sessions: new Map(),
      suspendedSessions: new Map(),
      resumableSessions: new Map(),
      devices: new Map([
        ['fp-phone-1', { fingerprint: 'fp-phone-1', label: 'Phone 1', expiresAt: Date.now() + 100000 }],
        ['fp-phone-2', { fingerprint: 'fp-phone-2', label: 'Phone 2', expiresAt: Date.now() + 100000 }],
      ]),
      savedAt: Date.now(),
    }
    assert.equal(store.save(state1), true)
    assert.equal(existsSync(file), true)

    // 2. Second save creates .bak of the first state
    const state2 = {
      ...state1,
      devices: new Map([...state1.devices, ['fp-phone-3', { fingerprint: 'fp-phone-3', label: 'Phone 3', expiresAt: Date.now() + 100000 }]]),
    }
    assert.equal(store.save(state2), true)
    assert.equal(existsSync(bakFile), true, '.bak was created')
    const bakContent = readFileSync(bakFile, 'utf8')
    assert.ok(bakContent.includes('fp-phone-1'))
    assert.ok(bakContent.includes('fp-phone-2'))

    // 3. Simulate corrupt primary file, verify fallback to .bak loads the historical devices
    writeFileSync(file, 'CORRUPT_JSON_CONTENT{{{')
    const storeCorrupt = createSessionStore(dir)
    const loaded = storeCorrupt.load(0)
    assert.equal(loaded.devices.length, 2, 'recovered devices from .bak fallback')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
