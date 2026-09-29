/**
 * Fetch the cloudflared binary into ./vendor, deterministically.
 *
 * Why this script exists: the npm `cloudflared` package does not bundle the
 * binary. Its postinstall downloads it from
 * https://github.com/cloudflare/cloudflared/releases/latest/download/
 * cloudflared-windows-amd64.exe into <pkg>/bin/cloudflared.exe. DSH's pnpm
 * blocks postinstall build scripts
 * (`[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: cloudflared@0.7.3`), so
 * that file is usually missing after a host-side install.
 *
 * lib/tunnel.js resolveCloudflared() checks this vendor directory before
 * anything else, so running this script once is enough for the tunnel to work.
 *
 * Usage:
 *   node F:\defws\dsh-phone-native\tools\fetch-cloudflared.mjs
 *
 * Environment overrides:
 *   CLOUDFLARED_VERSION  release tag; defaults to "latest" (same as the npm pkg)
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const vendorDir = path.join(pluginRoot, 'vendor')

const FILES = {
  win32: {
    x64: 'cloudflared-windows-amd64.exe',
    ia32: 'cloudflared-windows-386.exe',
    arm64: 'cloudflared-windows-amd64.exe',
  },
  linux: {
    x64: 'cloudflared-linux-amd64',
    arm64: 'cloudflared-linux-arm64',
    arm: 'cloudflared-linux-arm',
    ia32: 'cloudflared-linux-386',
  },
  darwin: {
    x64: 'cloudflared-darwin-amd64.tgz',
    arm64: 'cloudflared-darwin-arm64.tgz',
  },
}

const version = process.env.CLOUDFLARED_VERSION || 'latest'
const releaseBase = 'https://github.com/cloudflare/cloudflared/releases/'
const fileName = FILES[process.platform]?.[process.arch]

if (fileName === undefined) {
  console.error(`[fetch-cloudflared] unsupported platform ${process.platform}/${process.arch}`)
  process.exit(1)
}

const target = path.join(vendorDir, fileName)
const url = `${releaseBase}${version === 'latest' ? 'latest/download' : `download/${version}`}/${fileName}`

console.log(`[fetch-cloudflared] ${url}`)
console.log(`[fetch-cloudflared] -> ${target}`)

fs.mkdirSync(vendorDir, { recursive: true })

const curl = spawn('curl', ['-sSL', '--fail', '--retry', '3', '-o', target, url], {
  stdio: ['ignore', 'inherit', 'inherit'],
})

curl.on('error', (error) => {
  console.error(`[fetch-cloudflared] failed to run curl: ${error.message}`)
  process.exit(1)
})

curl.on('close', (code) => {
  if (code !== 0) {
    console.error(`[fetch-cloudflared] curl exited with code ${code}`)
    process.exit(code ?? 1)
  }
  const size = fs.statSync(target).size
  // The real binary is ~20 MB; anything under 1 MB is an error page or a stub.
  if (size < 1024 * 1024) {
    fs.rmSync(target, { force: true })
    console.error(`[fetch-cloudflared] download too small (${size} bytes) — treating as failure and removing it`)
    process.exit(1)
  }
  console.log(`[fetch-cloudflared] wrote ${(size / 1024 / 1024).toFixed(1)} MB`)
  // Sanity-check the binary actually runs.
  const probe = spawn(target, ['--version'], { stdio: ['ignore', 'inherit', 'inherit'] })
  probe.on('error', (error) => {
    console.error(`[fetch-cloudflared] binary will not start: ${error.message}`)
    process.exit(1)
  })
  probe.on('close', (probeCode) => {
    console.log(probeCode === 0
      ? '[fetch-cloudflared] OK — lib/tunnel.js will pick this up from vendor/ automatically'
      : `[fetch-cloudflared] --version exited ${probeCode}`)
    process.exit(probeCode ?? 0)
  })
})
