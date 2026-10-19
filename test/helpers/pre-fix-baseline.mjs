// Pre-fix baselines for the red-first tests.
//
// Those tests assert against the page source as it stood *before* a fix landed, so
// they pin an immutable commit instead of HEAD: pinning HEAD would rot with every
// commit (the fix lives in HEAD), and HEAD~1 would drift with each new one.
//
// Those commits exist only in the development repository. The published tree was
// squashed into a fresh root with no shared ancestor, so `f8e1669` — and the six
// bug fixes it pins — simply are not in this history.
//
// Reading a missing baseline is not the same as a baseline that holds, so this
// returns null and the caller skips with its reason attached. It never falls back
// to the current file (that would be a green test proving nothing) and never
// reports a pass on a baseline it could not read.
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// test/helpers/ -> repository root
const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

/**
 * @param {string} ref  commit that predates the fix, e.g. 'f8e1669'
 * @param {string} file path inside that commit, e.g. 'lib/pages.js'
 * @returns {string|null} the file at that commit, or null when it cannot be read
 *   (git absent, or the commit is not in this history)
 */
export function preFixBaseline(ref, file) {
  try {
    return execFileSync('git', ['show', `${ref}:${file}`], {
      cwd: repoRoot,
      maxBuffer: 1e8,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString()
  } catch {
    return null
  }
}
