// Unit coverage for lib/tunnel.js: resolver chain (new env name + legacy
// fallback), lazy download with timeout / size cap / checksum verification,
// darwin .tgz extraction, and the one-time legacy cache migration.
// All network and PATH probes are injected; nothing is really downloaded.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync, spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { startCloudflareNamedTunnel, resolveCloudflared, ensureCloudflared, extractTryCloudflareUrl } from '../lib/tunnel.js'
import { createSettingsStore } from '../lib/settings-store.js'
import { LanMobileBridge } from '../lib/bridge.js'
import { createMuxMonitor } from '../lib/mux-client.js'
import { startBridge, httpFetch } from './helpers.js'

const ENV_KEYS = [
  'DSH_POCKET_CLOUDFLARED',
  'DSH_PHONE_NATIVE_CLOUDFLARED',
  'CLOUDFLARED_BIN',
  'LOCALAPPDATA',
  'XDG_CACHE_HOME',
  // R12/Q8: the cache root now follows the unified data root, so a test that
  // does not pin DSH_HOME would download into the real ~/.dsh.
  'DSH_HOME',
  'USERPROFILE',
  'HOME',
]

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
      // R-T2 added a health gate on the cache hit; this case is about WHICH
      // candidate the read chain picks, so the gate is injected as passing.
      versionProbe: async () => true,
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
// WP-OPS-BRIDGE B2 / R12-Q8 — the tunnel cache follows the SAME data-root rule as
// the log and the pairing password. The isolation half is the point the audit
// called "隔离失效": an override run must neither download into, nor rename away,
// the machine's cache.
// ---------------------------------------------------------------------------

test('DSH_HOME in force: the cache lives under the override and the machine cache is untouched', async () => {
  const saved = saveEnv()
  const isolated = makeTempDir('pocket-tunnel-isolated-')
  const machine = makeTempDir('pocket-tunnel-machine-')
  try {
    clearEnv()
    process.env.DSH_HOME = isolated
    if (process.platform === 'win32') process.env.LOCALAPPDATA = machine
    else process.env.XDG_CACHE_HOME = machine
    // The retired plugin's cache, where the migration path would rename from.
    const phoneNative = path.join(machine, 'dsh-phone-native', 'cloudflared')
    fs.mkdirSync(phoneNative, { recursive: true })
    fs.writeFileSync(path.join(phoneNative, 'cloudflared-old-build.exe'), 'old')

    const payload = Buffer.from('isolated-binary')
    const finalPath = await ensureCloudflared(undefined, () => {}, {
      fetchImpl: fetchReturning(payload),
      pathProbe: async () => undefined,
      asset: { file: 'fake-isolated.bin', sha256: sha256Hex(payload) },
    })

    assert.ok(finalPath.startsWith(path.join(isolated, 'pocket', 'cloudflared')), finalPath)
    assert.ok(fs.statSync(finalPath).isFile())
    assert.equal(
      fs.existsSync(path.join(machine, 'dsh-pocket', 'cloudflared')),
      false,
      'an isolated run created nothing in the machine root',
    )
    assert.equal(
      fs.existsSync(path.join(phoneNative, 'cloudflared-old-build.exe')),
      true,
      'and the migration did not rename the machine cache away under an override',
    )
  } finally {
    restoreEnv(saved)
    fs.rmSync(isolated, { recursive: true, force: true })
    fs.rmSync(machine, { recursive: true, force: true })
  }
})

