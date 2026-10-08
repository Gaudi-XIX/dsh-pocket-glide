// Device registry (change 2026-10-07-feat-pocket-device-registry): the paired
// device profile — consent migrated off the origin-bound cookie, PIN-only
// restore for known devices, channel permission enforced after authentication,
// and a management surface (list / extend / permission / revoke-with-profile)
// for the desktop half.
//
// FULL-STACK over real HTTP against a real bridge on an ephemeral port, tunnel
// simulated with the cf-connecting-ip + cf-ray seam (same as pairing.test).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startBridge, httpFetch } from './helpers.js'
import { createSessionStore, sessionsStorePath } from '../lib/session-store.js'
import { MOBILE_COOKIE_TTL_MS } from '../lib/constants.js'

const tunnelHeaders = {
  'cf-connecting-ip': '203.0.113.7',
  'cf-ray': '8c1a-registry-SJC',
}

function cookieOf(res) {
  return (res.headers.get('set-cookie') ?? '').split(';')[0]
}

/** Mirror of bridge.deviceFingerprint — for building on-disk fixtures whose
 * keys match what the bridge computes. */
function fingerprintOf(userAgent) {
  return createHash('sha256').update(userAgent).digest('base64url').slice(0, 10)
}

async function acceptConsent(t, cookie) {
  return httpFetch(`${t.base}/consent/accept`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...tunnelHeaders, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ next: '/' }),
  })
}

async function devicesList(t, desktopCookie) {
  const res = await httpFetch(`${t.base}/desktop/devices`, { headers: { Cookie: desktopCookie } })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.ok(Array.isArray(body.devices))
  return body.devices
}

// ------------------------------------- ① 新设备入档,权限按首连通道

test('a first tunnel pairing registers the device with lan+wan permission', async () => {
  const t = await startBridge()
  try {
    const desktopCookie = await t.pairDesktop()
    const cookie = await t.pairMobileTunnel('PocketRegistry/1.0')
    assert.match(cookie, /^dsh_mobile=/)

    const devices = await devicesList(t, desktopCookie)
    assert.equal(devices.length, 1)
    const device = devices[0]
    assert.equal(device.permission, 'lan+wan', 'first contact over the tunnel grants public access')
    assert.equal(device.label, 'PocketRegistry/1.0')
    assert.equal(device.fingerprint, device.id, 'the registry key is the row handle')
    assert.equal(typeof device.firstPairedAt, 'number')
    assert.equal(typeof device.expiresAt, 'number')
    assert.ok(device.expiresAt > Date.now())
    assert.equal(device.online, true, 'the live session is visible on the row')
    assert.equal(device.consented, false, 'consent is only recorded by the accept POST')
  } finally {
    await t.stop()
  }
})

test('a first LAN pairing registers the device with lan-only permission', async () => {
  const t = await startBridge()
  try {
    const desktopCookie = await t.pairDesktop()
    await t.pairMobile('PocketLocal/1.0')

    const devices = await devicesList(t, desktopCookie)
    assert.equal(devices.length, 1)
    assert.equal(devices[0].permission, 'lan', 'first contact over the LAN grants local only')
  } finally {
    await t.stop()
  }
})

// ------------------------------------- ② PIN 即恢复(不再弹桌面确认,不再问同意)

