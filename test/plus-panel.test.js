// Coverage for the mobile 「+」 panel transport (Tasks 1–3):
//  - new methods pass the mobile allowlist and reach the Host with the exact
//    translated args (agentId / line / submittedAttachments, request envelope)
//  - per-method body tier (64KB normal vs 25MB×1.4 large)
//  - Host error text passes through verbatim
//  - GET /api/session-attachment decodes Host base64 bytes
//  - GET/HEAD /api/session-export streams the Host ZIP with fixed query only
// FULL-STACK: real HTTP through the real bridge into the fake Harness.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startBridge, httpFetch } from './helpers.js'
import { LARGE_BODY_BYTES } from '../lib/constants.js'

async function readBinary(res) {
  const chunks = []
  // node:http web stream (no encoding re-interpretation).
  for await (const chunk of res.body) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

function rpcCall(t, cookie, method, payload = {}) {
  return httpFetch(`${t.base}/api/rpc`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ method, payload }),
  })
}

test('command.execute / file.upload / permissionPresets.catalog pass the allowlist', async () => {
  const t = await startBridge({ harness: 'fake' })
  try {
    const cookie = await t.pairMobile()
    for (const method of ['command.execute', 'file.upload', 'permissionPresets.catalog']) {
      const res = await rpcCall(t, cookie, method, { sessionId: 's1' })
      assert.notEqual(res.status, 403, `${method} must be allowlisted`)
      assert.equal(res.status, 200)
    }
  } finally {
    await t.stop()
  }
})

test('command.execute forwards agentId, line and submittedAttachments in args', async () => {
  const t = await startBridge({ harness: 'fake' })
  try {
    const cookie = await t.pairMobile()
    const submittedAttachments = [{ type: 'image', mediaType: 'image/png', data: 'AAAA' }]
    const res = await rpcCall(t, cookie, 'command.execute', {
      sessionId: 'sess-9',
      line: '/goal ship',
      submittedAttachments,
    })
    assert.equal(res.status, 200)
    const call = t.harness.records.calls.find((c) => c.url === '/api/commands/execute')
    assert.ok(call, 'bridge must POST /api/commands/execute')
    assert.deepEqual(call.args, {
      agentId: 'sess-9',
      line: '/goal ship',
      submittedAttachments,
    })
    // Plain invocation still carries an empty submittedAttachments数组（宿主
    // 无条件读 .length，缺失会抛错）。
    await rpcCall(t, cookie, 'command.execute', { sessionId: 'sess-9', line: '/compact' })
    const plain = t.harness.records.calls
      .filter((c) => c.url === '/api/commands/execute')
      .at(-1)
    assert.deepEqual(plain.args, {
      agentId: 'sess-9',
      line: '/compact',
      submittedAttachments: [],
    })
  } finally {
    await t.stop()
  }
})

test('file.upload forwards agentId and request{data,name}; catalog takes no args', async () => {
  const t = await startBridge({ harness: 'fake' })
  try {
    const cookie = await t.pairMobile()
    let res = await rpcCall(t, cookie, 'file.upload', {
      sessionId: 'sess-9',
      data: 'BASE64DATA',
      name: 'note.txt',
    })
    assert.equal(res.status, 200)
    const upload = t.harness.records.calls.find((c) => c.url === '/api/fileUploads/upload')
    assert.deepEqual(upload.args, {
      agentId: 'sess-9',
      request: { data: 'BASE64DATA', name: 'note.txt' },
    })
    // Name omitted when absent.
    res = await rpcCall(t, cookie, 'file.upload', { sessionId: 'sess-9', data: 'QQ==' })
    assert.equal(res.status, 200)
    const noName = t.harness.records.calls
      .filter((c) => c.url === '/api/fileUploads/upload')
      .at(-1)
    assert.deepEqual(noName.args, { agentId: 'sess-9', request: { data: 'QQ==' } })

    res = await rpcCall(t, cookie, 'permissionPresets.catalog', {})
    assert.equal(res.status, 200)
    const catalog = t.harness.records.calls.find((c) => c.url === '/api/permissionPresets/catalog')
    assert.deepEqual(catalog.args, {})
  } finally {
    await t.stop()
  }
})

