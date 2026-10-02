/**
 * Pre-seed the cloudflared binary into ./vendor for the pocket bridge.
 *
 * Contract this script has to satisfy — and used not to:
 *
 *   1. NAME. `lib/tunnel.js resolveCloudflared()` probes
 *      `<plugin root>/vendor/cloudflared.exe` on Windows and
 *      `vendor/cloudflared` elsewhere. The old version wrote the GitHub asset
 *      name (`cloudflared-windows-amd64.exe`), a file the resolver never looks
 *      at — so the download succeeded and the tunnel still fell through to PATH.
 *   2. VERSION + DIGEST. At runtime the bridge pins one release and checks its
 *      SHA-256 (`CLOUDFLARED_VERSION` / `ASSETS` in lib/tunnel.js). This script
 *      READS both out of that source instead of keeping its own copy, so a vendored
 *      binary is by construction the same one the bridge would have downloaded and
 *      would have accepted. `CLOUDFLARED_VERSION` here only overrides for an
 *      explicitly unverified fetch (see --allow-unverified below).
 *   3. RANK. vendor/ is the FIFTH link in the resolution chain, not the first:
 *      binaryPath → DSH_POCKET_CLOUDFLARED → (legacy) DSH_PHONE_NATIVE_CLOUDFLARED
 *      → CLOUDFLARED_BIN → vendor/ → bare `cloudflared` on PATH → the lazy
 *      downloader. An env override outranks a vendored file; the header used to
 *      promise the opposite.
 *
 * Usage (from the plugin root):
 *   node tools/fetch-cloudflared.mjs              # fetch pinned build, verify, write vendor/
 *   node tools/fetch-cloudflared.mjs --check      # verify the existing vendor file only (offline)
 *   node tools/fetch-cloudflared.mjs --print      # show what would be fetched, write nothing
 *   node tools/fetch-cloudflared.mjs --force      # overwrite an existing vendor file
 *
 * Network: only the fetch path touches the network (through `curl`, so proxy
 * environment variables apply). --check and --print never do.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tunnelSource = path.join(pluginRoot, 'lib', 'tunnel.js')
const vendorDir = path.join(pluginRoot, 'vendor')
/** The exact file resolveCloudflared() probes — never the release-asset name. */
const vendorFile = path.join(
  vendorDir,
  process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared',
)
const BASE_URL = 'https://github.com/cloudflare/cloudflared/releases/download'

/**
 * Pull the pinned release tag and this platform's asset out of lib/tunnel.js.
 * Parsing (instead of copying) is the point: the bridge is the authority on what
 * it will accept, and a second table here is one edit away from a lie.
 */
function readPinnedContract() {
  let source
  try {
    source = fs.readFileSync(tunnelSource, 'utf8')
  } catch (error) {
    fail(`cannot read ${tunnelSource}: ${error?.message ?? error}`)
  }
  const version = /const CLOUDFLARED_VERSION = '([^']+)'/.exec(source)?.[1]
  if (version === undefined) {
    fail('lib/tunnel.js no longer declares `const CLOUDFLARED_VERSION` — update this script to read the pin.')
  }
  const assets = {}
  const table = /const ASSETS = \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? ''
  for (const match of table.matchAll(
    /'([a-z0-9]+-[a-z0-9]+)':\s*\{([^}]*)\}/g,
  )) {
    const file = /file:\s*'([^']+)'/.exec(match[2])?.[1]
    const sha256 = /sha256:\s*'([0-9a-f]+)'/.exec(match[2])?.[1]
    if (file !== undefined && sha256 !== undefined) assets[match[1]] = { file, sha256 }
  }
  if (Object.keys(assets).length === 0) {
    fail('lib/tunnel.js no longer declares the `ASSETS` digest table in a form this script can read.')
  }
  return { version, assets }
}

function platformKey() {
  const { platform, arch } = process
  const supported =
    (platform === 'win32' && (arch === 'x64' || arch === 'ia32')) ||
    (platform === 'linux' && (arch === 'x64' || arch === 'arm64')) ||
    (platform === 'darwin' && (arch === 'x64' || arch === 'arm64'))
  return supported ? `${platform}-${arch}` : null
}

function fail(message) {
  console.error(`[fetch-cloudflared] ${message}`)
  process.exit(1)
}

function sha256OfFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function digestMatches(filePath, expected) {
  const actual = sha256OfFile(filePath)
  if (actual !== expected) {
    console.error(`[fetch-cloudflared] digest mismatch: expected ${expected}, got ${actual}`)
    return false
  }
  console.log(`[fetch-cloudflared] sha256 verified (${actual})`)
  return true
}

const argv = process.argv.slice(2)
const checkOnly = argv.includes('--check')
const printOnly = argv.includes('--print')
const force = argv.includes('--force')
const allowUnverified = argv.includes('--allow-unverified')

