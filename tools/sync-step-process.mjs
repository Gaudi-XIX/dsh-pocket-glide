#!/usr/bin/env node
// Sync the official DSH host label tables into lib/step-process.generated.js.
//
// Why this exists: pocket must not hand-copy host copy. The tables below are the
// single source of truth for step-process wording (zh/en), turn-process headline
// fragments, and the "工作步骤展示" setting labels. When the host bundle changes,
// re-run this script; the diff of the generated file is the receipt.
//
// Usage: node tools/sync-step-process.mjs [path\to\app.asar]
//   default asar: D:\DSH\resources\app.asar
//
// Source of the tables: @deepseek-ai/dsh-client-ui-chat/lib/client.js inside the
// host bundle. NOTE: the mapping function (tool name -> activity category) is NOT
// extracted here on purpose — it is JS logic, not a table; pocket keeps its own
// verbatim port in lib/constants.js (`toolActivityCategory`) and the existing
// tests pin it against host wording. Also note the path some older notes used
// (`dsh-api-session-controller/lib/types/client/conversation-nodes/`) does NOT
// exist in the shipped bundle (verified 2026-10-08); do not "fix" the path back.
//
// asar reading is self-contained (no dependency): header pickle + JSON index +
// byte-range read, the same technique proven by the workspace tool
// tmp/20261008-question-timeout-probe/asar-cat.mjs (used live on 2026-10-08).

import { openSync, readSync, closeSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const DEFAULT_ASAR = 'D:\\DSH\\resources\\app.asar'
const asarPath = process.argv[2] || DEFAULT_ASAR
const OUT = new URL('../lib/step-process.generated.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

const CLIENT_JS = 'dsh/node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js'
const HOST_PKG = 'dsh/package.json'

function readBuf(fd, pos, len) {
  const b = Buffer.allocUnsafe(len)
  let off = 0
  while (off < len) {
    const n = readSync(fd, b, off, len - off, pos + off)
    if (!n) throw new Error('short read')
    off += n
  }
  return b
}

function readFileFromAsar(asar, want) {
  const fd = openSync(asar, 'r')
  try {
    const sizeBuf = readBuf(fd, 0, 16)
    const headerPickleSize = sizeBuf.readUInt32LE(4)
    const jsonSize = sizeBuf.readUInt32LE(12)
    const header = JSON.parse(readBuf(fd, 16, jsonSize).toString('utf8'))
    const contentBase = 8 + headerPickleSize
    const parts = want.split('/').filter(Boolean)
    let found = null
    ;(function walk(node, trail) {
      if (found || !node.files) return
      for (const [name, child] of Object.entries(node.files)) {
        if (found) return
        const next = [...trail, name]
        if (child.files) walk(child, next)
        else if (next.length === parts.length && next.every((s, i) => s === parts[i])) found = child
      }
    })(header, [])
    if (!found) throw new Error(`not found in asar: ${want}`)
    if (found.unpacked) throw new Error(`file lives in app.asar.unpacked: ${want}`)
    return readBuf(fd, contentBase + Number(found.offset), found.size).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

// --- extract "key": "value" pairs for the three namespaces -----------------

const NS = {
  stepProcess: { re: /"(message\.stepProcess\.[A-Za-z0-9.]+)":\s*"((?:[^"\\]|\\.)*)"/g, anchor: 'message.stepProcess.thinking' },
  turnProcess: { re: /"(message\.turnProcess\.[A-Za-z0-9.]+)":\s*"((?:[^"\\]|\\.)*)"/g, anchor: 'message.turnProcess.worked' },
  transcript: { re: /"(settings\.transcript\.[A-Za-z.]+)":\s*"((?:[^"\\]|\\.)*)"/g, anchor: 'settings.transcript.title' },
}

function extractAll(text, re) {
  const out = []
  for (const m of text.matchAll(re)) {
    out.push({ key: m[1], value: JSON.parse(`"${m[2]}"`) })
  }
  return out
}

/** Split one namespace's flat match list into the zh table and the en table.
 * The bundle carries two locale blocks; the anchor key appears exactly twice,
 * zh block first. Verify by script locale instead of trusting order blindly. */