test('file.upload uses the large body tier (over 64KB accepted, over ceiling rejected)', async () => {
  const t = await startBridge({ harness: 'fake' })
  try {
    const cookie = await t.pairMobile()
    // 100KB base64: beyond the normal 64KB tier but inside the large tier.
    const res = await rpcCall(t, cookie, 'file.upload', {
      sessionId: 's1',
      data: 'Q'.repeat(100 * 1024),
    })
    assert.equal(res.status, 200, 'large-tier payload must not be rejected at 64KB')

    // Just over the large ceiling.
    const oversized = JSON.stringify({
      method: 'file.upload',
      payload: { sessionId: 's1', data: 'Q'.repeat(LARGE_BODY_BYTES) },
    })
    assert.ok(Buffer.byteLength(oversized, 'utf8') > LARGE_BODY_BYTES)
    const blocked = await httpFetch(`${t.base}/api/rpc`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: oversized,
    })
    assert.equal(blocked.status, 413)
    assert.equal((await blocked.json()).error, 'Request body is too large.')
  } finally {
    await t.stop()
  }
})

test('Host command error message passes through to the mobile client', async () => {
  const t = await startBridge({
    harness: 'fake',
    harnessOptions: {
      respond: (pathname) => {
        if (pathname === '/api/commands/execute') {
          return { ok: false, error: { name: 'Error', message: 'Unknown command: /bogus' } }
        }
        return undefined
      },
    },
  })
  try {
    const cookie = await t.pairMobile()
    const res = await rpcCall(t, cookie, 'command.execute', { sessionId: 's1', line: '/bogus' })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.equal(body.ok, false)
    assert.equal(body.error, 'Unknown command: /bogus')
  } finally {
    await t.stop()
  }
})

test('GET /api/session-attachment decodes Host base64 bytes with the Host media type', async () => {
  const raw = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0xff, 0x00])
  const t = await startBridge({
    harness: 'fake',
    harnessOptions: {
      respond: (pathname, args) => {
        if (pathname === '/api/session/attachment') {
          assert.deepEqual(args, { request: { sessionId: 's1', attachmentId: 'a1' } })
          return {
            ok: true,
            value: { attachment: { attachmentId: 'a1', mediaType: 'image/png' }, data: raw.toString('base64') },
          }
        }
        return undefined
      },
    },
  })
  try {
    const cookie = await t.pairMobile()
    const res = await httpFetch(
      `${t.base}/api/session-attachment?sessionId=s1&attachmentId=a1`,
      { headers: { cookie } }
    )
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'image/png')
    assert.equal(res.headers.get('cache-control'), 'private, no-store')
    assert.equal(res.headers.get('content-length'), String(raw.length))
    const bytes = await readBinary(res)
    assert.deepEqual(bytes, raw)

    const missing = await httpFetch(`${t.base}/api/session-attachment?sessionId=s1`, {
      headers: { cookie },
    })
    assert.equal(missing.status, 400)
  } finally {
    await t.stop()
  }
})

test('GET /api/session-attachment downloads a non-image file with its real name', async () => {
  const raw = Buffer.from('fake pdf bytes')
  const t = await startBridge({
    harness: 'fake',
    harnessOptions: {
      respond: (pathname) =>
        pathname === '/api/session/attachment'
          ? {
              ok: true,
              value: { attachment: { attachmentId: 'f1', mediaType: 'application/pdf', name: 'report.pdf' }, data: raw.toString('base64') },
            }
          : undefined,
    },
  })
  try {
    const cookie = await t.pairMobile()
    const res = await httpFetch(
      `${t.base}/api/session-attachment?sessionId=s1&attachmentId=f1`,
      { headers: { cookie } }
    )
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'application/octet-stream')
    assert.equal(
      res.headers.get('content-disposition'),
      'attachment; filename="report.pdf"'
    )
    const bytes = await readBinary(res)
    assert.deepEqual(bytes, raw)
  } finally {
    await t.stop()
  }
})

test('session-attachment filename falls back and is stripped of header-breaking characters', async () => {
  const cases = [
    { name: undefined, expected: 'attachment' },
    { name: '', expected: 'attachment' },
    { name: 'my"file.pdf', expected: 'myfile.pdf' },
    { name: 'line\nbreak.pdf', expected: 'linebreak.pdf' },
  ]
  for (const { name, expected } of cases) {
    const t = await startBridge({
      harness: 'fake',
      harnessOptions: {
        respond: (pathname) =>
          pathname === '/api/session/attachment'
            ? {
                ok: true,
                value: { attachment: { attachmentId: 'f1', mediaType: 'application/pdf', name }, data: Buffer.from('x').toString('base64') },
              }
            : undefined,
      },
    })
    try {
      const cookie = await pairMobileUnchecked(t)
      const res = await httpFetch(
        `${t.base}/api/session-attachment?sessionId=s1&attachmentId=f1`,
        { headers: { cookie } }
      )
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('content-disposition'), `attachment; filename="${expected}"`)
    } finally {
      await t.stop()
    }
  }
})