test('a pinned binary already in the machine cache is reused, not re-downloaded or moved', async () => {
  // No override in force: the download target is where the binary already sits.
  // The point of this case is that unifying the root must not cost the user a
  // 55 MB re-download, and must not relocate their file.
  const saved = saveEnv()
  const root = useTempCacheRoot()
  const unified = makeTempDir('pocket-tunnel-unified-')
  try {
    clearEnv()
    if (process.platform === 'win32') process.env.LOCALAPPDATA = root
    else process.env.XDG_CACHE_HOME = root
    // A file written by an earlier run that DID use the unified root: same pinned
    // name, found through the read chain.
    const key = `${process.platform}-${process.arch}`
    const ext = process.platform === 'win32' ? '.exe' : ''
    const name = `cloudflared-2026.8.2-${key}${ext}`
    const unifiedDir = path.join(unified, 'pocket', 'cloudflared')
    fs.mkdirSync(unifiedDir, { recursive: true })
    const unifiedBinary = path.join(unifiedDir, name)
    fs.writeFileSync(unifiedBinary, 'already-verified')
    process.env.DSH_HOME = unified

    const resolved = await ensureCloudflared(undefined, () => {}, {
      fetchImpl: async () => {
        throw new Error('must not download: a pinned binary already exists')
      },
      pathProbe: async () => undefined,
      // R-T2: the hit is now health-checked first; this case pins the reuse
      // decision, so the gate is injected as passing (a real probe is exercised
      // by the R-T2 cases below).
      versionProbe: async () => true,
      asset: { file: 'unused', sha256: 'x' },
    })
    assert.equal(resolved, unifiedBinary, 'the existing binary was used as it is')
    assert.equal(fs.existsSync(unifiedBinary), true, 'and it was not moved out of the tree it lives in')
  } finally {
    restoreEnv(saved)
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(unified, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// WP-RESCAN-A / R-T1 — the landing move must survive a cross-volume cache.
// `fs.renameSync` is rename(2): same-mount only. The download workdir is
// `os.tmpdir()` (the system temp volume) while the cache lives under the data
// root, so on a machine whose temp and data roots are different volumes the
// landing threw `EXDEV: cross-device link not permitted`, the freshly verified
// 55 MB binary was discarded, and the next tunnel start downloaded it again —
// for ever, ~55 MB per start (probe-01 / probe-05 / probe-06).
// ---------------------------------------------------------------------------

test('R-T1: an EXDEV landing falls back to copy+unlink and still caches the binary', async () => {
  const saved = saveEnv()
  const tempDirs = []
  try {
    clearEnv()
    const root = useTempCacheRoot()
    tempDirs.push(root)
    const payload = Buffer.from('cross-volume-binary')
    const asset = { file: 'fake-exdev.bin', sha256: sha256Hex(payload) }

    // Inject the cross-device error rather than depending on this machine having
    // a second writable volume: a rename out of the temp workdir fails exactly
    // the way rename(2) does across mounts, while the staged rename inside the
    // cache dir is left alone. (The live error was reproduced too — renaming
    // C:\Users\...\Temp\x to F:\...\x throws `EXDEV: cross-device link not
    // permitted` — and the env-gated case below exercises the real thing.)
    const realRename = fs.renameSync
    const attempts = []
    fs.renameSync = (from, to) => {
      attempts.push({ from: String(from), to: String(to) })
      if (String(from).startsWith(os.tmpdir()) && !String(from).endsWith('.part')) {
        const error = new Error(`EXDEV: cross-device link not permitted, rename '${from}' -> '${to}'`)
        error.code = 'EXDEV'
        throw error
      }
      return realRename(from, to)
    }
    let finalPath
    try {
      finalPath = await ensureCloudflared(undefined, () => {}, {
        fetchImpl: fetchReturning(payload),
        pathProbe: async () => undefined,
        asset,
      })
    } finally {
      fs.renameSync = realRename
    }

    assert.equal(attempts.length, 2, 'one EXDEV rename, then the staged one')
    assert.ok(attempts[0].from.startsWith(os.tmpdir()), 'the landing started as a rename out of the temp dir')
    assert.ok(attempts[1].from.endsWith('.part'), 'the fallback staged a .part first, never a truncated final name')
    assert.equal(fs.readFileSync(finalPath, 'utf8'), 'cross-volume-binary', 'the verified bytes survived the fallback')
    assert.deepEqual(
      fs.readdirSync(path.dirname(finalPath)).filter((name) => name.endsWith('.part')),
      [],
      'no half-written .part was left behind',
    )
    assert.equal(
      fs.existsSync(path.join(os.tmpdir(), `dsh-pocket-${asset.file}-${process.pid}`)),
      false,
      'and the temp artifact is gone',
    )
  } finally {
    restoreEnv(saved)
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('R-T1: a non-EXDEV landing failure is still fatal, not papered over', async () => {
  const saved = saveEnv()
  const tempDirs = []
  try {
    clearEnv()
    const root = useTempCacheRoot()
    tempDirs.push(root)
    const payload = Buffer.from('locked-binary')
    const asset = { file: 'fake-locked.bin', sha256: sha256Hex(payload) }

    const realRename = fs.renameSync
    fs.renameSync = (from, to) => {
      if (String(from).startsWith(os.tmpdir())) {
        const error = new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`)
        error.code = 'EPERM'
        throw error
      }
      return realRename(from, to)
    }
    try {
      await assert.rejects(
        ensureCloudflared(undefined, () => {}, {
          fetchImpl: fetchReturning(payload),
          pathProbe: async () => undefined,
          asset,
        }),
        /EPERM/,
        'only EXDEV gets the copy fallback — a locked file must not be silently copied around',
      )
    } finally {
      fs.renameSync = realRename
    }
  } finally {
    restoreEnv(saved)
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('R-T1: a real cross-volume cache root still caches the binary (needs POCKET_XVOL_ROOT)', async (t) => {
  // The injection above pins the fallback's shape; this one proves it on real
  // volumes, and is env-gated because only the operator knows which of this
  // machine's volumes is writable and different from `os.tmpdir()`.
  const target = process.env.POCKET_XVOL_ROOT?.trim()
  if (!target) {
    t.skip('需要 POCKET_XVOL_ROOT 指到与 os.tmpdir() 不同卷的可写目录才验（本仓约定：环境相关验证 env-gated）')
    return
  }
  const saved = saveEnv()
  let root
  try {
    clearEnv()
    root = fs.mkdtempSync(path.join(target, 'dsh-pocket-xvol-'))
    if (process.platform === 'win32') process.env.LOCALAPPDATA = root
    else process.env.XDG_CACHE_HOME = root

    // First prove the two roots really are on different volumes, otherwise this
    // test would pass for the wrong reason.
    const probeFrom = path.join(os.tmpdir(), `dsh-pocket-xvol-probe-${process.pid}`)
    fs.writeFileSync(probeFrom, 'probe')
    assert.throws(
      () => fs.renameSync(probeFrom, path.join(root, 'probe.bin')),
      /EXDEV/,
      `POCKET_XVOL_ROOT (${target}) must be on another volume than os.tmpdir() (${os.tmpdir()})`,
    )
    fs.rmSync(probeFrom, { force: true })

    const payload = Buffer.from('real-cross-volume-binary')
    const asset = { file: 'fake-xvol.bin', sha256: sha256Hex(payload) }
    const finalPath = await ensureCloudflared(undefined, () => {}, {
      fetchImpl: fetchReturning(payload),
      pathProbe: async () => undefined,
      asset,
      // This test measures the cross-volume landing, not the health gate: the
      // payload is a few bytes of text and would be judged dead by R-T2's probe.
      versionProbe: async () => true,
    })

    assert.equal(fs.readFileSync(finalPath, 'utf8'), 'real-cross-volume-binary')
    assert.ok(finalPath.startsWith(path.join(root, 'dsh-pocket', 'cloudflared')), finalPath)
    assert.deepEqual(
      fs.readdirSync(path.dirname(finalPath)).filter((name) => name.endsWith('.part')),
      [],
      'no .part left on the far volume',
    )
    // A second call reuses the cached binary instead of re-downloading it — the
    // whole point of R-T1: without the fallback the cache stayed empty for ever.
    let downloads = 0
    const reused = await ensureCloudflared(undefined, () => {}, {
      fetchImpl: async () => {
        downloads += 1
        throw new Error('must not download: the cross-volume landing cached the binary')
      },
      pathProbe: async () => undefined,
      asset,
      versionProbe: async () => true,
    })
    assert.equal(reused, finalPath, 'the cached binary is found on the next start')
    assert.equal(downloads, 0, 'and nothing is downloaded again')
  } finally {
    restoreEnv(saved)
    if (root) fs.rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// WP-RESCAN-A / R-T2 — a name match is not a working binary.
// `isExecutableFile()` only proves "a regular file sits under the expected
// name", which is also what a truncated download, an HTML error page saved by an
// interrupted script, or a half-written vendored copy look like. Honoring such a
// hit made the tunnel fail at every start with zero repair attempts (probe-10:
// `spawn --version` → `spawn error = UNKNOWN`; probe-13: 1.5 MB of 0x41 at the
// cached name, downloads attempted 0).
// ---------------------------------------------------------------------------

test('R-T2: a dead vendored file is rejected and the resolver self-repairs', async () => {
  const saved = saveEnv()
  const tempDirs = []
  const root = fileURLToPath(new URL('..', import.meta.url))
  const vendorFile = path.join(root, 'vendor', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared')
  const hadVendor = fs.existsSync(vendorFile)
  const vendorDirExisted = fs.existsSync(path.join(root, 'vendor'))
  try {
    clearEnv()
    const cacheRoot = useTempCacheRoot()
    tempDirs.push(cacheRoot)
    // A truncated/garbage vendored copy — exactly what an interrupted
    // `tools/fetch-cloudflared.mjs` leaves behind.
    fs.mkdirSync(path.dirname(vendorFile), { recursive: true })
    fs.writeFileSync(vendorFile, 'not-a-real-binary')

    const probed = []
    const payload = Buffer.from('repaired-binary')
    const finalPath = await ensureCloudflared(undefined, () => {}, {
      fetchImpl: fetchReturning(payload),
      pathProbe: async () => undefined,
      versionProbe: async (candidate) => {
        probed.push(candidate)
        return false
      },
      asset: { file: 'fake-vendor-repair.bin', sha256: sha256Hex(payload) },
    })

    assert.deepEqual(probed, [vendorFile], 'the vendored hit was health-checked before being honored')
    assert.equal(
      fs.existsSync(vendorFile),
      false,
      'the dead vendored file was removed, so the next start does not re-probe it for ever',
    )
    assert.equal(fs.readFileSync(finalPath, 'utf8'), 'repaired-binary', 'the resolver repaired itself by downloading')
    assert.ok(finalPath.includes(`${path.sep}dsh-pocket${path.sep}cloudflared`), finalPath)
  } finally {
    restoreEnv(saved)
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(vendorFile, { force: true })
    // Never leave a vendor/ dir the repo did not have (repo-hygiene ⑧ pins this).
    if (!vendorDirExisted && fs.existsSync(path.join(root, 'vendor'))) {
      fs.rmSync(path.join(root, 'vendor'), { recursive: true, force: true })
    }
    assert.equal(hadVendor, fs.existsSync(vendorFile), 'the pre-test vendor state was restored')
  }
})

test('R-T2: a healthy vendored file is still honored without downloading', async () => {
  const saved = saveEnv()
  const root = fileURLToPath(new URL('..', import.meta.url))
  const vendorFile = path.join(root, 'vendor', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared')
  const vendorDirExisted = fs.existsSync(path.join(root, 'vendor'))
  try {
    clearEnv()
    fs.mkdirSync(path.dirname(vendorFile), { recursive: true })
    fs.writeFileSync(vendorFile, 'healthy-vendored-binary')

    const resolved = await ensureCloudflared(undefined, () => {}, {
      fetchImpl: async () => {
        throw new Error('must not download: the vendored file is healthy')
      },
      pathProbe: async () => undefined,
      versionProbe: async () => true,
      asset: { file: 'unused', sha256: 'x' },
    })
    assert.equal(resolved, vendorFile, 'a vendored file that starts is used as it is')
    assert.equal(fs.existsSync(vendorFile), true, 'and it is not deleted')
  } finally {
    restoreEnv(saved)
    fs.rmSync(vendorFile, { force: true })
    if (!vendorDirExisted && fs.existsSync(path.join(root, 'vendor'))) {
      fs.rmSync(path.join(root, 'vendor'), { recursive: true, force: true })
    }
  }
})

test('R-T2: an operator override is trusted as given, never health-gated', async () => {
  // binaryPath / DSH_POCKET_CLOUDFLARED / DSH_PHONE_NATIVE_CLOUDFLARED /
  // CLOUDFLARED_BIN are deliberate out-of-band choices (a wrapper script would
  // even read as "broken"). The gate is for files this plugin wrote itself.
  const saved = saveEnv()
  const dir = makeTempDir('dsh-pocket-test-override-')
  try {
    clearEnv()
    const override = path.join(dir, 'my-wrapper.cmd')
    fs.writeFileSync(override, '@echo off\r\n')
    process.env.DSH_POCKET_CLOUDFLARED = override

    let probed = 0
    const resolved = await ensureCloudflared(undefined, () => {}, {
      fetchImpl: async () => {
        throw new Error('must not download: an override was given')
      },
      pathProbe: async () => undefined,
      versionProbe: async () => {
        probed += 1
        return false
      },
      asset: { file: 'unused', sha256: 'x' },
    })
    assert.equal(resolved, override, 'the override is returned untouched')
    assert.equal(probed, 0, 'and was not probed — an override that does not answer --version is still the operator choice')
    assert.equal(fs.existsSync(override), true, 'nor deleted')
  } finally {
    restoreEnv(saved)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('R-T2: a dead cached binary is re-downloaded instead of returned', async () => {
  const saved = saveEnv()
  const tempDirs = []
  try {
    clearEnv()
    const root = useTempCacheRoot()
    tempDirs.push(root)
    const key = process.platform === 'win32' ? `win32-${process.arch}` : `${process.platform}-${process.arch}`
    const ext = process.platform === 'win32' ? '.exe' : ''
    const cacheDir = path.join(root, 'dsh-pocket', 'cloudflared')
    fs.mkdirSync(cacheDir, { recursive: true })
    const dead = path.join(cacheDir, `cloudflared-2026.8.2-${key}${ext}`)
    fs.writeFileSync(dead, 'dead-cached-binary')

    const payload = Buffer.from('fresh-binary')
    const finalPath = await ensureCloudflared(undefined, () => {}, {
      fetchImpl: fetchReturning(payload),
      pathProbe: async () => undefined,
      versionProbe: async (candidate) => candidate !== dead,
      asset: { file: 'fake-cache-repair.bin', sha256: sha256Hex(payload) },
    })

    assert.equal(finalPath, dead, 'the repaired binary lands at the pinned cache name')
    assert.equal(fs.readFileSync(finalPath, 'utf8'), 'fresh-binary', 'the dead file was replaced by a verified download')
  } finally {
    restoreEnv(saved)
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('R-T2: the real health probe rejects garbage and accepts a runnable file', async () => {
  // Exercises the DEFAULT probe (not an injected one): a garbage file must fail
  // the gate, and a file that really answers `--version` with exit 0 must pass.
  const saved = saveEnv()
  const dir = makeTempDir('dsh-pocket-test-healthprobe-')
  const tempDirs = []
  try {
    clearEnv()
    const cacheRoot = useTempCacheRoot()
    tempDirs.push(cacheRoot)

    // A real, runnable "binary" for this platform: node itself, copied under the
    // cached name. It answers `--version` with exit 0.
    const key = process.platform === 'win32' ? `win32-${process.arch}` : `${process.platform}-${process.arch}`
    const ext = process.platform === 'win32' ? '.exe' : ''
    const cacheDir = path.join(cacheRoot, 'dsh-pocket', 'cloudflared')
    fs.mkdirSync(cacheDir, { recursive: true })
    const runnable = path.join(cacheDir, `cloudflared-2026.8.2-${key}${ext}`)
    fs.copyFileSync(process.execPath, runnable)

    const resolved = await ensureCloudflared(undefined, () => {}, {
      fetchImpl: async () => {
        throw new Error('must not download: the cached file really runs')
      },
      pathProbe: async () => undefined,
      asset: { file: 'unused', sha256: 'x' },
    })
    assert.equal(resolved, runnable, 'the default probe accepted a file that answers --version with exit 0')

    // And garbage under the same name is refused by the same default probe.
    fs.writeFileSync(runnable, 'garbage-not-a-program')
    const payload = Buffer.from('replaced')
    const repaired = await ensureCloudflared(undefined, () => {}, {
      fetchImpl: fetchReturning(payload),
      pathProbe: async () => undefined,
      asset: { file: 'fake-healthprobe.bin', sha256: sha256Hex(payload) },
    })
    assert.equal(fs.readFileSync(repaired, 'utf8'), 'replaced', 'garbage failed the real probe and was replaced')
  } finally {
    restoreEnv(saved)
    fs.rmSync(dir, { recursive: true, force: true })
    for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// WP-RESCAN-A / R-T2 + R-T3 + R-T10 — the vendor fetch script's own contract.
// R-T3: `--allow-unverified` relaxed the FETCH but never the CHECK, so a
// non-pinned `--check` compared against the PINNED digest and always exited 1
// (probe-09), while `--print` was blocked outright by the version gate (probe-04).
// R-T2: the script renamed into vendor/ BEFORE probing and left the broken file
// there on failure (probe-11). R-T10: the curl argv had no proto/redirect limits
// and nothing looked at the artifact's magic bytes.
// ---------------------------------------------------------------------------

const FETCH_SCRIPT = fileURLToPath(new URL('../tools/fetch-cloudflared.mjs', import.meta.url))
const VENDOR_DIR = fileURLToPath(new URL('../vendor/', import.meta.url))
const VENDOR_FILE = path.join(VENDOR_DIR, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared')

/** Run the fetch script offline with a clean CLOUDFLARED_VERSION, restoring vendor/ after. */
function runFetchScript(args, { version } = {}) {
  const env = { ...process.env }
  if (version === undefined) delete env.CLOUDFLARED_VERSION
  else env.CLOUDFLARED_VERSION = version
  const vendorDirExisted = fs.existsSync(VENDOR_DIR)
  try {
    return spawnSync(process.execPath, [FETCH_SCRIPT, ...args], { cwd: path.dirname(FETCH_SCRIPT), encoding: 'utf8', env })
  } finally {
    fs.rmSync(VENDOR_FILE, { force: true })
    fs.rmSync(path.join(VENDOR_DIR, 'cloudflared.manifest.json'), { force: true })
    fs.rmSync(path.join(VENDOR_DIR, 'cloudflared.download'), { force: true })
    fs.rmSync(path.join(VENDOR_DIR, 'cloudflared.exe.download'), { force: true })
    if (!vendorDirExisted) fs.rmSync(VENDOR_DIR, { recursive: true, force: true })
  }
}

test('R-T3: --print is never blocked by the unpinned gate', () => {
  const run = runFetchScript(['--print'], { version: '2026.9.1' })
  assert.equal(run.status, 0, `an unpinned --print must still report the contract: ${run.stderr?.trim()}`)
  assert.match(run.stdout, /would fetch .*\/2026\.9\.1\//, 'and it prints the version that would be fetched')
  // "writes nothing" means no artifact: vendor/ itself is a gitignored, possibly
  // pre-existing directory (repo-hygiene ⑧ pins that --print leaves it alone).
  assert.equal(fs.existsSync(VENDOR_FILE), false, '--print must not create the vendor file')
  assert.equal(fs.existsSync(path.join(VENDOR_DIR, 'cloudflared.manifest.json')), false, 'nor a manifest')
})

test('R-T3: --check --allow-unverified verifies the manifest digest of a non-pinned file', () => {
  const payload = Buffer.alloc(1024 * 1024 + 16, 0x41)
  payload.write('MZ', 0, 'ascii')
  const digest = createHash('sha256').update(payload).digest('hex')
  const writeVendor = (manifest) => {
    fs.mkdirSync(VENDOR_DIR, { recursive: true })
    fs.writeFileSync(VENDOR_FILE, payload)
    if (manifest) fs.writeFileSync(path.join(VENDOR_DIR, 'cloudflared.manifest.json'), JSON.stringify(manifest))
  }

  // No manifest yet: --check falls back to the weak (exists + plausible image)
  // check and says so, instead of comparing against the pinned digest.
  writeVendor(null)
  const weak = runFetchScript(['--check', '--allow-unverified'], { version: '2026.9.1' })

  writeVendor({ version: '2026.9.1', sha256: digest, file: 'cloudflared-windows-amd64.exe' })
  const manifestOk = runFetchScript(['--check', '--allow-unverified'], { version: '2026.9.1' })

  assert.equal(weak.status, 0, `a plausible non-pinned file passes the weak check: ${weak.stderr?.trim()}`)
  assert.match(weak.stderr, /weak check/, 'and the operator is told no digest is known')
  assert.equal(manifestOk.status, 0, `the recorded digest is the honest one to compare: ${manifestOk.stderr?.trim()}`)
  assert.match(manifestOk.stdout, /sha256 verified/, 'and it really verified a digest, not just existence')
})

test('R-T3: --check --allow-unverified still fails a wrong digest and a wrong magic', () => {
  const payload = Buffer.alloc(1024 * 1024 + 16, 0x41)
  payload.write('MZ', 0, 'ascii')
  const digest = createHash('sha256').update(payload).digest('hex')

  // A manifest that does not match the file must fail (no silent pass).
  fs.mkdirSync(VENDOR_DIR, { recursive: true })
  fs.writeFileSync(VENDOR_FILE, payload)
  fs.writeFileSync(
    path.join(VENDOR_DIR, 'cloudflared.manifest.json'),
    JSON.stringify({ version: '2026.9.1', sha256: 'deadbeef', file: 'cloudflared-windows-amd64.exe' }),
  )
  const mismatch = runFetchScript(['--check', '--allow-unverified'], { version: '2026.9.1' })

  // Garbage magic with no manifest must also fail the weak check.
  fs.mkdirSync(VENDOR_DIR, { recursive: true })
  fs.writeFileSync(VENDOR_FILE, Buffer.alloc(1024 * 1024 + 16, 0x41))
  const wrongMagic = runFetchScript(['--check', '--allow-unverified'], { version: '2026.9.1' })

  assert.equal(mismatch.status, 1, 'a recorded-but-wrong digest is a real mismatch')
  assert.match(mismatch.stderr, /digest mismatch/, 'and it says so')
  assert.equal(wrongMagic.status, 1, 'a file that is not a plausible image fails the weak check')
  assert.match(wrongMagic.stderr, /weak check failed/, 'and the reason names the magic check')
})

test('R-T10: the fetch argv pins https for the request AND redirects, and bounds the chain', () => {
  const src = fs.readFileSync(FETCH_SCRIPT, 'utf8')
  const argv = /spawn\(\s*'curl',\s*\[([\s\S]*?)\],\s*\{\s*stdio/.exec(src)?.[1] ?? ''
  assert.ok(argv.length > 0, 'the curl argv shape changed — update this pin with it')
  for (const flag of ['--proto', '=https', '--proto-redir', '=https', '--max-redirs', '3']) {
    assert.match(argv, new RegExp(flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `curl argv must carry ${flag}`)
  }
  assert.match(src, /looksLikeTargetBinary/, 'and the artifact is magic-checked before landing')
})

test('R-T2: the fetch script probes BEFORE landing and never leaves the broken file', () => {
  const src = fs.readFileSync(FETCH_SCRIPT, 'utf8')
  const probeAt = src.indexOf("spawn(tempFile, ['--version']")
  const landAt = src.indexOf('fs.renameSync(tempFile, vendorFile)')
  assert.ok(probeAt > 0, 'the probe must run against the .download artifact')
  assert.ok(landAt > probeAt, 'the probe must come BEFORE the rename into vendor/ (that order was the bug)')
  assert.doesNotMatch(
    src,
    /spawn\(vendorFile, \['--version'\]/,
    'probing the landed file is what left a dead binary in vendor/ for ever',
  )
  assert.match(src, /fs\.rmSync\(tempFile, \{ force: true \}\)[\s\S]{0,200}fail\(`--version exited/, 'a failed probe removes the artifact')
})

// ---------------------------------------------------------------------------
// WP-OPS-BRIDGE B2 / M5 — the mux monitor may never reject into the host.
// ---------------------------------------------------------------------------

test('M5: startMuxMonitor catches a rejected monitor instead of leaking it to the host', async () => {
  // Structural half of the same item: the `.catch()` has to come BEFORE the
  // `.finally()`, otherwise the chained promise is still rejected and nobody
  // handles it — inside the host process.
  const source = fs.readFileSync(new URL('../lib/bridge.js', import.meta.url), 'utf8')
  const body = source.slice(source.indexOf('startMuxMonitor() {'))
  const slice = body.slice(0, body.indexOf('\n  }'))
  assert.ok(slice.includes('.catch('), 'no .catch on the monitor task')
  assert.ok(slice.indexOf('.catch(') < slice.indexOf('.finally('), '.catch must precede .finally')

  const rejections = []
  const onRejection = (reason) => rejections.push(String(reason))
  process.on('unhandledRejection', onRejection)
  const t = await startBridge()
  try {
    t.bridge.muxMonitor = { monitorMux: () => Promise.reject(new Error('monitor exploded')) }
    t.bridge.startMuxMonitor()
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.deepEqual(rejections, [], 'the rejection was handled inside the bridge')
    assert.equal(t.bridge.muxTask, undefined, 'a dead task does not block the next start')
    assert.equal(t.bridge.muxAbort, undefined, 'and its abort is released too')
  } finally {
    process.removeListener('unhandledRejection', onRejection)
    await t.stop()
  }
})

test('M5: a harness URL getter that throws is survived inside the loop', async () => {
  // The host surface can be gone already while the monitor is still looping:
  // `webServer.port` on a disposed proxy throws a TypeError. That used to leave
  // `monitorMux` through the top of the while, which is how the rejection in the
  // case above was really produced.
  const logged = []
  const monitor = createMuxMonitor({
    harnessUrl: () => {
      throw new TypeError('cannot read properties of undefined (reading port)')
    },
    innerAuth: { ready: async () => undefined },
    pendingQuestions: new Map(),
    log: (level, message) => logged.push(`${level} ${message}`),
    now: () => Date.now(),
    consumeMuxEnvelope: () => {},
    setEventClientId: () => {},
  })
  const abort = new AbortController()
  const running = monitor.monitorMux(abort.signal)
  await new Promise((resolve) => setTimeout(resolve, 30))
  abort.abort()
  await running
  assert.ok(logged.some((line) => line.startsWith('warn') && line.includes('no harness URL')), logged.join(' | '))
})

// ---------------------------------------------------------------------------
// WP-OPS-BRIDGE B2 / M12 + X4⑦ — the carrier child on host exit, and what an
// unexpected tunnel death costs in signed-out handsets.
// ---------------------------------------------------------------------------

test('M12: the live tunnel child is terminated if the host exits around it', async () => {
  const kills = []
  const child = {
    once: () => {},
    kill: (signal) => {
      kills.push(signal ?? 'SIGTERM')
      return true
    },
    exitCode: null,
    signalCode: null,
  }
  const before = process.listenerCount('exit')
  const t = await startBridge({
    bridgeOptions: {
      createCloudflareTunnel: async () => ({
        url: 'https://exit-hook.trycloudflare.com',
        provider: 'cloudflare',
        process: child,
        stop: async () => {},
      }),
    },
  })
  try {
    await t.bridge.toggleTunnel(true)
    assert.equal(process.listenerCount('exit'), before + 1, 'one host-exit hook is registered while a tunnel is live')
    t.bridge.tunnelExitCleanup?.()
    assert.ok(kills.length >= 1, 'the hook terminates the child')
    assert.equal(kills[0], 'SIGTERM')
    await t.bridge.toggleTunnel(false)
    assert.equal(process.listenerCount('exit'), before, 'stopping the tunnel removes the hook again')
    // Toggling twice in a row must not accumulate listeners.
    await t.bridge.toggleTunnel(true)
    await t.bridge.toggleTunnel(false)
    assert.equal(process.listenerCount('exit'), before, 'no listener leak across toggles')
  } finally {
    await t.stop()
  }
})

test('X4⑦: an unexpected tunnel death reports how many handsets it signed out', async () => {
  const lines = []
  const child = { once: (_event, handler) => { child.handler = handler }, kill: () => true, exitCode: null, signalCode: null }
  const t = await startBridge({
    bridgeOptions: {
      log: (level, message) => lines.push(`${level} ${message}`),
      createCloudflareTunnel: async () => ({
        url: 'https://dies.trycloudflare.com',
        provider: 'cloudflare',
        process: child,
        stop: async () => {},
      }),
    },
  })
  try {
    await t.pairMobile('PocketDies/1.0')
    // A second handset needs a fresh single-use token, and rotating it here is
    // beside the point: what the item asks is that the count of handsets the
    // death signed out is IN THE LINE, whatever that count is.
    const attached = t.bridge.sessions.size
    assert.ok(attached >= 1, 'at least one handset is attached')
    await t.bridge.toggleTunnel(true)
    assert.equal(t.bridge.tunnelActive, true)
    child.handler?.()
    const reported = lines.filter((line) => line.includes('tunnel closed unexpectedly'))
    assert.ok(reported.length >= 1, lines.join(' | '))
    assert.match(reported.at(-1), new RegExp(`signedOut=${String(attached)}\\b`), 'the count of signed-out devices is in the line')
    assert.match(reported.at(-1), /parked=/, 'and so is the count of parked (resumable) entries')
    assert.equal(t.bridge.sessions.size, 0, 'and they really were dropped')
  } finally {
    await t.stop()
  }
})

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

// ---------------------------------------------------------------------------
// Windows black-window reduction: extracting the cloudflared archive spawns a
// child, and a child spawned without `windowsHide` flashes a console window on
// Windows. This pin is source-level on purpose — `extractCloudflaredArchive` is
// private, so there is no seam to call it through — and it is an ANCHORED slice
// rather than a whole-file `includes`: three other `windowsHide: true` sites in
// the same file would make a whole-file check pass even after this one regressed.
// ---------------------------------------------------------------------------

test('Bug 2: the cloudflared archive extraction spawns with windowsHide', () => {
  const src = fs.readFileSync(fileURLToPath(new URL('../lib/tunnel.js', import.meta.url)), 'utf8')
  const anchor = src.indexOf("execFile('tar'")
  assert.ok(anchor > 0, 'the tar extraction call moved — re-anchor this pin instead of deleting it')
  const open = src.indexOf('{', anchor)
  const close = src.indexOf('}', open)
  assert.ok(open > anchor && close > open, 'the tar call must still carry an inline options object')
  const options = src.slice(open, close + 1)
  assert.ok(options.length < 200, 'that slice must be the options object, not the rest of the file')
  assert.match(options, /windowsHide:\s*true/, 'the extraction child must be hidden on Windows')
  assert.match(options, /timeout:\s*60000/, 'and it must keep its 60s extraction timeout')
})

// ---------------------------------------------------------------------------
// Design #3b — the named tunnel (fixed hostname, dashboard token). Same
// injection discipline as tunnel-output.test.js: a stubbed resolver and an
// injected spawner, so nothing here reaches the network or the machine cache
// chain. Assertion MESSAGES never carry the configured token — the args
// themselves are the one place it may appear in this file.
// ---------------------------------------------------------------------------


/** Minimal child double: readable pipes, kill recorder, close/error emitter. */
function fakeNamedChild() {
  const child = new EventEmitter()
  child.stdout = new Readable({ read() {} })
  child.stderr = new Readable({ read() {} })
  child.exitCode = null
  child.signalCode = null
  child.killed = []
  child.kill = (signal) => {
    child.killed.push(signal ?? 'SIGTERM')
    child.exitCode = 1
    return true
  }
  return child
}

const NAMED_STUB_ENSURE = async () => 'stubbed-cloudflared'

test('named tunnel: spawns run --token and resolves after the grace period', async () => {
  const child = fakeNamedChild()
  const spawned = []
  const pending = startCloudflareNamedTunnel({
    port: 43127,
    token: 'ey-named-token-value',
    hostname: 'phone.example.com',
    ensureImpl: NAMED_STUB_ENSURE,
    spawnImpl: (bin, args) => {
      spawned.push({ bin, args })
      return child
    },
    graceMs: 20,
  })
  const instance = await pending
  assert.equal(instance.provider, 'cloudflare-named')
  assert.equal(instance.url, 'https://phone.example.com')
  assert.equal(spawned.length, 1, 'the injected spawner was used — nothing was really launched')
  assert.equal(spawned[0].bin, 'stubbed-cloudflared')
  assert.deepEqual(
    spawned[0].args,
    ['tunnel', '--no-autoupdate', 'run', '--token', 'ey-named-token-value']
  )
  // The pipes stay attached and draining for the life of the tunnel.
  assert.equal(child.stdout.destroyed, false)
  assert.equal(child.stderr.destroyed, false)
  await instance.stop()
  assert.deepEqual(child.killed, ['SIGTERM'], 'stop terminates the carrier')
})

test('named tunnel: an early exit rejects with the output tail and never the token', async () => {
  const child = fakeNamedChild()
  const pending = startCloudflareNamedTunnel({
    port: 43127,
    token: 'ey-named-token-value',
    hostname: 'phone.example.com',
    ensureImpl: NAMED_STUB_ENSURE,
    spawnImpl: () => child,
    graceMs: 60_000,
  })
  await new Promise((resolve) => setImmediate(resolve))
  child.stderr.push(Buffer.from('ERROR: register failed: bad credentials from dashboard', 'utf8'))
  child.emit('close', 1, null)
  await assert.rejects(pending, (error) => {
    assert.match(error.message, /exited early/)
    assert.match(error.message, /bad credentials from dashboard/, 'the tail explains the exit')
    assert.equal(
      error.message.includes('ey-named-token-value'),
      false,
      'the spawn args never ride the error message'
    )
    return true
  })
})

test('named tunnel: a spawn error rejects with the binary hint, not the args', async () => {
  const child = fakeNamedChild()
  const pending = startCloudflareNamedTunnel({
    port: 43127,
    token: 'ey-named-token-value',
    hostname: 'phone.example.com',
    ensureImpl: NAMED_STUB_ENSURE,
    spawnImpl: () => child,
    graceMs: 60_000,
  })
  await new Promise((resolve) => setImmediate(resolve))
  const spawnError = new Error('spawn stubbed-cloudflared ENOENT')
  spawnError.code = 'ENOENT'
  child.emit('error', spawnError)
  await assert.rejects(pending, (error) => {
    assert.match(error.message, /DSH_POCKET_CLOUDFLARED/)
    assert.equal(error.message.includes('ey-named-token-value'), false)
    return true
  })
})

test('desktop tunnel config: masked readback, hostname validation, desktop gate', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pocket-tunnelcfg-'))
  const t = await startBridge({ bridgeOptions: { settingsStore: createSettingsStore(dir) } })
  try {
    // No desktop session → 403, on read and write both.
    assert.equal((await httpFetch(`${t.base}/desktop/tunnel/config`)).status, 403)
    assert.equal(
      (
        await httpFetch(`${t.base}/desktop/tunnel/config`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token: 'T0KEN-value-123456', hostname: 'phone.example.com' }),
        })
      ).status,
      403
    )
    const desktop = await t.pairDesktop()
    const fresh = await httpFetch(`${t.base}/desktop/tunnel/config`, { headers: { Cookie: desktop } })
    assert.deepEqual(await fresh.json(), { ok: true, tokenMasked: '', hostname: '' })
    // Save token + hostname; the readback masks the token and keeps the hostname.
    const save = await httpFetch(`${t.base}/desktop/tunnel/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: desktop },
      body: JSON.stringify({ token: 'T0KEN-value-123456', hostname: 'phone.example.com' }),
    })
    assert.equal(save.status, 200)
    const saved = await save.json()
    assert.equal(saved.hostname, 'phone.example.com')
    assert.match(saved.tokenMasked, /…/)
    assert.equal(saved.tokenMasked.includes('T0KEN-value-123456'), false)
    // A malformed hostname is refused, and the store keeps its previous shape.
    assert.equal(
      (
        await httpFetch(`${t.base}/desktop/tunnel/config`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', Cookie: desktop },
          body: JSON.stringify({ hostname: 'not a hostname' }),
        })
      ).status,
      400
    )
    // A partial save (hostname only) must not wipe the stored token.
    const partial = await httpFetch(`${t.base}/desktop/tunnel/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: desktop },
      body: JSON.stringify({ hostname: 'other.example.com' }),
    })
    assert.equal(partial.status, 200)
    assert.equal((await partial.json()).hostname, 'other.example.com')
    const readback = await httpFetch(`${t.base}/desktop/tunnel/config`, { headers: { Cookie: desktop } })
    const readbackBody = await readback.json()
    assert.notEqual(readbackBody.tokenMasked, '', 'the partial save kept the stored token')
    assert.equal(JSON.stringify(readbackBody).includes('T0KEN-value-123456'), false)
    // The quick/named selection reads the same store: token+hostname configured
    // here is exactly what startCloudflareInstance consults on the next toggle.
    const stored = createSettingsStore(dir).load()
    assert.equal(stored.tunnel.hostname, 'other.example.com')
    assert.equal(stored.tunnel.token, 'T0KEN-value-123456')
  } finally {
    await t.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
