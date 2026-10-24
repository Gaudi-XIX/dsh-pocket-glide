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
import { dshHomeOverridden, pocketDataDir } from './constants.js'

/**
 * `https://<label>.trycloudflare.com`, the only host shape quick tunnels mint.
 * `api.trycloudflare.com` is excluded on purpose: cloudflared prints it in its
 * own error text, and reading it as the tunnel URL hands the phone a hostname
 * that answers — but with the API, not with this bridge.
 */
const TRYCLOUDFLARE_RE = /https:\/\/(?!api\.)[a-z0-9-]+(?:\.[a-z0-9-]+)*\.trycloudflare\.com/gi

/** Pull the first trycloudflare URL out of a chunk of cloudflared log text. */
export function extractTryCloudflareUrl(text) {
  for (const match of String(text).matchAll(TRYCLOUDFLARE_RE)) return match[0]
  return null
}

/** Strip ANSI escapes so the URL regex sees clean text. */
function stripAnsi(text) {
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
}

/**
 * The proxy variables cloudflared honours, spelled out rather than matched by
 * suffix: a bare `/_proxy$/i` also eats `NODE_USE_ENV_PROXY`, which belongs to
 * Node and has to survive. Ten keys, either case, `NO_PROXY` included — that
 * one is only meaningful next to a proxy this child must not use at all.
 */
const PROXY_ENV_KEY_RE = /^(?:https?|all|ftp|no)_proxy$/i

/**
 * The environment cloudflared is spawned with.
 *
 * cloudflared has to reach the Cloudflare edge itself. When the desktop shell
 * exports a proxy (Clash, Fiddler, a corporate MITM) the child inherits it and
 * dials the proxy instead of the edge; the quick tunnel then dies while the
 * child keeps printing a hostname it never serves, so the failure surfaces as
 * "the page never loads" rather than as an error. Stripping the variables is
 * the whole fix. `NO_PROXY` goes too: it is only meaningful next to a proxy
 * this child should not be using at all.
 *
 * For cloudflared only, never for a Node child: it strips every proxy key,
 * including `NODE_USE_ENV_PROXY`, which Node itself reads.
 *
 * @param {NodeJS.ProcessEnv} [base]
 */
export function buildCloudflaredEnv(base = process.env) {
  const env = {}
  for (const [key, value] of Object.entries(base ?? {})) {
    if (value === undefined) continue
    if (PROXY_ENV_KEY_RE.test(key)) continue
    env[key] = value
  }
  return env
}

/**
 * `--protocol` for the quick tunnel. Defaults to `http2` on purpose: QUIC is
 * the first thing a TUN-mode proxy (Clash fake-ip) or a corporate firewall
 * eats, and a blackholed QUIC leg still lets cloudflared print a URL — the
 * tunnel looks up while the page never loads. `auto` and `quic` stay reachable
 * through the env for a machine that measured otherwise. Read once at module
 * load, so switching it needs a bridge restart — a page reload does nothing.
 */
const QUICK_TUNNEL_PROTOCOL = ['auto', 'http2', 'quic'].includes(
  String(process.env.DSH_POCKET_TUNNEL_PROTOCOL ?? ''),
)
  ? String(process.env.DSH_POCKET_TUNNEL_PROTOCOL)
  : 'http2'

/** True when the path exists and is a regular file (not a directory, not a shim). */
function isExecutableFile(candidate) {
  try {
    return fs.statSync(candidate).isFile()
  } catch {
    return false
  }
}

/**
 * Land `from` as `to` even when the two sit on different volumes.
 *
 * `fs.renameSync` is rename(2): same-mount only. The download workdir is
 * `os.tmpdir()` (the system temp volume) while the cache lives under the data
 * root, so on a machine whose temp and data roots are different volumes every
 * landing rename throws `EXDEV: cross-device link not permitted` and the just
 * verified 55 MB binary is discarded — `ensureCloudflared()` then re-downloads
 * it on the next tunnel start, for ever. `migrateLegacyCloudflaredCache()`
 * above has always tolerated that same error with a bare `catch`; this is the
 * same situation one level down, so it gets the copy fallback instead of a
 * silent give-up.
 *
 * The copy lands on `<to>.part` first: a copy that dies halfway must never
 * leave a truncated file under the name `findCachedBinary()` looks for (it
 * matches the exact cached name, so `.part` is invisible to it).
 * @param {string} from
 * @param {string} to
 * @returns {string} `to`
 */