test('PIN restore: a known device re-enters with the PIN alone — no desktop stop, no consent page', async () => {
  const t = await startBridge()
  try {
    await t.pairDesktop()
    const firstCookie = await t.pairMobileTunnel('PocketRestore/1.0')
    // 首次:同意一次 — the accept migrates the answer into the registry.
    await acceptConsent(t, firstCookie)

    // 重启换域名模拟:a quick tunnel gets a NEW hostname, and a cookie is
    // origin-bound — on the new origin the phone arrives with NOTHING but the
    // PIN. The old credential is unreachable, which is the part the session
    // store alone could never fix.
    t.bridge.sessions.clear()
    t.bridge.pendingPairings.clear()
    t.bridge.ephemeralPin = '123456'
    t.bridge.ephemeralPinExpiresAt = Date.now() + 5 * 60_000

    const verify = await httpFetch(`${t.base}/pair/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...tunnelHeaders, 'user-agent': 'PocketRestore/1.0' },
      body: JSON.stringify({ pin: '123456' }),
    })
    assert.equal(verify.status, 200)
    const body = await verify.json()
    assert.equal(body.ok, true)
    assert.equal(body.pending, false, 'a known device skips the desktop confirmation')
    const restoredCookie = cookieOf(verify)
    assert.match(restoredCookie, /^dsh_mobile=/, 'the credential is re-issued on the verify response itself')
    assert.equal(t.bridge.sessions.size, 1, 'the restore retires the stale entry instead of stacking a phantom')
    assert.equal(t.bridge.pendingPairings.size, 0, 'no confirmation card is registered either')

    // The consent answer comes from the profile: the restored phone carries NO
    // consent cookie, and the app still opens.
    const app = await httpFetch(`${t.base}/`, { headers: { ...tunnelHeaders, cookie: restoredCookie } })
    assert.equal(app.status, 200, 'in through the profile, not the cookie')
  } finally {
    await t.stop()
  }
})

test('PIN restore refreshes the credential lifetime and keeps the row single', async () => {
  const t = await startBridge()
  try {
    const desktopCookie = await t.pairDesktop()
    await t.pairMobileTunnel('PocketRenew/1.0')
    // The credential ages 25 days; the profile with it.
    const before = (await devicesList(t, desktopCookie))[0]
    t.bridge.now = () => Date.now() + 25 * 24 * 60 * 60 * 1000
    t.bridge.ephemeralPin = '123456'
    t.bridge.ephemeralPinExpiresAt = t.bridge.now() + 5 * 60_000

    const verify = await httpFetch(`${t.base}/pair/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...tunnelHeaders, 'user-agent': 'PocketRenew/1.0' },
      body: JSON.stringify({ pin: '123456' }),
    })
    assert.equal(verify.status, 200)
    assert.equal((await verify.json()).pending, false)

    const after = (await devicesList(t, desktopCookie))[0]
    assert.equal(after.id, before.id, 'same device row')
    assert.equal(after.firstPairedAt, before.firstPairedAt, 'the first pairing time is kept')
    assert.ok(after.expiresAt > before.expiresAt, 'the credential was re-issued to a full TTL')
    assert.ok(after.lastSeenAt >= before.lastSeenAt, 'the sighting moved forward')
  } finally {
    await t.stop()
  }
})

