// WP-BRIDGE-EXTRA S5 — the quick-tunnel output parser retires when the URL is in hand.
//
// `startCloudflareQuickTunnel` resolves as soon as a `*.trycloudflare.com` URL comes
// out of the child's pipes, but it used to leave the parser attached for the life of
// the process. Every chunk after that — for as long as the tunnel runs, which is the
// whole session — paid a 16 KB `slice`, an ANSI strip and a regex scan of the retained
// tail to extract a value that cannot change any more. The buffer itself is capped, so
// this is burned CPU and garbage rather than a leak (the audit's own wording).
//
// Detaching is not enough on its own: a pipe nobody reads stops draining, and
// cloudflared logs continuously, so dropping the work without keeping the drain would
// trade a hot loop for a stalled tunnel. Both halves are pinned here, and the test
// injects a spawner instead of starting anything that could reach the network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { startCloudflareQuickTunnel } from '../lib/tunnel.js'

const ONLINE_MARK = 'Tunnel online'

/**
 * The machine's own Pocket data roots, snapshotted at module load. Nothing in this
 * file may create or modify either one: the resolver is stubbed out (`ensureImpl`),
 * so a test that finds a change here has started talking to the real cache chain.
 * Recorded, not asserted-to-exist — the honest outcome is "unchanged", including when
 * it does not exist at all.
 */
function machineDataRoots() {
  const roots = [
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'dsh-pocket')
      : undefined,
    process.env.DSH_HOME
      ? path.join(process.env.DSH_HOME, 'pocket')
      : path.join(os.homedir(), '.dsh', 'pocket'),
  ].filter((entry) => typeof entry === 'string')
  const snapshot = new Map()
  for (const root of roots) {
    try {
      const stat = fs.statSync(root)
      snapshot.set(root, `dir:${stat.mtimeMs}`)
    } catch {
      snapshot.set(root, 'absent')
    }
  }
  return snapshot
}

const DATA_ROOTS_BEFORE = machineDataRoots()

function fakeCloudflared() {
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

/** A file on disk, so a caller-supplied path resolves without a PATH probe. */
function fakeBinary() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pocket-s5-'))
  const file = path.join(dir, 'cloudflared.exe')
  fs.writeFileSync(file, 'never executed — this file only exists to be resolved')
  return file
}

/** Never call the real resolver: it is the door to the machine's cache directory. */
const stubEnsure = async () => 'stubbed-cloudflared'

/** Read the opening frame of a stream result without waiting for the child to exit. */
function drain(child, count = 200) {
  for (let index = 0; index < count; index += 1) {
    child.stderr.push(Buffer.from(`registering connection ${index} https://bbb-22.trycloudflare.com\n`, 'utf8'))
    child.stdout.push(Buffer.from(`TRACE ${index} a line that would need parsing\n`, 'utf8'))
  }
}

test('S5: after the URL is learned no parser is attached to either pipe', async () => {
  const child = fakeCloudflared()
  const logs = []
  const spawned = []
  const pending = startCloudflareQuickTunnel({
    port: 43127,
    binaryPath: fakeBinary(),
    ensureImpl: stubEnsure,
    log: (message) => logs.push(message),
    spawnImpl: (bin, args) => {
      spawned.push({ bin, args })
      return child
    },
  })
  child.stderr.push(Buffer.from('compiling https://aaa-11.trycloudflare.com for 127.0.0.1:43127\n', 'utf8'))
  const instance = await pending

  assert.equal(instance.url, 'https://aaa-11.trycloudflare.com')
  assert.equal(spawned.length, 1, 'the injected spawner was used — nothing was really launched')
  assert.equal(spawned[0].bin, 'stubbed-cloudflared', 'the resolver was stubbed, so the machine cache chain was never consulted')
  assert.deepEqual(spawned[0].args, ['tunnel', '--url', 'http://127.0.0.1:43127'])

  // The work is gone.
  assert.equal(child.stdout.listenerCount('data'), 0, 'stdout must not keep the output parser attached')
  assert.equal(child.stderr.listenerCount('data'), 0, 'stderr must not keep the output parser attached')
  // The pipes stay alive and keep draining.
  assert.equal(child.stdout.destroyed, false, 'detaching is not destroying — the carrier keeps its logs')
  assert.equal(child.stderr.destroyed, false, 'detaching is not destroying — the carrier keeps its logs')
  drain(child)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(child.stderr.readableLength, 0, 'chunks pushed after resolve are drained, not buffered')
  assert.equal(child.stdout.readableLength, 0, 'chunks pushed after resolve are drained, not buffered')

  // And nothing about the resolved tunnel changes under later output.
  assert.equal(instance.url, 'https://aaa-11.trycloudflare.com', 'a later URL cannot replace the one already handed out')
  assert.equal(logs.filter((line) => line.includes(ONLINE_MARK)).length, 1, 'the online line is written once, not once per chunk')
  assert.equal(child.killed.length, 0, 'resolving does not kill the carrier')

  await instance.stop()
  assert.deepEqual(child.killed, ['SIGTERM'], 'stop still terminates the child')
})