test('missing attachment is answered with 404', async () => {
  const t = await startBridge({
    harness: 'fake',
    harnessOptions: {
      respond: (pathname) =>
        pathname === '/api/session/attachment'
          ? { ok: false, error: { name: 'Error', message: 'not found' } }
          : undefined,
    },
  })
  try {
    const cookie = await pairMobileUnchecked(t)
    const res = await httpFetch(
      `${t.base}/api/session-attachment?sessionId=s1&attachmentId=gone`,
      { headers: { cookie } }
    )
    assert.equal(res.status, 404)
    assert.equal(await res.text(), 'Attachment is not available.')
  } finally {
    await t.stop()
  }
})

test('Host not-found-class attachment codes (session/*) are answered with 404', async () => {
  const codes = ['session/not-found', 'session/attachment-invalid']
  for (const code of codes) {
    const t = await startBridge({
      harness: 'fake',
      harnessOptions: {
        respond: (pathname) =>
          pathname === '/api/session/attachment'
            ? { ok: false, error: { code, message: code } }
            : undefined,
      },
    })
    try {
      const cookie = await pairMobileUnchecked(t)
      const res = await httpFetch(
        `${t.base}/api/session-attachment?sessionId=s1&attachmentId=a`,
        { headers: { cookie } }
      )
      assert.equal(res.status, 404, `code ${code} must map to 404`)
      assert.equal(await res.text(), 'Attachment is not available.')
    } finally {
      await t.stop()
    }
  }
})

test('Host service-class attachment codes are answered with 502', async () => {
  const t = await startBridge({
    harness: 'fake',
    harnessOptions: {
      respond: (pathname) =>
        pathname === '/api/session/attachment'
          ? { ok: false, error: { code: 'gateway/internal', message: 'boom' } }
          : undefined,
    },
  })
  try {
    const cookie = await pairMobileUnchecked(t)
    const res = await httpFetch(
      `${t.base}/api/session-attachment?sessionId=s1&attachmentId=a`,
      { headers: { cookie } }
    )
    assert.equal(res.status, 502)
    assert.equal(await res.text(), 'Attachment is not available right now.')
  } finally {
    await t.stop()
  }
})

test('transport-level attachment failure (no Host envelope) is answered with 502', async () => {
  // Point the bridge at a discard port (nothing listening): harnessFetch's
  // fetch rejects before any envelope exists.
  const t = await startBridge({
    harness: 'fake',
    bridgeOptions: { harnessUrl: () => 'http://127.0.0.1:9' },
  })
  try {
    const cookie = await pairMobileUnchecked(t)
    const res = await httpFetch(
      `${t.base}/api/session-attachment?sessionId=s1&attachmentId=a`,
      { headers: { cookie } }
    )
    assert.equal(res.status, 502)
    assert.equal(await res.text(), 'Attachment is not available right now.')
  } finally {
    await t.stop()
  }
})

test('session-export upstream error before response headers is answered with 502', async () => {
  const t = await startBridge({
    harness: 'fake',
    harnessOptions: {
      get: (req, res, url) => {
        if (url.pathname !== '/api/session.export') return false
        // 200 headers reach the bridge, then the upstream socket is destroyed
        // before any body byte: the web Readable errors pre-pipe-flush.
        res.writeHead(200, { 'content-type': 'application/zip' })
        res.destroy()
        return true
      },
    },
  })
  try {
    const cookie = await pairMobileUnchecked(t)
    const res = await httpFetch(`${t.base}/api/session-export?sessionId=s1`, {
      headers: { cookie },
    })
    assert.equal(res.status, 502)
    assert.equal(await res.text(), 'Export is not available right now.')
  } finally {
    await t.stop()
  }
})

async function pairMobileUnchecked(t) {
  return t.pairMobile()
}