test('a wrong PIN against a known device still counts and never restores', async () => {
  const t = await startBridge()
  try {
    await t.pairDesktop()
    await t.pairMobileTunnel('PocketGuard/1.0')
    t.bridge.ephemeralPin = '123456'
    t.bridge.ephemeralPinExpiresAt = Date.now() + 5 * 60_000
    const wrong = await httpFetch(`${t.base}/pair/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...tunnelHeaders, 'user-agent': 'PocketGuard/1.0' },
      body: JSON.stringify({ pin: '000000' }),
    })
    assert.equal(wrong.status, 401)
    assert.equal(t.bridge.sessions.size, 1, 'nothing was restored')
    assert.equal(t.bridge.devices.size, 1, 'the registry is untouched by a failed guess')
  } finally {
    await t.stop()
  }
})

// ------------------------------------- ③ consent 迁档案(cookie 或档案任一放行)

test('consent accept writes the answer into the device profile; the cookie becomes optional', async () => {
  const t = await startBridge()
  try {
    const mobile = await t.pairMobileTunnel('PocketConsentReg/1.0')
    // Before the accept, the gate fronts the app.
    const gated = await httpFetch(`${t.base}/`, { headers: { ...tunnelHeaders, cookie: mobile } })
    assert.equal(gated.status, 303)
    // The accept carries the device's own cookie: the answer lands in the profile.
    const accepted = await acceptConsent(t, mobile)
    assert.equal(accepted.status, 303)
    const profile = [...t.bridge.devices.values()][0]
    assert.equal(typeof profile.publicConsentedAt, 'number', 'the registry now holds the consent')

    // Drop the consent cookie entirely (a new tunnel origin does exactly this):
    // the profile is enough.
    const through = await httpFetch(`${t.base}/`, { headers: { ...tunnelHeaders, cookie: mobile } })
    assert.equal(through.status, 200, 'cookie or profile — either one opens the gate')
  } finally {
    await t.stop()
  }
})

test('a consent accept without a device cookie stays cookie-only (desktop browser case)', async () => {
  const t = await startBridge()
  try {
    await t.pairMobileTunnel('PocketBrowser/1.0')
    const accepted = await acceptConsent(t, undefined)
    assert.equal(accepted.status, 303)
    const profile = [...t.bridge.devices.values()][0]
    assert.equal(profile.publicConsentedAt, undefined, 'no device behind the accept, no profile write')
  } finally {
    await t.stop()
  }
})

// ------------------------------------- ④ 权限强制点(鉴权后,tunnel 访问 lan 设备 403)

test('permission enforcement: a lan-only device over the tunnel is refused with the human copy', async () => {
  const t = await startBridge()
  try {
    const mobile = await t.pairMobile('PocketLanOnly/1.0') // LAN first contact → 'lan'
    // Accept consent first so the refusal below can only be the permission
    // gate, never the consent gate.
    await acceptConsent(t, mobile)
    const profile = [...t.bridge.devices.values()][0]
    assert.equal(profile.permission, 'lan')

    const res = await httpFetch(`${t.base}/api/status`, { headers: { ...tunnelHeaders, cookie: mobile } })
    assert.equal(res.status, 403)
    assert.match(await res.text(), /此设备未获公网权限/)
    // The same device on its home channel is untouched.
    const lan = await httpFetch(`${t.base}/api/status`, { headers: { cookie: mobile } })
    assert.equal(lan.status, 200, 'the grant ends where it ended: LAN keeps working')
  } finally {
    await t.stop()
  }
})

test('permission enforcement: flipping the grant takes effect on the very next request', async () => {
  const t = await startBridge()
  try {
    const desktopCookie = await t.pairDesktop()
    const mobile = await t.pairMobile('PocketFlip/1.0')
    const refused = await httpFetch(`${t.base}/api/status`, { headers: { ...tunnelHeaders, cookie: mobile } })
    assert.equal(refused.status, 403)

    const flip = await httpFetch(`${t.base}/desktop/device/permission`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: desktopCookie },
      body: JSON.stringify({ deviceId: [...t.bridge.devices.keys()][0], permission: 'lan+wan' }),
    })
    assert.equal(flip.status, 200)

    // Grant only — the consent gate is back to being the front door.
    const gated = await httpFetch(`${t.base}/api/status`, { headers: { ...tunnelHeaders, cookie: mobile } })
    assert.equal(gated.status, 303, 'past the permission gate, the consent gate is next')
    await acceptConsent(t, mobile)
    const ok = await httpFetch(`${t.base}/api/status`, { headers: { ...tunnelHeaders, cookie: mobile } })
    assert.equal(ok.status, 200)
  } finally {
    await t.stop()
  }
})

test('permission enforcement: a lan+wan device on the LAN is welcome (grant implies local)', async () => {
  const t = await startBridge()
  try {
    const mobile = await t.pairMobileTunnel('PocketBoth/1.0')
    const res = await httpFetch(`${t.base}/api/status`, { headers: { cookie: mobile } })
    assert.equal(res.status, 200, 'no consent dance, no refusal on the local channel')
  } finally {
    await t.stop()
  }
})

// ------------------------------------- ⑤ 撤销:硬删档案 + 401 + 踢线

test('revoke by registry key hard-deletes the profile and ends the credential', async () => {
  const t = await startBridge()
  try {
    const desktopCookie = await t.pairDesktop()
    const mobile = await t.pairMobileTunnel('PocketRevoke/1.0')
    const id = [...t.bridge.devices.keys()][0]

    const revoked = await httpFetch(`${t.base}/desktop/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: desktopCookie },
      body: JSON.stringify({ deviceId: id }),
    })
    assert.equal(revoked.status, 200)

    assert.equal(t.bridge.devices.size, 0, 'the profile is gone — no tombstone')
    assert.equal(t.bridge.sessions.size, 0)
    assert.equal(t.bridge.suspendedSessions.size, 0)
    assert.equal((await devicesList(t, desktopCookie)).length, 0)
    // 被删 token 一律 401:不泄露曾存在。(The tunnel-side consent gate fronts
    // auth and would answer an un-consented stranger 303 — ask over the LAN,
    // where the credential question is answered directly.)
    const after = await httpFetch(`${t.base}/api/status`, { headers: { cookie: mobile } })
    assert.equal(after.status, 401)

    // And the funnel is FULL again: the same UA + PIN does not skip the desktop.
    t.bridge.ephemeralPin = '123456'
    t.bridge.ephemeralPinExpiresAt = Date.now() + 5 * 60_000
    const verify = await httpFetch(`${t.base}/pair/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...tunnelHeaders, 'user-agent': 'PocketRevoke/1.0' },
      body: JSON.stringify({ pin: '123456' }),
    })
    assert.equal((await verify.json()).pending, true, 'a revoked device pairs like a new one')
  } finally {
    await t.stop()
  }
})

test('revoke by token id also retires the profile when the last session of the fingerprint goes', async () => {
  const t = await startBridge()
  try {
    const desktopCookie = await t.pairDesktop()
    const mobile = await t.pairMobileTunnel('PocketTokenRevoke/1.0')
    const token = mobile.split('=')[1]
    const tokenId = t.bridge.deviceIdOf(token)

    const revoked = await httpFetch(`${t.base}/desktop/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: desktopCookie },
      body: JSON.stringify({ deviceId: tokenId }),
    })
    assert.equal(revoked.status, 200)
    assert.equal(t.bridge.devices.size, 0, 'no session of that fingerprint is left, so the profile goes too')
    const after = await httpFetch(`${t.base}/api/status`, { headers: { cookie: mobile } })
    assert.equal(after.status, 401)
  } finally {
    await t.stop()
  }
})

