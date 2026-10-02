// Unit coverage for lib/tunnel.js: resolver chain (new env name + legacy
// fallback), lazy download with timeout / size cap / checksum verification,
// darwin .tgz extraction, and the one-time legacy cache migration.
// All network and PATH probes are injected; nothing is really downloaded.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import {
  resolveCloudflared,
  ensureCloudflared,
  extractTryCloudflareUrl,
} from '../lib/tunnel.js'
import { LanMobileBridge } from '../lib/bridge.js'
import { startBridge, httpFetch } from './helpers.js'

const ENV_KEYS = ['DSH_POCKET_CLOUDFLARED', 'DSH_PHONE_NATIVE_CLOUDFLARED', 'CLOUDFLARED_BIN', 'LOCALAPPDATA', 'XDG_CACHE_HOME']

function saveEnv() {
  const saved = {}
  for (const key of ENV_KEYS) saved[key] = process.env[key]
  return saved
}

function restoreEnv(saved) {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
}

function clearEnv() {
  for (const key of ENV_KEYS) delete process.env[key]
}

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** fetchImpl seam: return a web-stream body wrapping `payload`. */
function fetchReturning(payload, { delayMs = 0 } = {}) {
  return async (_url, init) => {
    if (delayMs > 0) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs)
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(init.signal.reason)
        })
      })
    }
    return {
      ok: true,
      body: Readable.toWeb(Readable.from([Buffer.from(payload)])),
    }
  }
}

function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/** Point the cache-root env var at a fresh temp dir and return it. */
function useTempCacheRoot() {
  const root = makeTempDir('dsh-pocket-test-cache-')
  if (process.platform === 'win32') process.env.LOCALAPPDATA = root
  else process.env.XDG_CACHE_HOME = root
  return root
}

test('extractTryCloudflareUrl pulls the first quick-tunnel URL', () => {
  assert.equal(
    extractTryCloudflareUrl('noise https://abc-1.trycloudflare.com tail'),
    'https://abc-1.trycloudflare.com',
  )
  assert.equal(extractTryCloudflareUrl('no url here'), null)
})

test('resolveCloudflared falls through to the bare command name', () => {
  const saved = saveEnv()
  try {
    clearEnv()
    assert.equal(resolveCloudflared(), 'cloudflared')
    assert.equal(resolveCloudflared(''), 'cloudflared')
    assert.equal(resolveCloudflared('Z:/definitely/missing/cloudflared.exe'), 'cloudflared')
  } finally {
    restoreEnv(saved)
  }
})

test('resolveCloudflared honors binaryPath then DSH_POCKET_CLOUDFLARED', () => {
  const saved = saveEnv()
  try {
    clearEnv()
    const dir = makeTempDir('dsh-pocket-test-bin-')
    const direct = path.join(dir, 'direct.exe')
    const override = path.join(dir, 'override.exe')
    fs.writeFileSync(direct, 'x')
    fs.writeFileSync(override, 'y')

    assert.equal(resolveCloudflared(direct), direct)
    process.env.DSH_POCKET_CLOUDFLARED = override
    assert.equal(resolveCloudflared(), override)
    // binaryPath wins over the env override.
    assert.equal(resolveCloudflared(direct), direct)
  } finally {
    restoreEnv(saved)
  }
})

test('resolveCloudflared reads legacy DSH_PHONE_NATIVE_CLOUDFLARED as fallback', () => {
  const saved = saveEnv()
  try {
    clearEnv()
    const dir = makeTempDir('dsh-pocket-test-bin-')
    const legacy = path.join(dir, 'legacy.exe')
    fs.writeFileSync(legacy, 'z')
    process.env.DSH_PHONE_NATIVE_CLOUDFLARED = legacy
    assert.equal(resolveCloudflared(), legacy)

    // New name takes precedence when both are set.
    const current = path.join(dir, 'current.exe')
    fs.writeFileSync(current, 'w')
    process.env.DSH_POCKET_CLOUDFLARED = current
    assert.equal(resolveCloudflared(), current)
  } finally {
    restoreEnv(saved)
  }
})