function splitLocales(pairs, anchor) {
  const anchorIdx = []
  pairs.forEach((p, i) => { if (p.key === anchor) anchorIdx.push(i) })
  if (anchorIdx.length !== 2) {
    throw new Error(`anchor ${anchor} expected exactly 2 occurrences (zh+en), got ${anchorIdx.length}`)
  }
  const cut = anchorIdx[1]
  const first = pairs.slice(0, cut).filter((p) => p.key === anchor || !pairs.slice(0, cut).some((q, j) => j < pairs.indexOf(p) && q.key === p.key))
  // de-dup within each half, keeping first occurrence
  const dedup = (list) => {
    const seen = new Map()
    for (const p of list) if (!seen.has(p.key)) seen.set(p.key, p.value)
    return seen
  }
  const zh = dedup(pairs.slice(0, cut))
  const en = dedup(pairs.slice(cut))
  return { zh, en }
}

const hasHan = (s) => /[\u4e00-\u9fff]/.test(s)

// --- run -------------------------------------------------------------------

const clientJs = readFileFromAsar(asarPath, CLIENT_JS)
const hostPkg = JSON.parse(readFileFromAsar(asarPath, HOST_PKG))

const tables = {}
for (const [name, { re, anchor }] of Object.entries(NS)) {
  const pairs = extractAll(clientJs, re)
  if (!pairs.length) throw new Error(`namespace ${name}: no matches — host bundle layout changed?`)
  const { zh, en } = splitLocales(pairs, anchor)
  // locale sanity: the zh table must contain Han text, the en table must not
  const zhHasHan = [...zh.values()].some(hasHan)
  const enHasHan = [...en.values()].some(hasHan)
  if (!zhHasHan) throw new Error(`${name}: first block has no Han text — locale order assumption broken, inspect manually`)
  if (enHasHan) throw new Error(`${name}: second block still contains Han text — locale order assumption broken, inspect manually`)
  tables[name] = { zh: Object.fromEntries(zh), en: Object.fromEntries(en) }
}

// key-set parity across locales, per namespace
for (const [name, { zh, en }] of Object.entries(tables)) {
  const zk = Object.keys(zh).sort().join('\n')
  const ek = Object.keys(en).sort().join('\n')
  if (zk !== ek) throw new Error(`${name}: zh/en key sets differ\n--- zh only:\n${zk.split('\n').filter((k) => !(k in en)).join('\n')}`)
}

// --- emit ------------------------------------------------------------------

const stamp = new Date().toISOString()
const clientHash = createHash('sha256').update(clientJs).digest('hex').slice(0, 12)
const banner = `// GENERATED FILE — DO NOT EDIT BY HAND.
// Regenerate with:  node tools/sync-step-process.mjs [path\\to\\app.asar]
// Source: ${asarPath}  (dsh ${hostPkg.version}, client.js sha256:${clientHash})
// Extracted at: ${stamp}
// Namespaces (verbatim, zh then en): message.stepProcess.* / message.turnProcess.* / settings.transcript.*
// The tool-name -> category mapping is intentionally NOT generated; it stays a
// verbatim port in lib/constants.js with its own host-wording tests.
`

const emit = (name) => `export const ${name} = ${JSON.stringify(tables[name === 'TRANSCRIPT_LABELS' ? 'transcript' : name === 'TURN_PROCESS_LABELS' ? 'turnProcess' : 'stepProcess'], null, 2)}\n`

const body = [
  banner,
  emit('STEP_PROCESS_LABELS'),
  emit('TURN_PROCESS_LABELS'),
  emit('TRANSCRIPT_LABELS'),
  `export const GENERATED_FROM = ${JSON.stringify({ asar: asarPath, dshVersion: hostPkg.version, clientHash, extractedAt: stamp }, null, 2)}\n`,
].join('\n')

writeFileSync(OUT, body, 'utf8')

const count = (t) => `${Object.keys(t.zh).length}+${Object.keys(t.en).length}`
console.log(`wrote ${OUT}`)
console.log(`stepProcess ${count(tables.stepProcess)} | turnProcess ${count(tables.turnProcess)} | transcript ${count(tables.transcript)} (zh+en keys)`)
console.log(`dsh ${hostPkg.version}  client.js sha256:${clientHash}`)