test('kick: a revoked device has its live SSE response destroyed, not merely unauthorized', async () => {
  const t = await startBridge()
  try {
    await t.pairDesktop()
    const mobile = await t.pairMobileTunnel('PocketKick/1.0')
    const token = mobile.split('=')[1]

    // Unit seam: the SSE wrapper registers the response per token
    // (trackDeviceStream), the revoke destroys it.
    let destroyed = 0
    const closeHandler = { current: null }
    const fakeResponse = {
      on: (event, handler) => {
        if (event === 'close') closeHandler.current = handler
      },
      destroy: () => {
        destroyed += 1
      },
    }
    t.bridge.trackDeviceStream({ headers: { cookie: mobile } }, fakeResponse)
    assert.equal(t.bridge.deviceStreams.get(token)?.has(fakeResponse), true, 'the stream is attributed to the device')
    // Self-cleaning: the response's own close event removes the entry.
    closeHandler.current()
    assert.equal(t.bridge.deviceStreams.has(token), false)

    t.bridge.trackDeviceStream({ headers: { cookie: mobile } }, fakeResponse)
    const id = [...t.bridge.devices.keys()][0]
    t.bridge.revokeDevice(id)
    assert.equal(destroyed, 1, 'the live stream was destroyed by the revoke')
    assert.equal(t.bridge.deviceStreams.size, 0, 'the index is clean afterwards')
  } finally {
    await t.stop()
  }
})