function moveFileAcrossDevices(from, to) {
  const staged = `${to}.part`
  try {
    try {
      fs.renameSync(from, to)
      return to
    } catch (error) {
      if (error?.code !== 'EXDEV') throw error
    }
    // Different volumes: copy (libuv carries the source mode across) then unlink.
    fs.rmSync(staged, { force: true })
    fs.copyFileSync(from, staged)
    fs.renameSync(staged, to)
    fs.rmSync(from, { force: true })
    return to
  } catch (error) {
    try { fs.rmSync(staged, { force: true }) } catch { /* best effort */ }
    throw error
  }
}

/** Last non-empty line of the tail of a buffer, for error messages. */
function lastOutputLine(output) {
  const lines = stripAnsi(output).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  return (lines.at(-1) ?? '').slice(0, 300)
}

const HEALTH_PROBE_TIMEOUT_MS = 5000

/**
 * Default health probe: run `candidate --version` with a hard 5 s cap. Returns
 * true only when the process started AND exited 0. Never throws.
 * @param {string} candidate
 * @returns {Promise<boolean>}
 */
function probeBinaryVersion(candidate) {
  return new Promise((resolve) => {
    try {
      // On Windows `execFile` can throw SYNCHRONOUSLY for a file that is not a
      // valid image (that is the exact shape of a truncated/garbage candidate),
      // so the try/catch is load-bearing — without it the probe would reject and
      // take the whole resolver down instead of reporting "does not run".
      execFile(candidate, ['--version'], { windowsHide: true, timeout: HEALTH_PROBE_TIMEOUT_MS }, (error) => {
        resolve(error === null)
      })
    } catch {
      resolve(false)
    }
  })
}

/**
 * The failures a fresh token is the only cure for.
 *
 * Everything else cloudflared can meet — a busy port, a flaky DNS answer, an
 * edge 5xx — is worth another dial. These five mean the credential itself was
 * refused, so retrying buys nothing but a longer outage; the bridge asks the
 * reader for a new token instead. Tested case by case because the cost of a
 * false positive is "the app demands a token it already has".
 */
const FATAL_CLOUDFLARED_PATTERNS = [
  /invalid tunnel secret/i,
  /failed to unmarshal/i,
  /invalid token/i,
  /401 unauthorized/i,
  /not a valid tunnel/i,
]

/** @param {string} text cloudflared's own output tail. */
export function isFatalCloudflaredError(text) {
  if (typeof text !== 'string' || text.length === 0) return false
  return FATAL_CLOUDFLARED_PATTERNS.some((pattern) => pattern.test(text))
}

/** Stamp a rejection the caller can branch on without re-reading the log tail. */
function tagFatalTunnelError(error, output) {
  if (isFatalCloudflaredError(output)) {
    error.fatal = true
    error.code = 'tunnel/fatal'
  }
  return error
}

/**
 * The one quick tunnel this process currently has running.
 *
 * Two starts used to leave two carriers racing over the same local port, and
 * the first one kept the URL the phone was holding — a dead URL wearing a live
 * entry. A new quick start terminates the carrier it replaces, so there is
 * never more than one live handle.
 */
let liveQuickChild = null

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
/**
 * The vendored copy the resolver probes last: `<plugin root>/vendor/cloudflared(.exe)`.
 * Named so the R-T2 health gate can tell a VENDORED hit (a file a download or a
 * half-finished fetch script may have left behind in a bad state) from an
 * explicit operator override, which is trusted as given.
 * @returns {string}
 */
function vendoredBinaryPath() {
  const exe = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'
  // lib/ -> ../vendor/, so it also survives the plugin being installed elsewhere.
  return fileURLToPath(new URL(`../vendor/${exe}`, import.meta.url))
}

