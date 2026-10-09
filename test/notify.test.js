// Design #2 — completion notifications: the settings store, the three push
// channels, the bridge trigger, and the desktop endpoints. The invariant under
// test everywhere is design D6: the key exists in exactly two places — the
// settings file and the outbound request — and in NOTHING else (no readback,
// no log line, no page, no status payload).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { notifySend, maskKey } from '../lib/notify.js'
import {
  createSettingsStore,
  defaultSettingsDocument,
  settingsStorePath,
} from '../lib/settings-store.js'
import { startBridge, httpFetch } from './helpers.js'

/** A key whose shape makes a partial leak distinguishable from the mask. */
const REAL_KEY = 'SECRETKET1234567890AB'

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

// ---------------------------------------------------------------------------
// Store (WP2-1)
// ---------------------------------------------------------------------------

test('settings store: save → load round-trips and stays idempotent', () => {
  const dir = makeTempDir('dsh-pocket-settings-')
  try {
    const store = createSettingsStore(dir)
    assert.deepEqual(store.load(), defaultSettingsDocument(), 'a fresh store reads the defaults')
    assert.equal(
      store.save({ notify: { channel: 'bark', key: REAL_KEY, enabled: true } }),
      true
    )
    const first = store.load()
    assert.equal(first.notify.channel, 'bark')
    assert.equal(first.notify.key, REAL_KEY)
    assert.equal(first.notify.enabled, true)
    assert.equal(first.tunnel.hostname, '', 'an untouched section keeps its defaults')
    // Idempotent: the same patch applied again changes nothing.
    assert.equal(store.save({ notify: { channel: 'bark', key: REAL_KEY, enabled: true } }), true)
    assert.deepEqual(store.load(), first)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('settings store: a corrupt file reads as the defaults, never throws', () => {
  const dir = makeTempDir('dsh-pocket-settings-')
  try {
    const store = createSettingsStore(dir)
    fs.writeFileSync(settingsStorePath(dir), '{not json at all', 'utf8')
    assert.deepEqual(store.load(), defaultSettingsDocument())
    // And a save repairs the file in place.
    assert.equal(store.save({ tunnel: { token: 'tok', hostname: 'p.example.com' } }), true)
    assert.equal(store.load().tunnel.hostname, 'p.example.com')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('settings store: the file lands 0600 (POSIX) and secrets stay inside it', () => {
  const dir = makeTempDir('dsh-pocket-settings-')
  try {
    const store = createSettingsStore(dir)
    store.save({ notify: { channel: 'serverchan', key: REAL_KEY, enabled: true } })
    const stat = fs.statSync(settingsStorePath(dir))
    if (process.platform !== 'win32') {
      assert.equal(stat.mode & 0o777, 0o600, 'the settings file is owner-only')
    }
    // The one place the key legitimately lives is this file.
    assert.ok(fs.readFileSync(settingsStorePath(dir), 'utf8').includes(REAL_KEY))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// maskKey + the three channels (WP2-2)
// ---------------------------------------------------------------------------

test('maskKey: short keys hide outright, long ones keep first 2 and last 4', () => {
  assert.equal(maskKey(''), '')
  assert.equal(maskKey(undefined), '')
  assert.equal(maskKey('short'), '•••••')
  assert.equal(maskKey(REAL_KEY), 'SE…90AB')
  assert.equal(maskKey(REAL_KEY).includes('1234567890'), false)
})

test('notify channels: serverchan query, bark path segments, wxpusher body', async () => {
  const seen = []
  const ok = (text = '{}') => ({ ok: true, text: async () => text })
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), init })
    // Business results ride the body for BOTH code-checking channels: WxPusher
    // success is code 1000, Server酱 success is code 0. An HTTP 200 alone never
    // counts as delivered (serverchan used to be the exception that lied).
    const u = String(url)
    if (u.includes('wxpusher')) return ok('{"code":1000,"msg":"处理成功","data":{}}')
    if (u.includes('sctapi')) {
      return ok('{"code":0,"message":"","data":{"pushid":"1","readkey":"r","error":"SUCCESS","errno":0}}')
    }
    return ok()
  }
  const log = []
  const logger = (level, message) => log.push(`${level} ${message}`)

  assert.equal(
    await notifySend({ channel: 'serverchan', key: REAL_KEY }, '标题 t/1', '正文 b&2', { fetchImpl, log }),
    true
  )
  assert.equal(seen[0].init?.method, undefined, 'serverchan is a GET')
  assert.ok(seen[0].url.includes('sctapi.ftqq.com'))
  assert.ok(seen[0].url.includes(encodeURIComponent('标题 t/1')), 'title rides encoded in the query')
  assert.ok(seen[0].url.includes(encodeURIComponent('正文 b&2')))

  assert.equal(await notifySend({ channel: 'bark', key: REAL_KEY }, '标题 t/1', '正文', { fetchImpl, log }), true)
  const parts = new URL(seen[1].url).pathname.split('/').filter(Boolean)
  assert.equal(parts[0], REAL_KEY)
  assert.equal(parts[1], encodeURIComponent('标题 t/1'), 'the slash in a title stays ONE path segment')

  assert.equal(await notifySend({ channel: 'wxpusher', key: REAL_KEY }, '标题', '正文', { fetchImpl, log }), true)
  assert.equal(seen[2].init?.method, 'POST')
  const sent = JSON.parse(seen[2].init.body)
  assert.equal(sent.appToken, REAL_KEY)
  assert.equal(sent.summary, '标题')
  assert.equal(sent.content, '正文')
  assert.equal(sent.contentType, 1)

  assert.equal(await notifySend({ channel: 'off', key: REAL_KEY }, 't', 'b', { fetchImpl, log }), false)
  assert.equal(seen.length, 3, 'an off channel sends nothing')
  // The log saw none of it: a successful send writes nothing at all.
  assert.deepEqual(log, [])
  // The key travels exactly once per send, in the place its channel puts it:
  // the URL for serverchan/bark, the body for wxpusher.
  assert.ok(seen[0].url.includes(REAL_KEY))
  assert.ok(seen[1].url.includes(REAL_KEY))
  assert.equal(seen[2].url.includes(REAL_KEY), false, 'wxpusher keeps the token out of the URL')
  assert.ok(seen[2].init.body.includes(REAL_KEY))
})

// WxPusher verdict (2026-10-07-fix-pocket-wxpusher-simple-push): the old bug
// was judging `response.ok` only while WxPusher reports business failures as
// HTTP 200 with body `{code, msg}` — code 1000 is the only delivered.
test('notify wxpusher: an spt. key routes to simple-push and summary is capped at 100', async () => {
  const seen = []
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), init })
    return { ok: true, text: async () => '{"code":1000,"msg":"处理成功"}' }
  }
  const longTitle = '长'.repeat(120)
  assert.equal(
    await notifySend({ channel: 'wxpusher', key: 'spt.ABCDEFGHIJKLMNOPQRSTUVWXYZ' }, longTitle, '正文', { fetchImpl }),
    true
  )
  assert.equal(seen[0].url, 'https://wxpusher.zjiecode.com/api/send/message/simple-push')
  const sent = JSON.parse(seen[0].init.body)
  assert.equal(sent.spt, 'spt.ABCDEFGHIJKLMNOPQRSTUVWXYZ')
  assert.equal(sent.appToken, undefined, 'spt mode never sends the classic appToken field')
  assert.equal(sent.summary.length, 100, 'summary is truncated to the banner cap')
  assert.equal(sent.content, '正文')
  assert.equal(sent.contentType, 1)
  // The documented prefix is lowercase `spt.`; the uppercase shape routes the
  // same way (case-insensitive on purpose).
  await notifySend({ channel: 'wxpusher', key: 'SPT.abcdefghijklmnop' }, 't', 'b', { fetchImpl })
  assert.ok(seen[1].url.endsWith('/simple-push'), 'an SPT.-prefixed key is still a personal token')
})

test('notify wxpusher: HTTP 200 with a business failure answers false, peer msg logged with the key masked', async () => {
  const log = []
  const key = 'spt.TOPSECRET123456'
  const delivered = await notifySend(
    { channel: 'wxpusher', key },
    't',
    'b',
    {
      fetchImpl: async () => ({
        ok: true,
        text: async () => JSON.stringify({ code: 1001, msg: `spt无效:${key}` })
      }),
      log: (level, message) => log.push(`${level} ${message}`)
    }
  )
  assert.equal(delivered, false, 'HTTP 200 alone is not a delivery: the body code decides')
  assert.equal(log.length, 1)
  assert.match(log[0], /notify send failed: wxpusher code=1001/)
  assert.ok(log[0].includes('spt无效'), 'the peer business msg reaches the log for diagnosis')
  assert.equal(log[0].includes(key), false, 'a key echoed inside the peer msg is masked first')
  assert.ok(log[0].includes('••••'))

  // A 200 whose body is not the expected JSON is a failure, not a guess —
  // and the unreadable body is quoted nowhere.
  const log2 = []
  const delivered2 = await notifySend(
    { channel: 'wxpusher', key },
    't',
    'b',
    {
      fetchImpl: async () => ({ ok: true, text: async () => '<html>gateway page</html>' }),
      log: (level, message) => log2.push(`${level} ${message}`)
    }
  )
  assert.equal(delivered2, false)
  assert.match(log2[0], /notify send failed: wxpusher code unreadable/)
  assert.equal(log2[0].includes('gateway'), false)
})

test('notify wxpusher: a network-level failure keeps the class-name-only note', async () => {
  const log = []
  const delivered = await notifySend(
    { channel: 'wxpusher', key: 'spt.ABCDEFGHIJK' },
    't',
    'b',
    {
      fetchImpl: async () => {
        const error = new Error('connect EHOSTUNREACH spt.ABCDEFGHIJK')
        error.name = 'TypeError'
        throw error
      },
      log: (level, message) => log.push(`${level} ${message}`)
    }
  )
  assert.equal(delivered, false)
  assert.deepEqual(log, ['warn notify send failed: TypeError'], 'no message, no key — class name only')
})

test('notifySend: a failing channel answers false and logs the class only', async () => {
  const log = []
  const delivered = await notifySend(
    { channel: 'bark', key: REAL_KEY },
    't',
    'b',
    {
      fetchImpl: async () => ({ ok: false, status: 503, text: async () => 'nope' }),
      log: (level, message) => log.push(`${level} ${message}`)
    }
  )
  assert.equal(delivered, false)
  assert.deepEqual(log, ['warn notify send failed: HTTP 503'])
  assert.equal(log.join('\n').includes(REAL_KEY), false, 'no key in the failure note')
  assert.equal(log.join('\n').includes('api.day.app'), false, 'no URL in the failure note')
})

test('notifySend: a hanging channel is cut off by the timeout, quietly', async () => {
  const log = []
  const delivered = await notifySend(
    { channel: 'serverchan', key: REAL_KEY },
    't',
    'b',
    {
      // A fetch double that honours the abort signal the way the real fetch
      // does — without this listener the double would hang past the timeout
      // and the test, not the library, would be broken.
      fetchImpl: (_url, init) =>
        new Promise((resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const abortError = new Error('The operation was aborted.')
            abortError.name = 'AbortError'
            reject(abortError)
          })
        }),
      timeoutMs: 1,
      log: (level, message) => log.push(`${level} ${message}`)
    }
  )
  assert.equal(delivered, false)
  assert.equal(log.length, 1, 'exactly one warn, not a retry storm')
  assert.match(log[0], /notify send failed: AbortError/)
  assert.equal(log[0].includes(REAL_KEY), false)
})