test('S5: the parser is detached on every way out, including the ones that never saw a URL', async () => {
  const timeoutChild = fakeCloudflared()
  await assert.rejects(
    startCloudflareQuickTunnel({
      port: 43127,
      binaryPath: fakeBinary(),
      ensureImpl: stubEnsure,
      timeoutMs: 30,
      spawnImpl: () => timeoutChild,
    }),
    /timed out after/,
  )
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(timeoutChild.stdout.listenerCount('data'), 0, 'a timed-out launch leaves no parser behind either')
  assert.equal(timeoutChild.stderr.listenerCount('data'), 0, 'a timed-out launch leaves no parser behind either')

  const earlyExitChild = fakeCloudflared()
  const rejected = startCloudflareQuickTunnel({
    port: 43127,
    binaryPath: fakeBinary(),
    ensureImpl: stubEnsure,
    spawnImpl: () => earlyExitChild,
  })
  // A real child cannot report its own exit before it exists, and the binary
  // resolution is awaited before the pipes are wired: let that turn pass first.
  await new Promise((resolve) => setImmediate(resolve))
  earlyExitChild.emit('close', 1, null)
  await assert.rejects(rejected, /exited unexpectedly/)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(earlyExitChild.stdout.listenerCount('data'), 0, 'a child that died is not still parsed')
  assert.equal(earlyExitChild.stderr.listenerCount('data'), 0, 'a child that died is not still parsed')
})

test('S5: a URL split across chunks is still found before the detach happens', async () => {
  // Guard against detaching too eagerly: cloudflared prints its banner and its
  // hostname line in pieces, and the parser has to stay attached until a URL has
  // actually been extracted — not until the first chunk has arrived.
  const child = fakeCloudflared()
  const pending = startCloudflareQuickTunnel({
    port: 43127,
    binaryPath: fakeBinary(),
    ensureImpl: stubEnsure,
    spawnImpl: () => child,
  })
  await new Promise((resolve) => setImmediate(resolve))
  child.stdout.push(Buffer.from('no url on this pipe yet\n', 'utf8'))
  await new Promise((resolve) => setImmediate(resolve))
  child.stderr.push(Buffer.from('still htt', 'utf8'))
  assert.equal(child.stderr.listenerCount('data'), 1, 'the first fragment does not detach anything')
  child.stderr.push(Buffer.from('ps://ccc-33.trycloudflare.com\n', 'utf8'))
  const instance = await pending
  assert.equal(instance.url, 'https://ccc-33.trycloudflare.com', 'a URL split across chunks is still found')
  assert.equal(child.stderr.listenerCount('data'), 0)
  assert.equal(child.stdout.listenerCount('data'), 0)
  await instance.stop()
})

test('S5: this file never touched the machine cache chain', () => {
  // The audit item is about a long-running child process; nothing here needs the
  // real resolver, and nothing here may create or move anything under the user's
  // data roots. Recorded before any test ran, compared after all of them.
  for (const [root, before] of DATA_ROOTS_BEFORE) {
    const now = (() => {
      try {
        return `dir:${fs.statSync(root).mtimeMs}`
      } catch {
        return 'absent'
      }
    })()
    assert.equal(now, before, `the machine data root ${root} changed shape`)
  }
})