export function resolveCloudflared(binaryPath) {
  const candidates = [
    binaryPath,
    process.env.DSH_POCKET_CLOUDFLARED,
    process.env.DSH_PHONE_NATIVE_CLOUDFLARED,
    process.env.CLOUDFLARED_BIN,
    // Vendored next to this package — see vendoredBinaryPath().
    vendoredBinaryPath(),
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
 * Where this plugin's cloudflared cache lived before the data root was unified
 * (R12/Q8): `%LOCALAPPDATA%\dsh-pocket\cloudflared` on Windows, the XDG cache
 * elsewhere. Read-only compatibility — the 50+ MB pinned binary already sitting
 * there must not be re-downloaded just because the write target moved.
 * @returns {string}
 */
function preUnificationCacheDir() {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local')
    return path.join(base, 'dsh-pocket', 'cloudflared')
  }
  const base = process.env.XDG_CACHE_HOME ?? path.join(homedir(), '.cache')
  return path.join(base, 'dsh-pocket', 'cloudflared')
}

/**
 * One-time best-effort migration of the legacy dsh-phone-native cloudflared
 * cache into the dsh-pocket cache dir. Runs only when the new dir is missing
 * or empty and the old dir exists. Never throws.
 *
 * Skipped entirely while `DSH_HOME` is set: that is an isolated run, and a
 * migration RENAMES files out of the machine's real cache directory. Under an
 * override the older caches are still read (see `cloudflaredCacheCandidates`)
 * — just never moved.
 */
function migrateLegacyCloudflaredCache(newDir) {
  if (dshHomeOverridden()) return
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

/**
 * The cache directory this plugin WRITES to.
 *
 * `DSH_HOME` in force → the unified root, so an isolated run (a debug clone, an
 * automated check) downloads inside its own tree instead of into the machine's
 * (R12/Q8).
 * No override → exactly where it always was, `%LOCALAPPDATA%\dsh-pocket\cloudflared`
 * on Windows. The pinned binary already sitting there is 55 MB; changing the
 * default write target would either re-download it or move the user's file, and
 * neither is what this item asked for. The unified root is still searched (see
 * `cloudflaredCacheCandidates`), so a machine that once ran under an override
 * finds its own binary either way.
 * @returns {string}
 */
function cloudflaredCacheDir() {
  const dir = dshHomeOverridden() ? pocketDataDir('cloudflared') : preUnificationCacheDir()
  migrateLegacyCloudflaredCache(dir)
  return dir
}

/**
 * Every cache directory a pinned binary may be picked up FROM, in priority
 * order. Reads only; the download target stays `cloudflaredCacheDir()`. Under an
 * override the isolated tree is the whole world, so an isolated run can never
 * consume — let alone rename — the machine's cache.
 * @returns {string[]}
 */
function cloudflaredCacheCandidates() {
  const primary = cloudflaredCacheDir()
  if (dshHomeOverridden()) return [primary]
  const seen = [primary]
  for (const other of [pocketDataDir('cloudflared'), legacyCloudflaredCacheDir()]) {
    if (other !== primary && !seen.includes(other)) seen.push(other)
  }
  return seen
}

function cachedBinaryName(key) {
  const ext = process.platform === 'win32' ? '.exe' : ''
  return `cloudflared-${CLOUDFLARED_VERSION}-${key}${ext}`
}

function cachedBinaryPath(key) {
  return path.join(cloudflaredCacheDir(), cachedBinaryName(key))
}

/**
 * A already-downloaded, already-verified binary for this pinned version,
 * wherever in the cache chain it is. `null` when none exists yet.
 * @param {string} key
 * @returns {string | null}
 */
function findCachedBinary(key) {
  const name = cachedBinaryName(key)
  for (const dir of cloudflaredCacheCandidates()) {
    const candidate = path.join(dir, name)
    if (isExecutableFile(candidate)) return candidate
  }
  return null
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
    execFile('tar', ['-xzf', tmpAsset, '-C', workDir], { windowsHide: true, timeout: 60000 }, (error, stdout, stderr) => {
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
 * pathProbe, versionProbe, asset, downloadTimeoutMs, downloadMaxBytes).
 *
 * @param {string} [binaryPath]
 * @param {(msg: string) => void} [onProgress]
 * @param {{fetchImpl?: Function, pathProbe?: Function, versionProbe?: (candidate: string) => Promise<boolean>, asset?: object, downloadTimeoutMs?: number, downloadMaxBytes?: number}} [hooks]
 * @returns {Promise<string>} executable path
 */
export async function ensureCloudflared(binaryPath, onProgress = () => {}, hooks = {}) {
  const {
    fetchImpl,
    pathProbe = probePathForCloudflared,
    versionProbe = probeBinaryVersion,
    asset: assetOverride,
    downloadTimeoutMs,
    downloadMaxBytes,
  } = hooks

  const resolved = resolveCloudflared(binaryPath)
  if (resolved !== 'cloudflared') {
    // R-T2: an operator override (binaryPath / DSH_POCKET_CLOUDFLARED / …) is
    // trusted as given — it is a deliberate out-of-band choice, and probing it
    // would be second-guessing that operator (a wrapper script would even read
    // as broken). A VENDORED file is different: it is written by
    // `tools/fetch-cloudflared.mjs` or by this very downloader, so it is exactly
    // the artifact an interrupted write leaves truncated. Until this gate, a
    // dead vendored copy was returned for ever: zero repair attempts, every
    // tunnel start failing with `spawn error = UNKNOWN` (probe-10).
    if (resolved !== vendoredBinaryPath()) return resolved
    if (await versionProbe(resolved)) return resolved
    try { fs.rmSync(resolved, { force: true }) } catch { /* best effort */ }
    // Fall through: PATH, then the lazy pinned downloader — i.e. self-repair.
  }

  const system = await pathProbe()
  if (system !== undefined) return system

  const key = platformKey()
  const asset = assetOverride ?? ASSETS[key]
  if (!asset) {
    throw new Error(`cloudflared has no official binary for ${process.platform}-${process.arch} — install it and set DSH_POCKET_CLOUDFLARED`)
  }

  const finalPath = cachedBinaryPath(key)
  // A pinned binary that already exists anywhere in the cache chain is used as
  // it is. Re-downloading 50 MB into the new root would be wasteful and moving
  // it would be moving data nobody asked to move — but it is never copied INTO
  // an isolated run's tree either: under `DSH_HOME` the candidate list is that
  // tree alone (R12/Q8).
  // R-T2: a name match is not proof the file is the verified 55 MB binary —
  // a half-written copy from an interrupted landing sits under exactly this
  // name. Probe it cheaply; on failure treat the hit as a miss and let the
  // downloader below rebuild it (probe-13: 1.5 MB of 0x41 at the cached name
  // was returned as-is with 0 downloads attempted).
  const cached = findCachedBinary(key)
  if (cached !== null) {
    if (await versionProbe(cached)) return cached
    try { fs.rmSync(cached, { force: true }) } catch { /* best effort */ }
  }

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
        moveFileAcrossDevices(extracted, finalPath)
      } finally {
        try { fs.rmSync(extractDir, { recursive: true, force: true }) } catch { /* best effort */ }
      }
    } else {
      // Windows/Linux: the asset is the raw executable.
      if (process.platform !== 'win32') {
        fs.chmodSync(tmpAsset, 0o700)
      }
      moveFileAcrossDevices(tmpAsset, finalPath)
    }
    return finalPath
  } finally {
    try { fs.rmSync(tmpAsset, { force: true }) } catch { /* already moved or never created */ }
  }
}

/**
 * Start a NAMED Cloudflare tunnel in front of `port` (design #3b): a
 * user-owned tunnel (token from the Zero Trust dashboard) bound to a fixed
 * `hostname`, so the pairing QR and the phone's bookmark survive restarts —
 * the exact thing a quick tunnel's random `*.trycloudflare.com` name cannot
 * give.
 *
 * There is no URL to parse out of the child's output — the URL is the
 * configured hostname — so startup is decided by the clock, not by the log:
 * a child still alive `graceMs` after spawn is taken as up. Both pipes stay
 * attached and draining for the life of the tunnel (the quick-tunnel drain
 * discipline, `startCloudflareQuickTunnel` header note), capped so the
 * retained tail stays bounded; the tail exists only to explain an early exit.
 *
 * The token never rides the spawn argv — any same-machine process can read
 * another process's command line — it is handed over via the `TUNNEL_TOKEN`
 * environment variable (cloudflared's documented alternative to putting the
 * token on the command line), so the argv is just `tunnel --no-autoupdate
 * run`. And the token must never ride an error message either: the rejection
 * text is built from the exit code/signal and the child's own output tail,
 * never from the env block.
 * @returns {Promise<{provider:'cloudflare-named', url:string, process:import('node:child_process').ChildProcess, stop:()=>Promise<void>}>}
 */
export async function startCloudflareNamedTunnel(options) {
  const {
    port,
    token,
    hostname,
    binaryPath,
    log,
    spawnImpl = spawn,
    ensureImpl = ensureCloudflared,
    graceMs = 1500,
    onExit,
  } = options
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('A tunnel token is required for a named tunnel.')
  }
  if (typeof hostname !== 'string' || hostname.length === 0) {
    throw new Error('A hostname is required for a named tunnel.')
  }
  const bin = await ensureImpl(binaryPath, (msg) => log?.(`[cloudflared] ${msg}`))
  return await new Promise((resolvePromise, rejectPromise) => {
    let decided = false
    let output = ''
    // P0-1 (2026-10-24): once the promise settled, a dying child was swallowed
    // by `decided` — the bridge kept publishing a URL whose carrier was gone and
    // nothing on this side ever learned it. Report the exit exactly once.
    let exitReported = false
    const reportExit = (code, signal) => {
      if (exitReported) return
      exitReported = true
      options.onExit?.({ code, signal, fatal: isFatalCloudflaredError(output) })
    }
    const handleOutput = (chunk) => {
      // Kept attached for the tunnel's whole life (the pipes must drain); the
      // retained tail is only ever read to explain an early exit.
      output = (output + chunk.toString()).slice(-8192)
    }
    const child = spawnImpl(
      bin,
      ['tunnel', '--no-autoupdate', 'run'],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        // The dashboard token goes by environment, not by argv: a command line
        // is world-readable to every local process, an env block is not.
        // buildCloudflaredEnv drops the proxy variables the desktop shell may
        // have exported — cloudflared must dial the edge itself, not a proxy.
        env: { ...buildCloudflaredEnv(), TUNNEL_TOKEN: token },
      }
    )
    child.stdout?.on('data', handleOutput)
    child.stderr?.on('data', handleOutput)

    const errorTail = () => {
      const detail = stripAnsi(output).trim().slice(-500)
      return detail ? `: ${detail}` : ''
    }
    const finishResolve = () => {
      if (decided) return
      decided = true
      clearTimeout(timer)
      log?.(`[cloudflared] Named tunnel online: https://${hostname} (dashboard ingress must point at http://127.0.0.1:${port})`)
      resolvePromise({
        provider: 'cloudflare-named',
        url: `https://${hostname}`,
        process: child,
        stop: async () => {
          terminateChildProcess(child)
        },
      })
    }
    const finishReject = (error) => {
      if (decided) return
      decided = true
      clearTimeout(timer)
      rejectPromise(tagFatalTunnelError(error, output))
    }

    const timer = setTimeout(() => {
      if (decided) return
      if (child.exitCode !== null || child.signalCode !== null) {
        finishReject(new Error(
          `cloudflared named tunnel exited during startup with code ${child.exitCode}, signal ${child.signalCode}${errorTail()}`
        ))
        return
      }
      finishResolve()
    }, graceMs)
    timer.unref?.()

    child.once('error', (err) => {
      if (decided) return
      finishReject(new Error(
        `${err instanceof Error ? err.message : String(err)}` +
        (err instanceof Error && 'code' in err && err.code === 'ENOENT'
          ? ' — cloudflared binary not found; set DSH_POCKET_CLOUDFLARED to its path'
          : '')
      ))
    })
    child.once('close', (code, signal) => {
      if (decided) {
        reportExit(code, signal)
        return
      }
      finishReject(new Error(
        `cloudflared named tunnel exited early with code ${code}, signal ${signal}${errorTail()}`
      ))
    })
  })
}