// ------------------------------------- ⑥ 延长(重置 30 天)

test('extend re-issues the credential to a full TTL for the profile and its sessions', async () => {
  const t = await startBridge()
  try {
    const desktopCookie = await t.pairDesktop()
    await t.pairMobileTunnel('PocketExtend/1.0')
    // Age everything 25 days first, and PIN the clock so the expected expiry
    // is exact (the bridge reads its clock several times across the POST).
    const before = (await devicesList(t, desktopCookie))[0]
    const oldSessionExpiry = [...t.bridge.sessions.values()][0].expiresAt
    const now = Date.now() + 25 * 24 * 60 * 60 * 1000
    t.bridge.now = () => now

    const extended = await httpFetch(`${t.base}/desktop/device/extend`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: desktopCookie },
      body: JSON.stringify({ deviceId: before.id }),
    })
    assert.equal(extended.status, 200)
    const body = await extended.json()
    assert.equal(body.devices[0].id, before.id)

    assert.equal(body.devices[0].expiresAt, now + MOBILE_COOKIE_TTL_MS, 'the profile credential is a full TTL out')
    const liveSession = [...t.bridge.sessions.values()][0]
    assert.equal(liveSession.expiresAt, now + MOBILE_COOKIE_TTL_MS, 'the live session moved with it')
    assert.notEqual(liveSession.expiresAt, oldSessionExpiry)

    const unknown = await httpFetch(`${t.base}/desktop/device/extend`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: desktopCookie },
      body: JSON.stringify({ deviceId: 'no-such-device' }),
    })
    assert.equal(unknown.status, 404)
  } finally {
    await t.stop()
  }
})

// ------------------------------------- ⑦ 管理端点的门与形状

test('device management endpoints demand the desktop session and validate input', async () => {
  const t = await startBridge()
  try {
    const denied = await httpFetch(`${t.base}/desktop/devices`)
    assert.ok([401, 403].includes(denied.status), 'a phone cannot list the registry')

    const desktopCookie = await t.pairDesktop()
    const badPermission = await httpFetch(`${t.base}/desktop/device/permission`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: desktopCookie },
      body: JSON.stringify({ deviceId: 'x', permission: 'everywhere' }),
    })
    assert.equal(badPermission.status, 400)
    const badBody = await httpFetch(`${t.base}/desktop/device/permission`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: desktopCookie },
      body: '{not json',
    })
    assert.equal(badBody.status, 400)
    const unknownPermission = await httpFetch(`${t.base}/desktop/device/permission`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: desktopCookie },
      body: JSON.stringify({ deviceId: 'no-such-device', permission: 'lan' }),
    })
    assert.equal(unknownPermission.status, 404)
    // 保密契约:the registry list never carries a token.
    await t.pairMobileTunnel('PocketShape/1.0')
    const list = await devicesList(t, desktopCookie)
    const raw = JSON.stringify(list)
    const token = [...t.bridge.sessions.keys()][0]
    assert.ok(!raw.includes(token), 'no session token in the list payload')
  } finally {
    await t.stop()
  }
})

// ------------------------------------- ⑧ 兼容:现存 30 天会话平滑迁移

