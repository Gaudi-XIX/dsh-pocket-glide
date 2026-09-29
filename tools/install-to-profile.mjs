/**
 * Install @defws/dsh-phone-native into the desktop profile.
 *
 * Edits C:\Users\toast\.dsh\profiles\desktop\package.json in two places
 * (dependencies + dsh.profile.bundles), backs up the original, then runs
 * pnpm install. After that the user must restart DeepSeek Harness for the
 * bundle to load.
 *
 * Usage:  node tools/install-to-profile.mjs
 * Dry-run: node tools/install-to-profile.mjs --dry-run
 *
 * This script is idempotent: it will not add a duplicate entry if one
 * already exists.
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFile } from 'node:child_process'

const PROFILE_PKG = 'C:\\Users\\toast\\.dsh\\profiles\\desktop\\package.json'
const PLUGIN_NAME = '@defws/dsh-phone-native'
const LINK_PATH = 'link:F:/defws/dsh-phone-native'

const dryRun = process.argv.includes('--dry-run')

async function runPnpm(cwd) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
      ['install', '--prefer-offline'],
      { cwd, windowsHide: true, timeout: 120000 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`pnpm install failed: ${error.message}\n${stderr}`))
        else resolve({ stdout, stderr })
      },
    )
    child.stdout?.pipe(process.stdout)
    child.stderr?.pipe(process.stderr)
  })
}

function main() {
  if (!existsSync(PROFILE_PKG)) {
    console.error(`ERROR: profile package.json not found at ${PROFILE_PKG}`)
    process.exit(1)
  }

  const raw = readFileSync(PROFILE_PKG, 'utf8')
  const pkg = JSON.parse(raw)

  // Backup
  if (!dryRun) {
    const bak = PROFILE_PKG + '.bak-before-phone-native'
    copyFileSync(PROFILE_PKG, bak)
    console.log(`backup: ${bak}`)
  }

  let changed = false

  // 1. Add to dependencies
  if (!pkg.dependencies) pkg.dependencies = {}
  if (pkg.dependencies[PLUGIN_NAME] === LINK_PATH) {
    console.log(`dependencies: ${PLUGIN_NAME} already present`)
  } else {
    pkg.dependencies[PLUGIN_NAME] = LINK_PATH
    console.log(`dependencies: added ${PLUGIN_NAME} = ${LINK_PATH}`)
    changed = true
  }

  // 2. Add to dsh.profile.bundles
  if (!pkg.dsh) pkg.dsh = {}
  if (!pkg.dsh.profile) pkg.dsh.profile = {}
  if (!Array.isArray(pkg.dsh.profile.bundles)) pkg.dsh.profile.bundles = []
  if (pkg.dsh.profile.bundles.includes(PLUGIN_NAME)) {
    console.log(`bundles: ${PLUGIN_NAME} already listed`)
  } else {
    pkg.dsh.profile.bundles.push(PLUGIN_NAME)
    console.log(`bundles: added ${PLUGIN_NAME}`)
    changed = true
  }

  if (!changed) {
    console.log('no changes needed — already installed')
    return
  }

  const out = JSON.stringify(pkg, null, 2) + '\n'
  if (dryRun) {
    console.log('\n--- dry-run: would write ---')
    console.log(out.slice(0, 2000))
    return
  }

  writeFileSync(PROFILE_PKG, out, 'utf8')
  console.log(`wrote: ${PROFILE_PKG}`)

  console.log('\n--- running pnpm install ---')
  runPnpm('C:\\Users\\toast\\.dsh\\profiles\\desktop')
    .then(() => {
      console.log('\npnpm install done.')
      console.log('\nNEXT STEP: restart DeepSeek Harness for the bundle to load.')
      console.log('After restart, the phone page will be at http://127.0.0.1:19387/phone')
      console.log('Start the tunnel: POST /phone/tunnel/start (from the pair page or curl)')
    })
    .catch((err) => {
      console.error(err.message)
      process.exit(1)
    })
}

main()