test('GET /api/session-export streams the Host ZIP and only forwards fixed query', async () => {
  const zip = Buffer.from('PK\x03\x04 fake zip payload')
  let exportQuery
  const t = await startBridge({
    harness: 'fake',
    harnessOptions: {
      get: (req, res, url) => {
        if (url.pathname !== '/api/session.export') return false
        exportQuery = url.search
        res.writeHead(200, {
          'content-type': 'application/zip',
          'content-disposition': 'attachment; filename="dsh-session-demo.zip"',
        })
        if (req.method === 'HEAD') {
          res.end()
          return true
        }
        res.end(zip)
        return true
      },
    },
  })
  try {
    const cookie = await t.pairMobile()
    const res = await httpFetch(`${t.base}/api/session-export?sessionId=s1`, {
      headers: { cookie },
    })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'application/zip')
    assert.equal(
      res.headers.get('content-disposition'),
      'attachment; filename="dsh-session-demo.zip"'
    )
    assert.equal(res.headers.get('cache-control'), 'private, no-store')
    const body = await readBinary(res)
    assert.deepEqual(body, zip)
    // The bridge forwards exactly sessionId + includeDescendants=true.
    const qs = new URLSearchParams(exportQuery)
    assert.equal(qs.get('sessionId'), 's1')
    assert.equal(qs.get('includeDescendants'), 'true')
    assert.deepEqual([...qs.keys()].sort(), ['includeDescendants', 'sessionId'])

    const head = await httpFetch(`${t.base}/api/session-export?sessionId=s1`, {
      method: 'HEAD',
      headers: { cookie },
    })
    assert.equal(head.status, 200)
    assert.equal(head.headers.get('content-type'), 'application/zip')
    assert.equal((await head.text()).length, 0)

    const missing = await httpFetch(`${t.base}/api/session-export`, { headers: { cookie } })
    assert.equal(missing.status, 400)
  } finally {
    await t.stop()
  }
})

test('session-attachment and session-export require same-origin metadata', async () => {
  const t = await startBridge({ harness: 'fake' })
  try {
    const cookie = await t.pairMobile()
    for (const path of [
      '/api/session-attachment?sessionId=s1&attachmentId=a1',
      '/api/session-export?sessionId=s1',
    ]) {
      const res = await httpFetch(`${t.base}${path}`, {
        headers: { cookie, 'sec-fetch-site': 'cross-site' },
      })
      assert.equal(res.status, 403)
      assert.equal((await res.json()).error, 'Cross-site request rejected.')
    }
  } finally {
    await t.stop()
  }
})
// ============================================================================
// WP-A3 / M7 (change 2026-10-02-fix-pocket-audit-remediation) — the 「+」 sheet
// and the back gesture. The sheet is DOM state with no history entry behind it,
// so leaving the chat has to close it, and a row that arrives after the chat is
// gone has no session to act on. Design D-A5 deliberately keeps openPlus() off
// the history stack: a pushState there collides with handleHistory's own
// same-session folding and inflates the back stack.
// ============================================================================

import { mobilePageAssets } from '../lib/pages.js'

const a3js = mobilePageAssets({ locale: 'zh' }).js

function betweenA3(startAnchor, endAnchor, source = a3js) {
  const start = source.indexOf(startAnchor)
  const end = source.indexOf(endAnchor, start)
  assert.notEqual(start, -1, `anchor ${startAnchor} must exist in the page script`)
  assert.notEqual(end, -1, `anchor ${endAnchor} must exist in the page script`)
  assert.ok(end > start, `anchor ${endAnchor} must come after ${startAnchor}`)
  return source.slice(start, end)
}

test('M7 leaving the chat closes the plus sheet', () => {
  const listing = betweenA3('async function showSessionList()', 'function paintInstantHistory(')
  assert.ok(listing.includes('closePlus()'), 'the sheet is torn down with the chat view')
  assert.ok(listing.indexOf('closePlus()') < listing.indexOf('closeSessionStream()'), 'and before the session itself is released')
})