// L-1 (2026-10-07-fix-pocket-contract-minis): enabled:false is a documented
// setting (defaultSettingsDocument ships it) — the gate lives here so a caller
// that forgets its own check (or a future call site) still cannot push.
test('notifySend: enabled=false answers false before any fetch is attempted', async () => {
  const seen = []
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), init })
    return { ok: true, text: async () => '{}' }
  }
  assert.equal(
    await notifySend({ channel: 'bark', key: REAL_KEY, enabled: false }, 't', 'b', { fetchImpl }),
    false
  )
  assert.equal(seen.length, 0, 'the gate short-circuits before the channel is touched')
  // 对照组：同一 config 仅 enabled 翻 true ⇒ 照发（enabled undefined 情形既有用例已覆盖）。
  assert.equal(await notifySend({ channel: 'bark', key: REAL_KEY, enabled: true }, 't', 'b', { fetchImpl }), true)
  assert.equal(seen.length, 1)
})

// ---------------------------------------------------------------------------
// Bridge trigger + endpoints (WP2-2)
// ---------------------------------------------------------------------------

function notifyBridgeOptions(sent, items) {
  return {
    settingsStore: {
      load: () => ({ notify: { channel: 'bark', key: REAL_KEY, enabled: true } }),
      save: () => true
    },
    notifyFetchImpl: async (url) => {
      sent.push(String(url))
      return { ok: true, text: async () => '{}' }
    }
  }
}