/**
 * Start a quick tunnel in front of `port`.
 *
 * The output parser is a startup organ, not a running one: it exists to catch the
 * `*.trycloudflare.com` hostname, and once that is in hand every further chunk is the
 * carrier's own log for a value that can no longer change. `settled()` detaches it on
 * every way out — the URL, the timeout, a spawn error, an early exit — but keeps both
 * pipes DRAINING (`resume()`): cloudflared logs continuously, and a reader that walked
 * away would leave the child blocked on a full pipe, which is a dead tunnel wearing a
 * green dot.
 *
 * `spawnImpl` and `ensureImpl` exist for test injection (the suite must never launch a
 * carrier or touch the download chain); both default to the real thing.
 * @returns {Promise<{provider:'cloudflare', url:string, process:import('node:child_process').ChildProcess, stop:()=>Promise<void>}>}
 */
export async function startCloudflareQuickTunnel(options) {
  const {
    port,
    binaryPath,
    timeoutMs = 30000,
    log,
    spawnImpl = spawn,
    ensureImpl = ensureCloudflared,
    onExit,
  } = options
  const bin = await ensureImpl(binaryPath, (msg) => log?.(`[cloudflared] ${msg}`))
  return new Promise((resolvePromise, rejectPromise) => {
    let decided = false
    let output = ''
    // Same report-once contract as the named leg (P0-1, 2026-10-24): a carrier
    // that dies after the URL was handed out must not do it silently.
    let exitReported = false
    const reportExit = (code, signal) => {
      if (exitReported) return
      exitReported = true
      options.onExit?.({ code, signal, fatal: isFatalCloudflaredError(output) })
    }
    // `--protocol http2` pins the edge leg to TCP. QUIC over UDP is what a
    // TUN-mode proxy (Clash fake-ip) or a corporate firewall blackholes, and a
    // blackholed QUIC leg still lets cloudflared print a hostname — the tunnel
    // reads as healthy while nothing loads. Proxy variables go for the same
    // reason: this child has to dial the edge itself.
    // Single flight: the carrier this start replaces is dead the moment a new
    // URL is minted, and leaving it running only hides that (two cloudflared
    // processes, one of them serving a hostname nobody is told about).
    if (liveQuickChild) {
      terminateChildProcess(liveQuickChild)
      liveQuickChild = null
    }
    const child = spawnImpl(
      bin,
      ['tunnel', '--url', `http://127.0.0.1:${port}`, '--protocol', QUICK_TUNNEL_PROTOCOL],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: buildCloudflaredEnv(),
      }
    )
    liveQuickChild = child

    // A declaration, not a const arrow: `stopParsing` has to hand `off` the
    // identical reference it handed `on`, and that must not depend on which of the
    // two helpers happened to be initialised first.
    function handleOutput(chunk) {
      if (decided) return
      output = (output + chunk.toString()).slice(-16384)
      const extracted = extractTryCloudflareUrl(stripAnsi(output))
      if (!extracted) return
      finishResolve({
        provider: 'cloudflare',
        url: extracted,
        process: child,
        stop: async () => { cleanup() },
      })
    }

    /** Stop parsing; keep draining. Idempotent, and safe if a pipe is missing. */
    function stopParsing() {
      child.stdout?.off('data', handleOutput)
      child.stderr?.off('data', handleOutput)
      child.stdout?.resume()
      child.stderr?.resume()
    }

    function cleanup() {
      terminateChildProcess(child)
      if (liveQuickChild === child) liveQuickChild = null
    }

    function finishResolve(value) {
      if (decided) return
      decided = true
      clearTimeout(timeoutTimer)
      stopParsing()
      log?.(`[cloudflared] Tunnel online: ${value.url}`)
      resolvePromise(value)
    }

    function finishReject(error) {
      if (decided) return
      decided = true
      clearTimeout(timeoutTimer)
      stopParsing()
      rejectPromise(tagFatalTunnelError(error, output))
    }

    const timeoutTimer = setTimeout(() => {
      if (decided) return
      const detail = lastOutputLine(output)
      cleanup()
      finishReject(new Error(
        `Cloudflare Quick Tunnel timed out after ${timeoutMs / 1000}s` +
        (detail ? `: ${detail}` : '') +
        (bin === 'cloudflared' ? ' (no cloudflared binary resolved — set DSH_POCKET_CLOUDFLARED)' : ''),
      ))
    }, timeoutMs)

    child.stdout?.on('data', handleOutput)
    child.stderr?.on('data', handleOutput)
    child.once('error', (err) => {
      if (decided) return
      const detail = lastOutputLine(output)
      finishReject(new Error(
        `${err instanceof Error ? err.message : String(err)}` +
        (detail ? ` (last output: ${detail})` : '') +
        (err instanceof Error && 'code' in err && err.code === 'ENOENT'
          ? ' — cloudflared binary not found; set DSH_POCKET_CLOUDFLARED to its path'
          : ''),
      ))
    })
    child.once('close', (code, signal) => {
      if (decided) {
        if (liveQuickChild === child) liveQuickChild = null
        reportExit(code, signal)
        return
      }
      const detail = lastOutputLine(output)
      finishReject(new Error(
        `cloudflared exited unexpectedly with code ${code}, signal ${signal}` +
        (detail ? `: ${detail}` : ''),
      ))
    })
  })
}