test('resolveCloudflared chain reaches CLOUDFLARED_BIN', () => {
  const saved = saveEnv()
  try {
    clearEnv()
    const dir = makeTempDir('dsh-pocket-test-bin-')
    const bin = path.join(dir, 'cf.exe')
    fs.writeFileSync(bin, 'q')
    process.env.CLOUDFLARED_BIN = bin
    assert.equal(resolveCloudflared(), bin)
  } finally {
    restoreEnv(saved)
  }
})

test('ensureCloudflared downloads, verifies and caches a raw executable', async () => {
  const saved = saveEnv()
  const tempDirs = []
  try {
    clearEnv()
    const root = useTempCacheRoot()
    tempDirs.push(root)
    const payload = Buffer.from('fake-binary-bytes')
    const asset = { file: 'fake-cloudflared.bin', sha256: sha256Hex(payload) }
    const before = fs.readdirSync(os.tmpdir())

    const finalPath = await ensureCloudflared(undefined, () => {}, {
      fetchImpl: fetchReturning(payload),
      pathProbe: async () => undefined,
      asset,
    })

    assert.ok(fs.statSync(finalPath).isFile())
    assert.equal(fs.readFileSync(finalPath, 'utf8'), 'fake-binary-bytes')
    assert.ok(finalPath.includes(`${path.sep}dsh-pocket${path.sep}cloudflared`), finalPath)
    // Temp download artifact removed from the system temp dir.
    const leftovers = fs.readdirSync(os.tmpdir())
      .filter((name) => !before.includes(name) && name.includes(`dsh-pocket-${asset.file}`))
    assert.deepEqual(leftovers, [])
  } finally {
    restoreEnv(saved)
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('ensureCloudflared rejects on checksum mismatch and caches nothing', async () => {
  const saved = saveEnv()
  const tempDirs = []
  try {
    clearEnv()
    const root = useTempCacheRoot()
    tempDirs.push(root)
    await assert.rejects(
      ensureCloudflared(undefined, () => {}, {
        fetchImpl: fetchReturning(Buffer.from('payload')),
        pathProbe: async () => undefined,
        asset: { file: 'fake-bad.bin', sha256: 'deadbeef' },
      }),
      /checksum mismatch/,
    )
    const cacheDir = path.join(root, 'dsh-pocket', 'cloudflared')
    if (fs.existsSync(cacheDir)) assert.deepEqual(fs.readdirSync(cacheDir), [])
  } finally {
    restoreEnv(saved)
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('ensureCloudflared aborts and cleans up when the size cap is exceeded', async () => {
  const saved = saveEnv()
  const tempDirs = []
  try {
    clearEnv()
    const root = useTempCacheRoot()
    tempDirs.push(root)
    const asset = { file: 'fake-oversize.bin', sha256: sha256Hex(Buffer.alloc(100)) }
    const before = fs.readdirSync(os.tmpdir())
    await assert.rejects(
      ensureCloudflared(undefined, () => {}, {
        fetchImpl: fetchReturning(Buffer.alloc(100)),
        pathProbe: async () => undefined,
        asset,
        downloadMaxBytes: 10,
      }),
      /exceeded 10 bytes/,
    )
    const leftovers = fs.readdirSync(os.tmpdir())
      .filter((name) => !before.includes(name) && name.includes(`dsh-pocket-${asset.file}`))
    assert.deepEqual(leftovers, [])
    assert.deepEqual(fs.readdirSync(path.join(root, 'dsh-pocket', 'cloudflared')), [])
  } finally {
    restoreEnv(saved)
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('ensureCloudflared fails on HTTP errors and removes the partial file', async () => {
  const saved = saveEnv()
  const tempDirs = []
  try {
    clearEnv()
    const root = useTempCacheRoot()
    tempDirs.push(root)
    const asset = { file: 'fake-404.bin', sha256: 'x' }
    const before = fs.readdirSync(os.tmpdir())
    await assert.rejects(
      ensureCloudflared(undefined, () => {}, {
        fetchImpl: async () => ({ ok: false, status: 404 }),
        pathProbe: async () => undefined,
        asset,
      }),
      /HTTP 404/,
    )
    const leftovers = fs.readdirSync(os.tmpdir())
      .filter((name) => !before.includes(name) && name.includes(`dsh-pocket-${asset.file}`))
    assert.deepEqual(leftovers, [])
  } finally {
    restoreEnv(saved)
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('ensureCloudflared aborts a stalled download via the timeout signal', async () => {
  const saved = saveEnv()
  const tempDirs = []
  try {
    clearEnv()
    const root = useTempCacheRoot()
    tempDirs.push(root)
    const asset = { file: 'fake-stall.bin', sha256: 'x' }
    const before = fs.readdirSync(os.tmpdir())
    await assert.rejects(
      ensureCloudflared(undefined, () => {}, {
        fetchImpl: fetchReturning(Buffer.alloc(10), { delayMs: 5000 }),
        pathProbe: async () => undefined,
        asset,
        downloadTimeoutMs: 50,
      }),
      (error) => /abort|timeout/i.test(error?.name ?? '') || /aborted|timed out/i.test(String(error?.message ?? error)),
    )
    const leftovers = fs.readdirSync(os.tmpdir())
      .filter((name) => !before.includes(name) && name.includes(`dsh-pocket-${asset.file}`))
    assert.deepEqual(leftovers, [])
  } finally {
    restoreEnv(saved)
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('ensureCloudflared extracts a darwin-style .tgz and caches the inner binary', async () => {
  const saved = saveEnv()
  const tempDirs = []
  try {
    clearEnv()
    const root = useTempCacheRoot()
    tempDirs.push(root)

    // Build a real .tgz with the binary nested one level down, mirroring the
    // official archive layout.
    const build = makeTempDir('dsh-pocket-test-tgz-')
    tempDirs.push(build)
    fs.mkdirSync(path.join(build, 'cloudflared'))
    fs.writeFileSync(path.join(build, 'cloudflared', 'cloudflared'), '#!/bin/sh\necho ok\n')
    const tgz = path.join(build, 'asset.tgz')
    execFileSync('tar', ['-czf', tgz, '-C', build, 'cloudflared'])
    const payload = fs.readFileSync(tgz)
    const asset = { file: 'cloudflared-darwin-test.tgz', archive: true, sha256: sha256Hex(payload) }

    const finalPath = await ensureCloudflared(undefined, () => {}, {
      fetchImpl: fetchReturning(payload),
      pathProbe: async () => undefined,
      asset,
    })

    assert.ok(fs.statSync(finalPath).isFile())
    assert.equal(fs.readFileSync(finalPath, 'utf8'), '#!/bin/sh\necho ok\n')
    // Extraction work dir is cleaned up.
    const extractLeftovers = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('dsh-pocket-extract-'))
    assert.deepEqual(extractLeftovers, [])
  } finally {
    restoreEnv(saved)
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('ensureCloudflared fails when the archive contains no cloudflared binary', async () => {
  const saved = saveEnv()
  const tempDirs = []
  try {
    clearEnv()
    const root = useTempCacheRoot()
    tempDirs.push(root)

    const build = makeTempDir('dsh-pocket-test-tgz-')
    tempDirs.push(build)
    fs.writeFileSync(path.join(build, 'something-else.txt'), 'nope')
    const tgz = path.join(build, 'asset.tgz')
    execFileSync('tar', ['-czf', tgz, '-C', build, 'something-else.txt'])
    const payload = fs.readFileSync(tgz)
    const asset = { file: 'cloudflared-darwin-empty.tgz', archive: true, sha256: sha256Hex(payload) }

    await assert.rejects(
      ensureCloudflared(undefined, () => {}, {
        fetchImpl: fetchReturning(payload),
        pathProbe: async () => undefined,
        asset,
      }),
      /not found inside the extracted archive/,
    )
    const extractLeftovers = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('dsh-pocket-extract-'))
    assert.deepEqual(extractLeftovers, [])
  } finally {
    restoreEnv(saved)
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('one-time migration moves the legacy dsh-phone-native cache into dsh-pocket', async () => {
  const saved = saveEnv()
  const tempDirs = []
  try {
    clearEnv()
    const root = useTempCacheRoot()
    tempDirs.push(root)
    const legacyDir = path.join(root, 'dsh-phone-native', 'cloudflared')
    fs.mkdirSync(legacyDir, { recursive: true })
    fs.writeFileSync(path.join(legacyDir, 'cloudflared-old-build.exe'), 'old')

    const payload = Buffer.from('new-binary')
    const asset = { file: 'fake-migrate.bin', sha256: sha256Hex(payload) }
    const finalPath = await ensureCloudflared(undefined, () => {}, {
      fetchImpl: fetchReturning(payload),
      pathProbe: async () => undefined,
      asset,
    })

    assert.ok(fs.statSync(finalPath).isFile())
    // Legacy contents moved over...
    assert.ok(fs.existsSync(path.join(path.dirname(finalPath), 'cloudflared-old-build.exe')))
    // ...and the legacy dir is empty.
    assert.deepEqual(fs.readdirSync(legacyDir), [])
  } finally {
    restoreEnv(saved)
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('migration does not run when the new cache dir already has content', async () => {
  const saved = saveEnv()
  const tempDirs = []
  try {
    clearEnv()
    const root = useTempCacheRoot()
    tempDirs.push(root)
    const newDir = path.join(root, 'dsh-pocket', 'cloudflared')
    fs.mkdirSync(newDir, { recursive: true })
    fs.writeFileSync(path.join(newDir, 'existing.txt'), 'keep')
    const legacyDir = path.join(root, 'dsh-phone-native', 'cloudflared')
    fs.mkdirSync(legacyDir, { recursive: true })
    fs.writeFileSync(path.join(legacyDir, 'legacy.txt'), 'legacy')

    // Calling the resolver path triggers cache-dir evaluation indirectly via a
    // second ensure run; use an already-cached final binary to short-circuit.
    const payload = Buffer.from('x')
    const key = process.platform === 'win32' ? `win32-${process.arch}` : `${process.platform}-${process.arch}`
    const ext = process.platform === 'win32' ? '.exe' : ''
    const version = '2026.8.2'
    fs.writeFileSync(path.join(newDir, `cloudflared-${version}-${key}${ext}`), payload)

    const resolved = await ensureCloudflared(undefined, () => {}, {
      pathProbe: async () => undefined,
      asset: { file: 'unused', sha256: sha256Hex(payload) },
    })
    assert.ok(resolved.startsWith(newDir))
    assert.ok(fs.existsSync(path.join(legacyDir, 'legacy.txt')))
    assert.ok(fs.existsSync(path.join(newDir, 'existing.txt')))
  } finally {
    restoreEnv(saved)
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// WP-SEC-BRIDGE B1 / M4 — the device count is not a reason to refuse a mode
// switch. The old guard was `sessions.size > 0`, and behind a tunnel that count
// is every phone sharing one carrier egress: the desktop could not turn its own
// tunnel off without first evicting someone else's device.
// ---------------------------------------------------------------------------

const fakeTunnelSeam = {
  createCloudflareTunnel: async () => ({
    url: 'https://mode-switch.trycloudflare.com',
    provider: 'cloudflare',
    stop: async () => {},
    process: { once: () => {} },
  }),
}

test('M4: switching the tunnel on is not blocked by a connected phone', async () => {
  const t = await startBridge({ bridgeOptions: fakeTunnelSeam })
  try {
    await t.pairMobile('PocketMode/1.0')
    assert.ok(t.bridge.sessions.size > 0, 'a device is connected')
    const desktop = await t.pairDesktop()
    const res = await httpFetch(`${t.base}/desktop/tunnel/toggle`, {
      method: 'POST',
      headers: { Cookie: desktop, 'content-type': 'application/json' },
      body: JSON.stringify({ enable: true }),
    })
    assert.equal(res.status, 200, 'the switch is answered, not refused')
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.equal(body.active, true)
    assert.equal(t.bridge.tunnelActive, true, 'the tunnel did come up')
  } finally {
    await t.stop()
  }
})

test('M4: switching the tunnel off is not blocked by a connected phone either', async () => {
  const t = await startBridge({ bridgeOptions: fakeTunnelSeam })
  try {
    // Pair first, then bring the tunnel up under that phone, then take it down:
    // the old `sessions.size > 0` guard refused both directions.
    const cookie = await t.pairMobile('PocketMode/1.0')
    assert.ok(t.bridge.sessions.size > 0)
    await t.bridge.toggleTunnel(true)
    assert.equal(t.bridge.tunnelActive, true)
    assert.equal(t.bridge.sessions.size, 1, 'the phone survived the switch')
    await t.bridge.toggleTunnel(false)
    assert.equal(t.bridge.tunnelActive, false, 'the tunnel came down with the phone still listed')
    assert.equal(t.bridge.sessions.size, 1)
    // And the surviving cookie still authenticates afterwards.
    const res = await httpFetch(`${t.base}/api/status`, { headers: { cookie } })
    assert.equal(res.status, 200)
  } finally {
    await t.stop()
  }
})

// ---------------------------------------------------------------------------
// WP-SEC-BRIDGE B1 / M8 — a tunnel launch re-issues the EPHEMERAL password, and
// never touches the durable one.
// ---------------------------------------------------------------------------

test('M8: bringing the tunnel up rotates the ephemeral password', async () => {
  const t = await startBridge({ bridgeOptions: fakeTunnelSeam })
  try {
    t.bridge.ephemeralPin = '111111'
    t.bridge.ephemeralPinExpiresAt = Date.now() + 5 * 60_000
    await t.bridge.toggleTunnel(true)
    assert.notEqual(t.bridge.ephemeralPin, '111111', 'the password shown against the previous public URL is dead')
    assert.ok(t.bridge.ephemeralPinExpiresAt > Date.now(), 'the fresh one is inside its window')
    // Still usable for a reconnect: rotating is not expiring.
    assert.equal(t.bridge.tunnelPinAcceptsReconnect(), true)
  } finally {
    await t.stop()
  }
})

test('M8: a consented durable password survives every tunnel launch', async () => {
  const durable = '482913'
  const t = await startBridge({
    bridgeOptions: {
      ...fakeTunnelSeam,
      pairingPinStore: { load: () => ({ pin: durable, pinConsent: true }), save: () => true },
    },
  })
  try {
    await t.bridge.toggleTunnel(true)
    const view = t.bridge.readPairingPin()
    assert.equal(view.pin, durable, 'the durable promise is not an expiry to be honoured away')
    assert.equal(view.consent, true)
    assert.equal(view.expired, false)
    await t.bridge.toggleTunnel(false)
    await t.bridge.toggleTunnel(true)
    assert.equal(t.bridge.readPairingPin().pin, durable, 'and it survives a second launch too')
  } finally {
    await t.stop()
  }
})

test('M4: an in-flight switch is reported honestly instead of racing a second tunnel', async () => {
  let release
  const t = await startBridge({
    bridgeOptions: {
      createCloudflareTunnel: () =>
        new Promise((resolve) => {
          release = resolve
        }),
    },
  })
  const headers = { Cookie: await t.pairDesktop(), 'content-type': 'application/json' }
  try {
    const launching = httpFetch(`${t.base}/desktop/tunnel/toggle`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ enable: true }),
    })
    // Wait for the launch to be the bridge's current one before asking again:
    // the two requests are concurrent, and the second must arrive while the
    // first is still in flight (a cloudflared download really does take seconds).
    for (let attempt = 0; attempt < 200 && !t.bridge.tunnelLoading; attempt++) {
      await new Promise((resolveTick) => setImmediate(resolveTick))
    }
    assert.equal(t.bridge.tunnelLoading, true, 'the switch is in progress')
    const second = await httpFetch(`${t.base}/desktop/tunnel/toggle`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ enable: true }),
    })
    assert.equal(second.status, 409, 'a second switch is refused while one is running')
    assert.equal((await second.json()).error, 'A tunnel switch is already in progress.')
    release({ url: 'https://late.trycloudflare.com', provider: 'cloudflare', stop: async () => {}, process: { once: () => {} } })
    const first = await launching
    assert.equal(first.status, 200, 'the switch that was allowed did complete')
    const body = await first.json()
    assert.equal(body.active, true)
    assert.equal(body.url, 'https://late.trycloudflare.com')
    assert.equal(t.bridge.tunnelActive, true)
  } finally {
    // Never leave the launch unresolved: stop() waits for it.
    release?.({ url: 'https://fallback.trycloudflare.com', provider: 'cloudflare', stop: async () => {}, process: { once: () => {} } })
    await t.stop()
  }
})