const { version: pinned, assets } = readPinnedContract()
const key = platformKey()
if (key === null) {
  fail(`no pinned asset for ${process.platform}-${process.arch}; install cloudflared yourself and set DSH_POCKET_CLOUDFLARED.`)
}
const asset = assets[key]
if (asset === undefined) fail(`lib/tunnel.js pins no asset for ${key}.`)

const requested = process.env.CLOUDFLARED_VERSION?.trim() || pinned
const unpinned = requested !== pinned
// The pinned release always has a digest in lib/tunnel.js; anything else is
// fetched on the operator's responsibility (--allow-unverified).
const unverified = unpinned
const url = `${BASE_URL}/${requested}/${asset.file}`
console.log(`[fetch-cloudflared] platform ${key}`)
console.log(`[fetch-cloudflared] runtime pin  : ${pinned} (${asset.file})`)
console.log(`[fetch-cloudflared] expected sha : ${asset.sha256}`)
console.log(`[fetch-cloudflared] vendor target: ${vendorFile}`)

if (requested !== pinned && !allowUnverified) {
  fail(`CLOUDFLARED_VERSION=${requested} is not the pinned ${pinned} and its digest is unknown here. Pass --allow-unverified to accept an unverified binary.`)
}
if (/\.tgz$/.test(asset.file)) {
  fail(
    `${asset.file} is an archive; vendor/ is only probed as a bare executable. ` +
      'Let the runtime fetch it (lib/tunnel.js ensureCloudflared unpacks into %LOCALAPPDATA%\\dsh-pocket\\cloudflared), ' +
      'or unpack it yourself and place the binary at the vendor target above.',
  )
}

if (printOnly) {
  console.log(`[fetch-cloudflared] would fetch ${url}`)
  process.exit(0)
}

if (checkOnly) {
  if (!fs.existsSync(vendorFile)) {
    console.error(`[fetch-cloudflared] no vendor file at ${vendorFile}`)
    process.exit(1)
  }
  if (requested !== pinned && !allowUnverified) {
    console.warn('[fetch-cloudflared] --check against a non-pinned version compares the pinned digest anyway.')
  }
  process.exit(digestMatches(vendorFile, asset.sha256) ? 0 : 1)
}

if (fs.existsSync(vendorFile)) {
  if (!force) fail(`${vendorFile} already exists — pass --force to replace it (or --check to verify it).`)
  console.log('[fetch-cloudflared] --force: replacing the existing vendor file')
}

fs.mkdirSync(vendorDir, { recursive: true })
const tempFile = `${vendorFile}.download`

console.log(`[fetch-cloudflared] ${url}`)
const curl = spawn('curl', ['-sSL', '--fail', '--retry', '3', '--max-time', '300', '-o', tempFile, url], {
  stdio: ['ignore', 'inherit', 'inherit'],
})
curl.on('error', (error) => {
  fs.rmSync(tempFile, { force: true })
  fail(`could not run curl: ${error.message}`)
})
curl.on('close', (code) => {
  if (code !== 0) {
    fs.rmSync(tempFile, { force: true })
    fail(`curl exited with code ${code}`)
  }
  const size = fs.statSync(tempFile).size
  // The real binary is ~20 MB; anything under 1 MB is an error page or a stub.
  if (size < 1024 * 1024) {
    fs.rmSync(tempFile, { force: true })
    fail(`download too small (${size} bytes) — treating as failure and removing it`)
  }
  if (unverified) {
    console.warn('[fetch-cloudflared] WARNING: skipping digest verification (--allow-unverified).')
  } else if (!digestMatches(tempFile, asset.sha256)) {
    fs.rmSync(tempFile, { force: true })
    fail('refusing to install a binary the bridge would not accept')
  }
  fs.renameSync(tempFile, vendorFile)
  if (process.platform !== 'win32') fs.chmodSync(vendorFile, 0o755)
  console.log(`[fetch-cloudflared] wrote ${(size / 1024 / 1024).toFixed(1)} MB -> ${vendorFile}`)

  const probe = spawn(vendorFile, ['--version'], { stdio: ['ignore', 'inherit', 'inherit'] })
  probe.on('error', (error) => {
    console.error(`[fetch-cloudflared] binary will not start: ${error.message}`)
    process.exit(1)
  })
  probe.on('close', (probeCode) => {
    if (probeCode !== 0) {
      console.error(`[fetch-cloudflared] --version exited ${probeCode}`)
      process.exit(probeCode ?? 1)
    }
    console.log('[fetch-cloudflared] OK. Note the rank: resolveCloudflared() only reaches')
    console.log('  vendor/ when no override is set — DSH_POCKET_CLOUDFLARED,')
    console.log('  DSH_PHONE_NATIVE_CLOUDFLARED and CLOUDFLARED_BIN all outrank it.')
    process.exit(0)
  })
})