test('notify trigger: a running→done edge pushes exactly one completion notice', async () => {
  const sent = []
  let items = [{ sessionId: 's1', running: true, title: '写周报' }]
  const t = await startBridge({
    harness: 'fake',
    harnessOptions: {
      respond: (pathname) =>
        pathname === '/api/session/list' ? { ok: true, value: { items } } : undefined
    },
    bridgeOptions: {
      ...notifyBridgeOptions(sent, items),
    },
  })
  try {
    // The first tick is the baseline: nothing was running before it was seen.
    await t.bridge.pollNotifyRunning()
    assert.equal(sent.length, 0)
    items = [{ sessionId: 's1', running: false, title: '写周报' }]
    // The trigger reads the shared 10s session-list cache; drop it so this
    // tick observes the flipped flag instead of the baseline's answer.
    t.bridge._sessionListCache = undefined
    await t.bridge.pollNotifyRunning()
    assert.equal(sent.length, 1)
    assert.ok(sent[0].startsWith('https://api.day.app/'))
    assert.ok(sent[0].includes(encodeURIComponent('写周报')), 'the session title names the notice')
    // A session that stays done does not notify twice.
    await t.bridge.pollNotifyRunning()
    assert.equal(sent.length, 1)
    assert.equal(
      t.logs.some(({ message }) => message.includes(REAL_KEY)),
      false,
      'the trigger path never logs the key'
    )
  } finally {
    await t.stop()
  }
})

