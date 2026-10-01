/**
 * Cloudflare quick tunnel manager for the phone bridge.
 *
 * A quick tunnel (`cloudflared tunnel --url http://127.0.0.1:<port>`) mints a
 * random `*.trycloudflare.com` hostname on every start and prints it on
 * stdout/stderr. That randomness is why the pairing QR has to be re-issued
 * each time the tunnel starts — the same trade-off the original DSH Desktop
 * bridge accepted (README §5 of F:\defws\dsh-mobile-v3).
 *
 * Ported from
 * F:\defws\tmp\20260929-dsh-remote-composer\x-dshdesktop-mobile\startCloudflareQuickTunnel.js
 * (the extracted `startCloudflareQuickTunnel`), minus the Pinggy SSH fallback
 * (dropped for the minimal loop; can be re-added from the same file later).
 */

import { spawn, execFile } from 'node:child_process'
import { Buffer } from 'node:buffer'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { homedir, tmpdir } from 'node:os'

/** `https://<label>.trycloudflare.com`, the only host shape quick tunnels mint. */
const TRYCLOUDFLARE_RE = /https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.trycloudflare\.com/gi

/** Pull the first trycloudflare URL out of a chunk of cloudflared log text. */
export function extractTryCloudflareUrl(text) {
  for (const match of String(text).matchAll(TRYCLOUDFLARE_RE)) return match[0]
  return null
}

/** Strip ANSI escapes so the URL regex sees clean text. */
function stripAnsi(text) {
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
}

/** True when the path exists and is a regular file (not a directory, not a shim). */
function isExecutableFile(candidate) {
  try {
    return fs.statSync(candidate).isFile()
  } catch {
    return false
  }
}

/** Last non-empty line of the tail of a buffer, for error messages. */
function lastOutputLine(output) {
  const lines = stripAnsi(output).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  return (lines.at(-1) ?? '').slice(0, 300)
}

/** SIGTERM then SIGKILL after a grace period; never throws. */
function terminateChildProcess(child, graceMs = 2000) {
  if (child.exitCode !== null || child.signalCode !== null) return
  try {
    child.kill('SIGTERM')
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }, graceMs).unref?.()
  } catch {
    /* already gone */
  }
}

/**
 * Resolve the cloudflared binary.
 *
 * The cloudflared npm package is not a dependency of this plugin, so no
 * package-relative probing happens here — the chain is:
 *
 *   1. the caller-supplied binaryPath
 *   2. DSH_POCKET_CLOUDFLARED (this plugin's own override; the legacy
 *      DSH_PHONE_NATIVE_CLOUDFLARED name is still read as a fallback)
 *   3. CLOUDFLARED_BIN
 *   4. <plugin root>/vendor/cloudflared(.exe) — a vendored copy, deterministic
 *   5. "cloudflared" — a bare command name; PATH lookup and, failing that, the
 *      lazy pinned-binary downloader (see ensureCloudflared)
 *
 * @param {string} [binaryPath]
 * @returns {string} an executable path or a bare command name for PATH lookup
 */
export function resolveCloudflared(binaryPath) {
  const exe = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'
  const candidates = [
    binaryPath,
    process.env.DSH_POCKET_CLOUDFLARED,
    process.env.DSH_PHONE_NATIVE_CLOUDFLARED,
    process.env.CLOUDFLARED_BIN,
    // Vendored next to this package: <plugin root>/vendor/cloudflared(.exe).
    // lib/ -> ../vendor/, so it also survives the plugin being installed elsewhere.
    fileURLToPath(new URL(`../vendor/${exe}`, import.meta.url)),
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0 && isExecutableFile(candidate)) {
      return candidate
    }
  }
  return 'cloudflared'
}

/**
 * Pinned cloudflared release for lazy download.
 * SHA-256 digests are the GitHub assets-API values (from dsh-remote-tunnel-easy).
 */
