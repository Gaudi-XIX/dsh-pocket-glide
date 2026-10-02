/**
 * Register @defws/dsh-pocket in a DSH profile (default: `desktop`).
 *
 * What it edits — exactly two places in `<DSH_HOME>/profiles/<profile>/package.json`:
 *   1. `dependencies["@defws/dsh-pocket"] = "link:F:/defws/dsh-pocket"`
 *   2. `dsh.profile.bundles` — append the same package name if absent
 * It backs the file up first, and it never touches anything else in the profile.
 *
 * `pnpm install` is NOT run by default. Editing the registration without
 * resolving it is the half-modified-profile state this script is here to avoid,
 * so the install step is an explicit opt-in (`--install`) after the preflight
 * below has passed.
 *
 * Preflight (refuses to write anything if it fails):
 *   - the link source must exist and look like this plugin. A stale
 *     source path is the whole hazard: writing an unresolvable `link:` into the
 *     live profile makes `pnpm install` fail with the registration already in
 *     place. This used to be possible here — the script shipped pointing at
 *     `F:/defws/dsh-phone-native`, a directory that no longer exists.
 *   - the profile package.json must parse as JSON.
 *
 * Usage:
 *   node tools/install-to-profile.mjs --dry-run          # show the result only
 *   node tools/install-to-profile.mjs                    # write registration
 *   node tools/install-to-profile.mjs --install          # write, then pnpm install
 *   node tools/install-to-profile.mjs --profile desktop-safe-mode
 *
 * Environment:
 *   DSH_HOME   data root; defaults to ~/.dsh (this machine: C:\\Users\\toast\\.dsh)
 *
 * Rollback: copy the printed `.bak-before-pocket-*` file back over
 * `package.json`, then `pnpm install` in the profile (or drop the two entries
 * by hand).
 *
 * Idempotent: an existing matching entry is reported, never duplicated.
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const PACKAGE_NAME = '@defws/dsh-pocket'
/** Must match `package.json name`; the link target is this repo's source tree. */
const LINK_PATH = 'link:F:/defws/dsh-pocket'
/** Files that make a directory a loadable copy of this plugin. */
const REQUIRED_SOURCE_FILES = ['package.json', 'lib/index.js', 'client/client.js', 'cordis.patch.yml']

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const withInstall = argv.includes('--install')
const profileIndex = argv.indexOf('--profile')
const profileName = profileIndex >= 0 && argv[profileIndex + 1] ? argv[profileIndex + 1] : 'desktop'
if (argv.includes('--no-backup')) {
  console.error('ERROR: --no-backup is not supported; the backup is the rollback.')
  process.exit(1)
}

const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
const sourceRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const PROFILE_PKG = join(dshHome, 'profiles', profileName, 'package.json')

function preflight() {
  const problems = []
  const missing = REQUIRED_SOURCE_FILES.filter((rel) => !existsSync(join(sourceRoot, rel)))
  if (missing.length > 0) {
    problems.push(
      `the link source tree at ${sourceRoot} is not this plugin (missing: ${missing.join(', ')}).\n` +
        '  Refusing to write a `link:` dependency the profile cannot resolve.',
    )
  }
  const sourceLink = `link:${sourceRoot.replace(/\\/g, '/')}`
  if (sourceLink !== LINK_PATH) {
    problems.push(
      `this script lives in ${sourceRoot}, but it would write ${LINK_PATH}; the two must be ` +
        'the same tree (the link path is Windows-style, so this check is expected to trip on ' +
        'a non-Windows copy of the repo).',
    )
  }
  if (!existsSync(PROFILE_PKG)) {
    problems.push(`profile package.json not found at ${PROFILE_PKG} (profile = ${profileName}).`)
  }
  return problems
}

function runPnpm(cwd) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
      ['install', '--prefer-offline'],
      { cwd, windowsHide: true, stdio: 'inherit' },
    )
    child.on('error', rejectPromise)
    child.on('close', (code) => {
      if (code === 0) resolvePromise()
      else rejectPromise(new Error(`pnpm install exited with code ${code}`))
    })
  })
}