test('notify trigger: the watcher is armed only while enabled, and stop() disarms', async () => {
  const t = await startBridge()
  try {
    assert.equal(t.bridge.notifyTimer, undefined, 'notify off → no timer')
    assert.equal(t.bridge.notifyConfig.channel, 'off')
    assert.equal(t.bridge.notifyConfig.enabled, false)
  } finally {
    await t.stop()
  }

  const sent = []
  const t2 = await startBridge({ bridgeOptions: notifyBridgeOptions(sent, []) })
  try {
    assert.ok(t2.bridge.notifyTimer, 'an enabled store config arms the poll at start')
    await t2.bridge.stop()
    assert.equal(t2.bridge.notifyTimer, undefined, 'stop() disarms the poll')
  } finally {
    await t2.stop()
  }
})

test('desktop notify endpoints: masked readback, guarded writes, delivered flag', async () => {
  const sent = []
  const dir = makeTempDir('dsh-pocket-settings-')
  const t = await startBridge({
    bridgeOptions: { ...notifyBridgeOptions(sent, []), settingsStore: createSettingsStore(dir) },
  })
  try {
    // No desktop session → 403, on reads and writes both.
    assert.equal((await httpFetch(`${t.base}/desktop/notify`)).status, 403)
    assert.equal(
      (
        await httpFetch(`${t.base}/desktop/notify`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ channel: 'bark', key: REAL_KEY, enabled: true }),
        })
      ).status,
      403
    )
    const desktop = await t.pairDesktop()
    // Fresh state: off, nothing masked.
    const fresh = await httpFetch(`${t.base}/desktop/notify`, { headers: { Cookie: desktop } })
    assert.deepEqual(await fresh.json(), { ok: true, channel: 'off', enabled: false, keyMasked: '' })
    // Save a real channel; the readback is masked and only the mask.
    const save = await httpFetch(`${t.base}/desktop/notify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: desktop },
      body: JSON.stringify({ channel: 'bark', key: REAL_KEY, enabled: true }),
    })
    assert.equal(save.status, 200)
    assert.deepEqual(await save.json(), { ok: true, channel: 'bark', enabled: true, keyMasked: 'SE…90AB' })
    const readback = await httpFetch(`${t.base}/desktop/notify`, { headers: { Cookie: desktop } })
    const readbackBody = await readback.json()
    assert.equal(readbackBody.keyMasked.includes(REAL_KEY), false)
    assert.equal(JSON.stringify(readbackBody).includes(REAL_KEY), false, 'the raw key never rides a readback')
    // Bad input is 400, not a save.
    assert.equal(
      (
        await httpFetch(`${t.base}/desktop/notify`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', Cookie: desktop },
          body: JSON.stringify({ channel: 'carrier-pigeon', key: REAL_KEY, enabled: true }),
        })
      ).status,
      400
    )
    assert.equal(
      (
        await httpFetch(`${t.base}/desktop/notify`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', Cookie: desktop },
          body: JSON.stringify({ channel: 'bark', key: '', enabled: true }),
        })
      ).status,
      400,
      'an empty key cannot enable a channel'
    )
    // The test endpoint goes out through the injected channel and answers a
    // delivered flag; failure stays a 200 with delivered:false.
    const test = await httpFetch(`${t.base}/desktop/notify/test`, {
      method: 'POST',
      headers: { Cookie: desktop },
    })
    assert.deepEqual(await test.json(), { ok: true, delivered: true })
    assert.equal(sent.length, 1, 'the test notice went through the injected fetch')
    assert.equal(
      t.logs.some(({ message }) => message.includes(REAL_KEY)),
      false,
      'no key in the bridge log'
    )
  } finally {
    await t.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the key leaks to no surface: status, boot, phone page, desktop page', async () => {
  const dir = makeTempDir('dsh-pocket-settings-')
  const t = await startBridge({
    harness: 'fake',
    bridgeOptions: { settingsStore: createSettingsStore(dir) },
  })
  try {
    const desktop = await t.pairDesktop()
    const save = await httpFetch(`${t.base}/desktop/notify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: desktop },
      body: JSON.stringify({ channel: 'bark', key: REAL_KEY, enabled: true }),
    })
    assert.equal(save.status, 200)
    const mobile = await t.pairMobile('PocketNotify/1.0')
    const surfaces = [
      ['mobile page', await httpFetch(`${t.base}/`, { headers: { cookie: mobile } })],
      ['status', await httpFetch(`${t.base}/api/status`, { headers: { cookie: mobile } })],
      ['boot', await httpFetch(`${t.base}/api/boot`, { headers: { cookie: mobile } })],
      ['desktop page', await httpFetch(`${t.base}/desktop`, { headers: { Cookie: desktop } })],
    ]
    for (const [name, res] of surfaces) {
      const body = await res.text()
      assert.equal(body.includes(REAL_KEY), false, `${name} never carries the raw key`)
    }
  } finally {
    await t.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