const CLOUDFLARED_VERSION = '2026.8.2'
const DOWNLOAD_BASE = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}`
const ASSETS = {
  'win32-x64': { file: 'cloudflared-windows-amd64.exe', sha256: 'c29eee2b121f5436a642eed69fd9767da7e7b8c510fa50aaa130337f931357b5' },
  'win32-ia32': { file: 'cloudflared-windows-386.exe', sha256: '6acb072357618fa16c53c43e05438ed728aacd47119f1c6c3aa1a668c3299b43' },
  'darwin-x64': { file: 'cloudflared-darwin-amd64.tgz', archive: true, sha256: 'f1727723c586500e2092368ae21871b3df7ddfd2cb097f22d81bee4a9c458bb4' },
  'darwin-arm64': { file: 'cloudflared-darwin-arm64.tgz', archive: true, sha256: '9042c2c5d8b2de78e60f313d5fb31b6c5c1cebde787a3caf1f2c9588084ac442' },
  'linux-x64': { file: 'cloudflared-linux-amd64', sha256: 'fcfb02b575a52ca1af2e3267af4e1517bcdeb30ac48c834c69abaed3c0576ad2' },
  'linux-arm64': { file: 'cloudflared-linux-arm64', sha256: '7747d94570fb390cf47dcb4f9555c193c6355cda9793f0d878d9049e5d6a7790' },
}

function platformKey() {
  if (process.platform === 'win32' && (process.arch === 'x64' || process.arch === 'ia32')) return `win32-${process.arch}`
  if (process.platform === 'darwin' && (process.arch === 'x64' || process.arch === 'arm64')) return `darwin-${process.arch}`
  if (process.platform === 'linux' && (process.arch === 'x64' || process.arch === 'arm64')) return `linux-${process.arch}`
  return null
}

/** Base dir of the legacy plugin's cloudflared cache; used only for migration. */
function legacyCloudflaredCacheDir() {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local')
    return path.join(base, 'dsh-phone-native', 'cloudflared')
  }
  const base = process.env.XDG_CACHE_HOME ?? path.join(homedir(), '.cache')
  return path.join(base, 'dsh-phone-native', 'cloudflared')
}

/**
 * One-time best-effort migration of the legacy dsh-phone-native cloudflared
 * cache into the dsh-pocket cache dir. Runs only when the new dir is missing
 * or empty and the old dir exists. Never throws.
 */
function migrateLegacyCloudflaredCache(newDir) {
  try {
    const oldDir = legacyCloudflaredCacheDir()
    if (!fs.existsSync(oldDir)) return
    let newIsEmpty = true
    try {
      newIsEmpty = fs.readdirSync(newDir).length === 0
    } catch {
      newIsEmpty = true
    }
    if (!newIsEmpty) return
    fs.mkdirSync(newDir, { recursive: true })
    for (const entry of fs.readdirSync(oldDir)) {
      try {
        fs.renameSync(path.join(oldDir, entry), path.join(newDir, entry))
      } catch {
        /* cross-device or locked entry — leave it in the legacy dir */
      }
    }
  } catch {
    /* migration is best effort */
  }
}

function cloudflaredCacheDir() {
  let dir
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local')
    dir = path.join(base, 'dsh-pocket', 'cloudflared')
  } else {
    const base = process.env.XDG_CACHE_HOME ?? path.join(homedir(), '.cache')
    dir = path.join(base, 'dsh-pocket', 'cloudflared')
  }
  migrateLegacyCloudflaredCache(dir)
  return dir
}

function cachedBinaryPath(key) {
  const ext = process.platform === 'win32' ? '.exe' : ''
  return path.join(cloudflaredCacheDir(), `cloudflared-${CLOUDFLARED_VERSION}-${key}${ext}`)
}

function probePathForCloudflared() {
  return new Promise((resolve) => {
    execFile('cloudflared', ['--version'], { windowsHide: true, timeout: 8000 }, (error) => {
      resolve(error === null ? 'cloudflared' : undefined)
    })
  })
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = fs.createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

const DOWNLOAD_TIMEOUT_MS = 120000
const DOWNLOAD_MAX_BYTES = 60_000_000

/**
 * Download `url` to `dest` with a hard timeout and a max-size guard.
 * Aborts and removes the partial file on any failure.
 */
async function downloadCloudflaredBinary(url, dest, hooks = {}) {
  const {
    fetchImpl = (requestUrl, init) => fetch(requestUrl, init),
    timeoutMs = DOWNLOAD_TIMEOUT_MS,
    maxBytes = DOWNLOAD_MAX_BYTES,
  } = hooks
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) throw new Error(`cloudflared download failed: HTTP ${response.status}`)
    if (!response.body) throw new Error('cloudflared download failed: empty response body')
    await new Promise((resolve, reject) => {
      let bytes = 0
      const sink = fs.createWriteStream(dest)
      const source = Readable.fromWeb(response.body)
      source.on('data', (chunk) => {
        bytes += chunk.length
        if (bytes > maxBytes) {
          source.destroy()
          sink.destroy()
          reject(new Error(`cloudflared download exceeded ${maxBytes} bytes`))
        }
      })
      source.pipe(sink)
      sink.on('finish', resolve)
      sink.on('error', reject)
      source.on('error', reject)
    })
  } catch (error) {
    try { fs.rmSync(dest, { force: true }) } catch { /* nothing written yet */ }
    throw error
  }
}

/** Extract a darwin .tgz asset into workDir using the system tar (ships with macOS). */
function extractCloudflaredArchive(tmpAsset, workDir) {
  return new Promise((resolve, reject) => {
    execFile('tar', ['-xzf', tmpAsset, '-C', workDir], { timeout: 60000 }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr ?? error.message).trim().slice(-300)
        reject(new Error(`cloudflared archive extraction failed: ${detail || error.message}`))
        return
      }
      resolve()
    })
  })
}

/** Recursively find the extracted `cloudflared` binary inside dir. */
function findExtractedBinary(dir, binaryName) {
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
      } else if (entry.isFile() && entry.name === binaryName) {
        return full
      }
    }
  }
  return null
}

/**
 * Async cloudflared resolver with lazy download.
 *
 * Step 1: synchronous resolution (binaryPath, env overrides, vendor dir) via
 *         resolveCloudflared().
 * Step 2: probe PATH with --version.
 * Step 3: download the pinned official binary (2026.8.2) with SHA-256
 *         verification; on darwin the asset is a .tgz that gets extracted
 *         with the system tar; cache the result under the user cache dir.
 *
 * The download happens lazily at tunnel start — never at install time — so the
 * package stays installable without build approval (no postinstall).
 *
 * The optional `hooks` argument exists for test injection (fetchImpl,
 * pathProbe, asset, downloadTimeoutMs, downloadMaxBytes).
 *
 * @param {string} [binaryPath]
 * @param {(msg: string) => void} [onProgress]
 * @param {{fetchImpl?: Function, pathProbe?: Function, asset?: object, downloadTimeoutMs?: number, downloadMaxBytes?: number}} [hooks]
 * @returns {Promise<string>} executable path
 */
export async function ensureCloudflared(binaryPath, onProgress = () => {}, hooks = {}) {
  const {
    fetchImpl,
    pathProbe = probePathForCloudflared,
    asset: assetOverride,
    downloadTimeoutMs,
    downloadMaxBytes,
  } = hooks

  const resolved = resolveCloudflared(binaryPath)
  if (resolved !== 'cloudflared') return resolved

  const system = await pathProbe()
  if (system !== undefined) return system

  const key = platformKey()
  const asset = assetOverride ?? ASSETS[key]
  if (!asset) {
    throw new Error(`cloudflared has no official binary for ${process.platform}-${process.arch} — install it and set DSH_POCKET_CLOUDFLARED`)
  }

  const finalPath = cachedBinaryPath(key)
  if (isExecutableFile(finalPath)) return finalPath

  const dir = path.dirname(finalPath)
  fs.mkdirSync(dir, { recursive: true })
  const tmpAsset = path.join(tmpdir(), `dsh-pocket-${asset.file}-${process.pid}`)

  try {
    onProgress('downloading cloudflared…')
    await downloadCloudflaredBinary(`${DOWNLOAD_BASE}/${asset.file}`, tmpAsset, {
      fetchImpl,
      timeoutMs: downloadTimeoutMs,
      maxBytes: downloadMaxBytes,
    })

    onProgress('verifying cloudflared…')
    const actual = await sha256File(tmpAsset)
    if (actual !== asset.sha256) {
      throw new Error(`cloudflared checksum mismatch for ${asset.file} (got ${actual.slice(0, 12)}…)`)
    }

    if (asset.archive) {
      // darwin: verify the .tgz, extract with the system tar, then cache the
      // binary found inside the archive.
      const extractDir = fs.mkdtempSync(path.join(tmpdir(), 'dsh-pocket-extract-'))
      try {
        onProgress('extracting cloudflared…')
        await extractCloudflaredArchive(tmpAsset, extractDir)
        const extracted = findExtractedBinary(extractDir, 'cloudflared')
        if (!extracted) throw new Error('cloudflared binary not found inside the extracted archive')
        if (process.platform !== 'win32') fs.chmodSync(extracted, 0o755)
        fs.renameSync(extracted, finalPath)
      } finally {
        try { fs.rmSync(extractDir, { recursive: true, force: true }) } catch { /* best effort */ }
      }
    } else {
      // Windows/Linux: the asset is the raw executable.
      if (process.platform !== 'win32') {
        fs.chmodSync(tmpAsset, 0o700)
      }
      fs.renameSync(tmpAsset, finalPath)
    }
    return finalPath
  } finally {
    try { fs.rmSync(tmpAsset, { force: true }) } catch { /* already moved or never created */ }
  }
}

/**
 * Start a quick tunnel in front of `port`.
 * @returns {Promise<{provider:'cloudflare', url:string, process:import('node:child_process').ChildProcess, stop:()=>Promise<void>}>}
 */
export async function startCloudflareQuickTunnel(options) {
  const { port, binaryPath, timeoutMs = 30000, log } = options
  const bin = await ensureCloudflared(binaryPath, (msg) => log?.(`[cloudflared] ${msg}`))
  return new Promise((resolvePromise, rejectPromise) => {
    let resolved = false
    let output = ''
    const child = spawn(bin, ['tunnel', '--url', `http://127.0.0.1:${port}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const timeoutTimer = setTimeout(() => {
      if (resolved) return
      const detail = lastOutputLine(output)
      cleanup()
      rejectPromise(new Error(
        `Cloudflare Quick Tunnel timed out after ${timeoutMs / 1000}s` +
        (detail ? `: ${detail}` : '') +
        (bin === 'cloudflared' ? ' (no cloudflared binary resolved — set DSH_POCKET_CLOUDFLARED)' : ''),
      ))
    }, timeoutMs)

    const cleanup = () => {
      terminateChildProcess(child)
    }

    const handleOutput = (chunk) => {
      output = (output + chunk.toString()).slice(-16384)
      const extracted = extractTryCloudflareUrl(stripAnsi(output))
      if (extracted && !resolved) {
        resolved = true
        clearTimeout(timeoutTimer)
        log?.(`[cloudflared] Tunnel online: ${extracted}`)
        resolvePromise({
          provider: 'cloudflare',
          url: extracted,
          process: child,
          stop: async () => { cleanup() },
        })
      }
    }

    child.stdout?.on('data', handleOutput)
    child.stderr?.on('data', handleOutput)
    child.once('error', (err) => {
      if (resolved) return
      clearTimeout(timeoutTimer)
      const detail = lastOutputLine(output)
      rejectPromise(new Error(
        `${err instanceof Error ? err.message : String(err)}` +
        (detail ? ` (last output: ${detail})` : '') +
        (err instanceof Error && 'code' in err && err.code === 'ENOENT'
          ? ' — cloudflared binary not found; set DSH_POCKET_CLOUDFLARED to its path'
          : ''),
      ))
    })
    child.once('close', (code, signal) => {
      if (resolved) return
      clearTimeout(timeoutTimer)
      const detail = lastOutputLine(output)
      rejectPromise(new Error(
        `cloudflared exited unexpectedly with code ${code}, signal ${signal}` +
        (detail ? `: ${detail}` : ''),
      ))
    })
  })
}