test('compatibility: sessions persisted before the registry gain profiles on first start', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'pocket-registry-'))
  try {
    const now = Date.now()
    // A pre-registry document: sessions only, no devices array at all — exactly
    // what the previous build wrote (the live Huawei device's shape).
    writeFileSync(sessionsStorePath(dataDir), JSON.stringify({
      version: 1,
      savedAt: now,
      sessions: [
        ['legacy-token', {
          token: 'legacy-token',
          remoteAddress: '192.168.1.5',
          label: 'Huawei',
          fingerprint: fingerprintOf('Mozilla/5.0 (Linux; Android 12; HUAWEI)'),
          issuedAt: now,
          expiresAt: now + MOBILE_COOKIE_TTL_MS,
          lastSeenAt: now,
        }],
      ],
      suspended: [],
      resumable: [],
    }))
    const t = await startBridge({ bridgeOptions: { sessionStore: createSessionStore(dataDir) } })
    try {
      assert.equal(t.bridge.devices.size, 1, 'one profile built from the legacy record')
      const profile = [...t.bridge.devices.values()][0]
      assert.equal(profile.permission, 'lan+wan', 'a working device is not demoted out of the tunnel')
      assert.equal(typeof profile.publicConsentedAt, 'number', 'and not re-asked the disclaimer either')
      assert.equal(profile.label, 'Huawei')
      // 不强制重新配对:the old cookie keeps working.
      const res = await httpFetch(`${t.base}/api/status`, { headers: { cookie: 'dsh_mobile=legacy-token' } })
      assert.equal(res.status, 200)
      // The migrated profile lands on disk with the next persist.
      t.bridge.flushSessionPersist()
      const doc = JSON.parse(readFileSync(sessionsStorePath(dataDir), 'utf8'))
      assert.equal(doc.version, 1, 'the document version does not move (older builds must keep reading it)')
      assert.equal(doc.devices.length, 1)
      assert.equal(doc.devices[0][0], profile.fingerprint)
    } finally {
      await t.stop()
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// ------------------------------------- ⑨ 档案落盘(走 session-store 的 0600 原子写)

test('the registry persists across a real restart: PIN-only restore and silent consent both survive', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'pocket-registry-persist-'))
  try {
    const first = await startBridge({ bridgeOptions: { sessionStore: createSessionStore(dataDir) } })
    let firstCookie
    try {
      await first.pairDesktop()
      firstCookie = await first.pairMobileTunnel('PocketPersist/1.0')
      await acceptConsent(first, firstCookie)
      first.bridge.flushSessionPersist()
      assert.ok(existsSync(sessionsStorePath(dataDir)))
      // 0600 on POSIX (Windows ignores mode bits — the directory ACL is the
      // boundary there, the same contract the session maps have always had).
      if (process.platform !== 'win32') {
        const mode = (statSync(sessionsStorePath(dataDir)).mode & 0o777).toString(8)
        assert.equal(mode, '600', 'the profile rides the same 0600 atomic write')
      }
    } finally {
      await first.stop()
    }

    // A genuinely new bridge over the same data directory = the host restart.
    const second = await startBridge({ bridgeOptions: { sessionStore: createSessionStore(dataDir) } })
    try {
      assert.equal(second.bridge.devices.size, 1, 'the profile came back from disk')
      assert.equal(second.bridge.devices.values().next().value.publicConsentedAt > 0, true, 'with the consent answer')
      assert.equal(second.bridge.sessions.size, 1, 'the session map itself is intact too')
      // New tunnel origin: the old cookie never arrives. Only the PIN.
      second.bridge.sessions.clear()
      second.bridge.pendingPairings.clear()
      second.bridge.ephemeralPin = '123456'
      second.bridge.ephemeralPinExpiresAt = Date.now() + 5 * 60_000
      const verify = await httpFetch(`${second.base}/pair/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...tunnelHeaders, 'user-agent': 'PocketPersist/1.0' },
        body: JSON.stringify({ pin: '123456' }),
      })
      assert.equal(verify.status, 200)
      assert.equal((await verify.json()).pending, false, 'restored after the restart, no desktop stop')
      const restored = cookieOf(verify)
      const app = await httpFetch(`${second.base}/`, { headers: { ...tunnelHeaders, cookie: restored } })
      assert.equal(app.status, 200, 'the consent answer survived the restart in the profile')
    } finally {
      await second.stop()
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})