function nextStepNotice() {
  console.log('\nNEXT STEPS')
  console.log('  1. restart DeepSeek Harness — the host loads bundles at start-up,')
  console.log('     and a source edit under a junction is not hot-mounted.')
  console.log(`  2. after the restart, the desktop pairing surface is ${PACKAGE_NAME}'s`)
  console.log('     `/desktop` route: the sidebar button "连接手机" opens it in an in-app')
  console.log('     iframe (same origin as the host GUI), and the same path is')
  console.log('     reachable directly on the host web server. The phone page is served')
  console.log('     by the bridge itself — its port comes from the start-up snapshot, not')
  console.log('     from a URL written into this script.')
  console.log('  3. the host log line to look for is "Pocket bridge ready on 0.0.0.0:<port>".')
}

function main() {
  const problems = preflight()
  if (problems.length > 0) {
    console.error(`ERROR: preflight failed for profile "${profileName}":`)
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exit(1)
  }

  const raw = readFileSync(PROFILE_PKG, 'utf8')
  let pkg
  try {
    pkg = JSON.parse(raw)
  } catch (error) {
    console.error(`ERROR: ${PROFILE_PKG} is not valid JSON: ${error?.message ?? error}`)
    console.error('Nothing was written.')
    process.exit(1)
  }

  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const backupPath = `${PROFILE_PKG}.bak-before-pocket-${stamp}`

  let changed = false

  // 1. dependency (the junction the host resolves the bundle from)
  if (!pkg.dependencies) pkg.dependencies = {}
  if (pkg.dependencies[PACKAGE_NAME] === LINK_PATH) {
    console.log(`dependencies: ${PACKAGE_NAME} already present`)
  } else if (pkg.dependencies[PACKAGE_NAME] !== undefined) {
    console.error(`ERROR: dependencies.${PACKAGE_NAME} is already "${pkg.dependencies[PACKAGE_NAME]}"`)
    console.error('  Refusing to rewrite an existing entry by surprise — fix it by hand.')
    process.exit(1)
  } else {
    pkg.dependencies[PACKAGE_NAME] = LINK_PATH
    console.log(`dependencies: would add ${PACKAGE_NAME} = ${LINK_PATH}`)
    changed = true
  }

  // 2. bundle registration (without this the host never loads the package)
  pkg.dsh ??= {}
  pkg.dsh.profile ??= {}
  if (!Array.isArray(pkg.dsh.profile.bundles)) pkg.dsh.profile.bundles = []
  if (pkg.dsh.profile.bundles.includes(PACKAGE_NAME)) {
    console.log(`bundles: ${PACKAGE_NAME} already listed`)
  } else {
    pkg.dsh.profile.bundles.push(PACKAGE_NAME)
    console.log(`bundles: would add ${PACKAGE_NAME}`)
    changed = true
  }

  if (!changed) {
    console.log('no changes needed — already installed')
    console.log(`(profile ${PROFILE_PKG})`)
    nextStepNotice()
    return
  }

  const out = `${JSON.stringify(pkg, null, 2)}\n`
  if (dryRun) {
    console.log('\n--- dry-run: would write ---')
    console.log(out.slice(0, 2000))
    console.log(`--- would back up ${PROFILE_PKG} to ${backupPath} ---`)
    return
  }

  copyFileSync(PROFILE_PKG, backupPath)
  console.log(`backup: ${backupPath}`)
  writeFileSync(PROFILE_PKG, out, 'utf8')
  console.log(`wrote: ${PROFILE_PKG}`)

  // Re-read and confirm: a half-written registration is the failure this guards.
  const written = JSON.parse(readFileSync(PROFILE_PKG, 'utf8'))
  const confirmed =
    written.dependencies?.[PACKAGE_NAME] === LINK_PATH &&
    (written.dsh?.profile?.bundles ?? []).includes(PACKAGE_NAME)
  if (!confirmed) {
    console.error(`ERROR: post-write check failed; restore ${backupPath} and investigate.`)
    process.exit(1)
  }
  console.log('post-write check: dependency + bundle both present')

  if (!withInstall) {
    console.log('\nRegistration written. `pnpm install` NOT run (pass --install to run it).')
    console.log(`Until it succeeds the junction is missing: pnpm -C ${join(dshHome, 'profiles', profileName)} install --prefer-offline`)
    nextStepNotice()
    return
  }

  console.log('\n--- running pnpm install ---')
  runPnpm(join(dshHome, 'profiles', profileName))
    .then(() => nextStepNotice())
    .catch((error) => {
      console.error(error?.message ?? String(error))
      console.error(`Restore with: copy "${backupPath}" over "${PROFILE_PKG}" and re-run pnpm install.`)
      process.exit(1)
    })
}

main()