test('M7 a plus row that needs a session is hidden in a draft, never minted for', () => {
  // 2026-10-14: the old first statement was a flat `if(!activeSession)return`, so in a
  // brand-new draft EVERY row except the attachment pickers was a dead tap — reported as
  // "the permission switch does nothing, the whole + sheet may be dead". The fix then was
  // to materialize the session on entry.
  // 2026-10-15 反转（幽灵会话）：物化本身就是病根——用户在草稿里点一下「+」里的行、
  // 什么都不发再返回，宿主盘上就留下一个永远没有消息的空会话，主页多一个「未命名对话」
  // 占位。现在的口径：草稿态下**需要会话的行直接隐藏**（DRAFT_HIDDEN_ROWS），不占位、
  // 不拦路；草稿里能用的是附件三行、权限预设（走 applyDraftCommand 缓冲）与模型/预设
  // （走设置面板缓冲）。隐藏优先于一切分支，所以 gate 必须在下发之前。
  const rows = betweenA3('async function dispatchPlusRow(id)', 'async function send()')
  const gate = "if(!activeSession&&DRAFT_HIDDEN_ROWS.has(id))return"
  assert.ok(rows.includes(gate), 'the hide-in-draft guard is the first statement')
  assert.ok(rows.indexOf(gate) < rows.indexOf("if(id==='file')"), 'before any row is interpreted')
  assert.ok(!rows.includes('if(!activeSession)return'), 'the flat dead early return stays gone')
  assert.ok(!rows.includes('await ensureSession()'), 'no plus row may mint a session any more')
  assert.match(a3js, /const DRAFT_HIDDEN_ROWS=new Set\(\['compact','permission-current','export'\]\)/,
    'only the three rows that genuinely need a session id are hidden in a draft (goal/plan/feedback type into the composer, model opens the now-draft-safe settings panel, permission reads the host-global catalog)')
  assert.match(a3js, /const PLUS_SESSIONLESS_ROWS=new Set\(\['file','pick-image','pick-any'\]\)/,
    'the sessionless rows are exactly the two image pickers and the file picker')
})

test('M7 the row handler acts on attachments in a draft and hides the session-bound rows', async () => {
  const source = betweenA3('async function dispatchPlusRow(id)', 'async function send()')
  const build = (activeSession, draftPending) => {
    const calls = []
    const stub = (name) => (...args) => calls.push(name + (args.length ? ':' + args.join('|') : ''))
    const ids = { filePickerImage: 'filePickerImage', filePickerAny: 'filePickerAny' }
    const fn = new Function(
      'DRAFT_HIDDEN_ROWS', 'PLUS_SESSIONLESS_ROWS', 'activeSession', 'draftPending',
      'plusSuppressFocusReturn', '$',
      'renderPlusFile', 'closePlus', 'fillSlashCommand', 'runCommandLine', 'renderPlusPermission',
      'openSessionSettings', 'exportSession', 'draftSetPermission',
      `${source};return dispatchPlusRow`,
    )(
      new Set(['compact', 'permission-current', 'export']),
      new Set(['file', 'pick-image', 'pick-any']),
      activeSession,
      draftPending,
      false,
      (id) => ({ click: () => calls.push('click:' + (ids[id] || id)) }),
      stub('file'), stub('close'), stub('slash'), stub('run'), stub('permission'),
      stub('settings'), stub('export'), stub('draftCmd'),
    )
    return { fn: (id) => fn(id), calls }
  }

  // A draft with no session: attachments paint locally, session-bound rows are hidden,
  // and NOTHING reaches the Host — that is the whole point of the reversal.
  const draft = build(null, { preset: null, model: null, permission: null })
  draft.fn('file')
  draft.fn('pick-image')
  draft.fn('pick-any')
  for (const id of ['compact', 'permission-current', 'export']) {
    draft.fn(id)
  }
  assert.deepEqual(draft.calls, ['file', 'close', 'click:filePickerImage', 'close', 'click:filePickerAny'],
    'a draft tap either paints locally or does nothing at all')
  await draft.fn('preset:read-only')
  assert.deepEqual(draft.calls.slice(5), ['close', 'draftCmd:read-only'],
    'a permission preset in a draft is only recorded — never a create, never a Host call')
  await draft.fn('permission')
  assert.deepEqual(draft.calls.slice(7), ['permission'],
    'the one sheet a draft can open is the permission list — it needs no session')

  // Inside a chat the same rows act directly.
  const live = build('s1', null)
  live.fn('file')
  live.fn('pick-image')
  live.fn('model')
  assert.deepEqual(live.calls, ['file', 'close', 'click:filePickerImage', 'close', 'settings'],
    'inside a chat the same rows act without touching any draft state')

  // In a draft WITH a session the permission presets act on that session, not on a buffer.
  const bound = build('s1', { preset: null, model: null, permission: null })
  await bound.fn('permission')
  assert.deepEqual(bound.calls, ['permission'], 'a bound draft opens the same sheet')
})

test('M7 openPlus stays off the history stack (design D-A5)', () => {
  const opener = betweenA3('function openPlus()', 'function closePlus(')
  assert.ok(!opener.includes('pushState'), 'no history entry is added for the sheet')
  const closer = betweenA3('function closePlus()', 'async function runCommandLine(')
  assert.ok(closer.includes('setTimeout('), 'and closing is still an animation, not a history pop')
})
