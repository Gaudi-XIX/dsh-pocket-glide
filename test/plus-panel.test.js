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
    // No attachments key when the composer holds none.
    await rpcCall(t, cookie, 'command.execute', { sessionId: 'sess-9', line: '/compact' })
    const plain = t.harness.records.calls
      .filter((c) => c.url === '/api/commands/execute')
      .at(-1)
    assert.deepEqual(plain.args, { agentId: 'sess-9', line: '/compact' })
    assert.ok(!('submittedAttachments' in plain.args))
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
