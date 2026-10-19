// Image/file capability (change 2026-10-07-feat-pocket-image-file-capability):
// the lightbox, the inline text-attachment preview, the markdown-image rewrite
// onto /api/session-file, and the presented-file cards.
//
// Client half: the same slice-the-shell technique block-placeholder uses — the
// renderer organs live between renderBlock and renderTurnProcess precisely so
// this window carries them, and the runtime half is extracted by name.
// Bridge half: the pure collectors plus a real pairing + temp-file round trip.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mobilePageAssets } from '../lib/pages.js'
import { collectFilePaths, sessionFileType } from '../lib/bridge.js'
import { startBridge, httpFetch } from './helpers.js'

const assets = { zh: mobilePageAssets({ locale: 'zh' }), en: mobilePageAssets({ locale: 'en' }) }

function labels(locale) {
  const line = assets[locale].js.match(/^const L=(\{.*\});/m)
  assert(line, `${locale}: the label table must render as one JSON line`)
  return JSON.parse(line[1])
}

/** Extract one balanced-brace declaration from the page script. */
function extractFunction(source, name) {
  const marker = `function ${name}(`
  const start = source.indexOf(marker)
  assert.notEqual(start, -1, `${name} must exist in the page script`)
  let depth = 0
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  assert.fail(`${name} braces never balance`)
}

// ---------------------------------------------------------------------------
// renderBlock: presented cards, textual-attachment preview card, clickable image
// ---------------------------------------------------------------------------

function renderSandbox(locale) {
  const js = assets[locale].js
  const start = js.indexOf('function renderBlock(')
  const end = js.indexOf('function renderTurnProcess(')
  assert.notEqual(start, -1, 'renderBlock must exist')
  assert.notEqual(end, -1, 'renderTurnProcess must exist')
  const messageStart = js.indexOf('function renderMessage(')
  const messageEnd = js.indexOf('function syncPromptUi(')
  assert.notEqual(messageStart, -1, 'renderMessage must exist')
  assert.notEqual(messageEnd, -1, 'syncPromptUi must exist')
  const body = [
    `const esc=v=>String(v==null?'':v)`,
    `const markdown=text=>String(text||'')`,
    `let agentRunning=false`,
    `function formatBytes(n){n=Number(n)||0;if(n<1024)return n+' B';const units=['KB','MB','GB'];let v=n/1024,i=0;while(v>=1024&&i<units.length-1){v/=1024;i++}return v.toFixed(v<10?1:0)+' '+units[i]}`,
    js.slice(start, end),
    js.slice(messageStart, messageEnd),
  ].join('\n')
  return new Function('L', 'activeSession', `${body};return { renderBlock, renderMessage }`)(
    labels(locale),
    's1',
  )
}

const WIN_PATH = 'F:\\tmp rep\\probe pic.png'
const WIN_SCRIPT = 'F:\\code\\run analysis.py'

test('a presented image renders a session-file figure with its description', () => {
  const { renderBlock } = renderSandbox('zh')
  const html = renderBlock({ kind: 'presented', files: [{ path: WIN_PATH, description: '探测截图' }] }, false)
  assert.ok(html.includes('<figure class="attach-image presented-image"'), 'the figure wraps the picture')
  assert.ok(html.includes('data-lightbox="image"'), 'the picture opens the lightbox')
  assert.ok(html.includes('/api/session-file?sessionId=s1&path=' + encodeURIComponent(WIN_PATH)), 'the source is the session-file route')
  assert.ok(html.includes('data-path="' + WIN_PATH.replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '"'), 'the literal path rides along for the 404 fallback')
  assert.ok(html.includes('探测截图'), 'the description is the caption')
})

test('a presented non-image renders a download card with the real file name', () => {
  const { renderBlock } = renderSandbox('zh')
  const html = renderBlock({ kind: 'presented', files: [{ path: WIN_SCRIPT, description: '脚本' }] }, false)
  assert.ok(html.includes('<a class="attach-file presented-file"'), 'the card is a link')
  assert.ok(html.includes('download="run analysis.py"'), 'the save keeps the real file name')
  assert.ok(html.includes('/api/session-file?sessionId=s1&path='), 'the link points at the session-file route')
  assert.ok(html.includes('脚本'), 'the description rides on the card')
  assert.ok(!html.includes('<img'), 'no image element for a script')
})

test('a presented group skips pathless entries and renders nothing when empty', () => {
  const { renderBlock } = renderSandbox('zh')
  const mixed = renderBlock({ kind: 'presented', files: [{ description: 'no path' }, { path: WIN_PATH }] }, false)
  assert.ok(mixed.includes('probe pic.png'), 'the real file stays')
  assert.ok(!mixed.includes('no path'), 'a pathless entry renders nothing')
  assert.equal(renderBlock({ kind: 'presented', files: [{}] }, false), '', 'no cards, no wrapper')
})

test('a textual attachment is a preview button, not a download link', () => {
  const { renderBlock } = renderSandbox('zh')
  const html = renderBlock({ kind: 'file', attachment: { attachmentId: 't-1', name: 'notes.md', bytes: 20, mediaType: 'text/markdown' } }, false)
  assert.ok(html.startsWith('<button type="button" class="attach-file attach-file-open"'), 'the card is a button')
  assert.ok(html.includes('data-file-preview="t-1"'), 'the preview handler finds the attachment id')
  assert.ok(!/download/.test(html), 'nothing downloads on tap')
})

test('a binary attachment keeps the direct download card', () => {
  const { renderBlock } = renderSandbox('zh')
  const html = renderBlock({ kind: 'file', attachment: { attachmentId: 'b-1', name: 'report.pdf', bytes: 2048 } }, false)
  assert.ok(html.startsWith('<a class="attach-file attach-file-open"'), 'the card is a link')
  assert.ok(html.includes('download'), 'the link asks the browser to save')
})

test('an inline image carries the lightbox handle', () => {
  const { renderBlock } = renderSandbox('zh')
  const html = renderBlock({ kind: 'image', attachment: { attachmentId: 'a-1', name: 'shot.png' } }, false)
  assert.ok(html.includes('<img loading="lazy" data-lightbox="image"'), 'the picture opens the lightbox')
  assert.ok(html.includes('data-name="shot.png"'), 'the save keeps the original name')
})

// ---------------------------------------------------------------------------
// The textual-attachment decision table (text/json/code → preview; rest → download)
// ---------------------------------------------------------------------------

test('isTextualAttachment: the decision table', () => {
  const js = assets.zh.js
  const body = [
    `const esc=v=>String(v==null?'':v)`,
    `function formatBytes(n){return ''}`,
    js.slice(js.indexOf('function renderBlock('), js.indexOf('function renderTurnProcess(')),
  ].join('\n')
  const { isTextualAttachment } = new Function('L', 'activeSession', `${body};return { isTextualAttachment }`)(labels('zh'), 's1')
  const textual = [
    { mediaType: 'text/plain', name: 'a.txt' },
    { mediaType: 'text/markdown', name: 'a.md' },
    { mediaType: 'application/json', name: 'a.json' },
    { mediaType: 'application/javascript', name: 'a.js' },
    { mediaType: 'application/x-sh', name: 'a.sh' },
    { mediaType: 'application/ld+json', name: 'a.jsonld' },
    // text/html previews as source text: the panel is a textContent <pre>, and
    // the served type stays octet-stream — only the preview decision is textual.
    { mediaType: 'text/html', name: 'page.html' },
    { name: 'script.tsx' },
    { name: 'config.yaml' },
  ]
  for (const attachment of textual) assert.equal(isTextualAttachment(attachment), true, JSON.stringify(attachment))
  const binary = [
    { mediaType: 'application/pdf', name: 'a.pdf' },
    { mediaType: 'image/png', name: 'a.png' },
    { mediaType: 'application/octet-stream', name: 'a.bin' },
    { name: 'archive.zip' },
    { name: 'photo.jpg' },
    { name: 'noext' },
    { name: 'Makefile' },
    {},
  ]
  for (const attachment of binary) assert.equal(isTextualAttachment(attachment), false, JSON.stringify(attachment))
})

// ---------------------------------------------------------------------------
// inlineMarkdown: known local paths become session-file images, the rest stays text
// ---------------------------------------------------------------------------

function markdownSandbox(paths) {
  const js = assets.zh.js
  const known = new Set(paths)
  const body = [
    `const esc=v=>String(v==null?'':v)`,
    `let activeSession='s1'`,
    extractFunction(js, 'baseNameOf'),
    extractFunction(js, 'sessionFileUrl'),
    `const knownPathsOf=(id)=>known`,
    extractFunction(js, 'inlineMarkdown'),
  ].join('\n')
  return new Function('known', `${body};return { inlineMarkdown }`)(known)
}

test('a markdown image whose path the session showed renders as a session-file image', () => {
  const { inlineMarkdown } = markdownSandbox([WIN_PATH])
  const html = inlineMarkdown('before ![探测截图](<' + WIN_PATH + '>) after')
  assert.ok(html.includes('<img class="md-image"'), 'the picture renders')
  assert.ok(html.includes('/api/session-file?sessionId=s1&path=' + encodeURIComponent(WIN_PATH)), 'through the session-file route')
  assert.ok(html.includes('data-path="' + WIN_PATH.replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '"'), 'the literal path is kept for the fallback')
  assert.ok(html.includes('alt="探测截图"'), 'the alt text survives')
})

test('a bare-path markdown image in the set renders the same way', () => {
  const { inlineMarkdown } = markdownSandbox(['C:\\plain\\form.png'])
  const html = inlineMarkdown('![shot](C:\\plain\\form.png)')
  assert.ok(html.includes('<img class="md-image"'), 'the picture renders')
})

test('a path outside the set stays the literal markdown text it arrived as', () => {
  const { inlineMarkdown } = markdownSandbox([])
  const html = inlineMarkdown('![alt](<' + WIN_PATH + '>)')
  assert.ok(!html.includes('<img'), 'nothing may be requested')
  assert.ok(html.includes('![alt]'), 'the text is shown as-is')
})

test('a web image is not rewritten even when the session showed local paths', () => {
  const { inlineMarkdown } = markdownSandbox([WIN_PATH])
  const html = inlineMarkdown('![alt](https://example.com/pic.png)')
  assert.ok(!html.includes('<img'), 'remote images stay out of the rewrite')
})

// ---------------------------------------------------------------------------
// noteSessionPaths: the client-side allowlist collector
// ---------------------------------------------------------------------------

function pathsSandbox() {
  const js = assets.zh.js
  const body = [
    `let activeSession='s1'`,
    `const SESSION_PATH_SETS_MAX=8,SESSION_PATH_ENTRIES_MAX=400`,
    `const sessionFilePaths=new Map()`,
    extractFunction(js, 'noteSessionPaths'),
    `return { noteSessionPaths, known: () => sessionFilePaths, set active(id) { activeSession = id } }`,
  ].join('\n')
  return new Function(body)()
}

test('the collector gathers presented files and markdown images per session', () => {
  const box = pathsSandbox()
  box.noteSessionPaths([
    { seq: 1, event: { type: 'deliverables/presented', data: { files: [{ path: WIN_PATH, description: 'd' }] } } },
    { seq: 2, event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '![x](<' + WIN_SCRIPT + '>) and ![y](' + WIN_PATH + ')' }] } } } },
    { seq: 3, event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'no images here' }] } } } },
    { seq: 4, event: { type: 'turn/end', data: {} } },
  ])
  const set = box.known().get('s1')
  assert.equal(set.size, 2, 'the two distinct paths are collected, deduped')
  assert.ok(set.has(WIN_PATH) && set.has(WIN_SCRIPT))
})

test('the collector keys sets by session', () => {
  const box = pathsSandbox()
  box.noteSessionPaths([{ event: { type: 'deliverables/presented', data: { files: [{ path: WIN_PATH }] } } }])
  box.active = 's2'
  box.noteSessionPaths([{ event: { type: 'deliverables/presented', data: { files: [{ path: WIN_SCRIPT }] } } }])
  assert.ok(box.known().get('s1').has(WIN_PATH))
  assert.ok(box.known().get('s2').has(WIN_SCRIPT))
  assert.equal(box.known().size, 2)
})

test('a session with no events collects nothing', () => {
  const box = pathsSandbox()
  box.noteSessionPaths([])
  assert.equal(box.known().size, 0)
})

// ---------------------------------------------------------------------------
// The full projection: a presented record must survive visibleMessages END TO
// END. The P1 regression this pins (independent review, 2026-10-08): the
// rendered push carried no `.turn`, and the tail loop read `turn.closed` on
// every assistant item — a cold open of a session with a present record threw
// inside paintInstantSession (no try/catch) and the page died before the
// realtime leg ever started. Direct renderBlock calls never reach that loop,
// which is why the first round of tests missed it.
// ---------------------------------------------------------------------------

function projectionSandbox() {
  const js = assets.zh.js
  const names = ['eventSeq', 'mergeEntries', 'contentBlocks', 'stepKey', 'visibleMessages', 'orderUserBubblesByTime']
  const body = names.map((name) => extractFunction(js, name)).join('\n')
  return new Function(`
    const processBlocks=()=>[];
    const L={};
    ${body}
    return { visibleMessages }
  `)()
}

test('a presented record projects through visibleMessages without throwing and renders as a message', () => {
  const { visibleMessages } = projectionSandbox()
  const messages = visibleMessages([
    { seq: 1, event: { type: 'user/message', data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text: '发图' }] } } } },
    { seq: 2, event: { type: 'deliverables/presented', data: { turn: 1, files: [{ path: WIN_PATH, description: '探测截图' }] } } },
    { seq: 3, event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '![探测截图](<' + WIN_PATH + '>)' }] } } } },
    { seq: 4, event: { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } },
  ])
  const presented = messages.find((message) => message.role === 'assistant' && message.blocks?.[0]?.kind === 'presented')
  assert.ok(presented, 'the presented record becomes its own assistant message')
  assert.equal(presented.turn, undefined, 'and it carries no turn — the render loop must guard on that')
  const text = messages.find((message) => message.blocks?.[0]?.kind === 'text')
  assert.ok(text, 'the assistant text still projects as before')

  const { renderMessage } = renderSandbox('zh')
  const html = renderMessage(presented)
  assert.ok(html.includes('<figure class="attach-image presented-image"'), 'the produced message renders the presented figure')
  assert.ok(html.includes('session-file?sessionId=s1&path='), 'through the session-file route')
})

// ---------------------------------------------------------------------------
// The lightbox state machine
// ---------------------------------------------------------------------------

function lightboxSandbox() {
  const js = assets.zh.js
  const elements = new Map()
  const element = () => ({
    hidden: true,
    textContent: '',
    alt: '',
    src: '',
    attrs: new Map(),
    classes: new Set(),
    removed: [],
    setAttribute(name, value) { this.attrs.set(name, String(value)) },
    getAttribute(name) { return this.attrs.get(name) ?? null },
    removeAttribute(name) { this.attrs.delete(name) },
    classList: {
      add: (c) => element().classes.add(c),
      remove: (c) => element().classes.delete(c),
      contains: (c) => element().classes.has(c),
    },
  })
  const $ = (id) => {
    if (!elements.has(id)) elements.set(id, element())
    return elements.get(id)
  }
  let revoked = 0
  const FakeURL = { createObjectURL: () => 'blob:faked', revokeObjectURL: () => { revoked += 1 } }
  const body = [
    `const lightboxState={mode:null,blobUrl:null}`,
    extractFunction(js, 'lightboxOpen'),
    extractFunction(js, 'lightboxResetBlob'),
    extractFunction(js, 'openLightboxImage'),
    extractFunction(js, 'openLightboxText'),
    extractFunction(js, 'closeLightbox'),
    `return { lightboxState, lightboxOpen, openLightboxImage, openLightboxText, closeLightbox, el: $ }`,
  ].join('\n')
  const box = new Function('$', 'URL', 'Blob', body)($, FakeURL, Blob)
  box.revoked = () => revoked
  return box
}

test('lightbox: open image → save name and source carry through → close resets', () => {
  const box = lightboxSandbox()
  assert.equal(box.lightboxOpen(), false, 'it starts closed')
  box.openLightboxImage('/api/session-file?sessionId=s1&path=x', 'probe pic.png')
  assert.equal(box.lightboxOpen(), true, 'open after an image')
  const img = box.el('lightboxImg')
  assert.equal(img.hidden, false, 'the image is visible')
  assert.equal(img.src, '/api/session-file?sessionId=s1&path=x', 'the stage loads the source')
  const save = box.el('lightboxSave')
  assert.equal(save.getAttribute('href'), '/api/session-file?sessionId=s1&path=x', 'the save link points at the source')
  assert.equal(save.getAttribute('download'), 'probe pic.png', 'the save keeps the original file name')
  assert.equal(save.hidden, false)
  assert.equal(box.el('lightboxCopy').hidden, true, 'no copy button for a picture')
  box.closeLightbox()
  assert.equal(box.lightboxOpen(), false, 'closed again')
  assert.equal(img.getAttribute('src'), null, 'the stage stops loading')
  assert.equal(save.getAttribute('href'), null, 'the save link is disarmed')
})

test('lightbox: open text → copy visible, save rides a blob url with the name', () => {
  const box = lightboxSandbox()
  box.openLightboxText('line one\nline two', 'notes.md')
  assert.equal(box.lightboxOpen(), true)
  const pre = box.el('lightboxText')
  assert.equal(pre.hidden, false, 'the text stage is visible')
  assert.equal(pre.textContent, 'line one\nline two', 'the full text is shown')
  assert.equal(box.el('lightboxCopy').hidden, false, 'the copy button is there')
  const save = box.el('lightboxSave')
  assert.equal(save.getAttribute('download'), 'notes.md', 'the save keeps the file name')
  assert.equal(save.getAttribute('href'), 'blob:faked', 'the save link is a blob url')
  assert.equal(box.lightboxState.mode, 'text')
  box.closeLightbox()
  assert.equal(box.revoked(), 1, 'closing revokes the blob url exactly once')
})

test('lightbox: reopening in the other mode cleans the previous stage', () => {
  const box = lightboxSandbox()
  box.openLightboxImage('/x.png', 'x.png')
  box.openLightboxText('text', 'a.txt')
  assert.equal(box.el('lightboxImg').hidden, true, 'the image stage hides')
  assert.equal(box.el('lightboxImg').getAttribute('src'), null, 'the image source is dropped')
  box.openLightboxImage('/y.png', 'y.png')
  assert.equal(box.el('lightboxText').hidden, true, 'the text stage hides')
  assert.equal(box.el('lightboxCopy').hidden, true, 'the copy button hides')
  box.closeLightbox()
  assert.equal(box.revoked(), 1, 'the text blob was revoked on the switch')
})

// ---------------------------------------------------------------------------
// The inline preview line cap
// ---------------------------------------------------------------------------

test('the inline preview truncates at 200 lines and reports the rest', () => {
  const js = assets.zh.js
  const body = [
    `const ATTACH_PREVIEW_LINE_CAP=200`,
    extractFunction(js, 'truncatePreviewLines'),
    `return { truncatePreviewLines }`,
  ].join('\n')
  const { truncatePreviewLines } = new Function(body)()
  const short = ['a', 'b'].join('\n')
  assert.deepEqual(truncatePreviewLines(short), { text: short, more: 0 }, 'short text passes through whole')
  const exactly = Array.from({ length: 200 }, (_, i) => 'L' + i).join('\n')
  assert.deepEqual(truncatePreviewLines(exactly), { text: exactly, more: 0 }, '200 lines fit exactly')
  const long = Array.from({ length: 260 }, (_, i) => 'L' + i).join('\n')
  const cut = truncatePreviewLines(long)
  assert.equal(cut.text.split('\n').length, 200, 'the inline copy stops at 200 lines')
  assert.equal(cut.more, 60, 'the remainder is counted for view-all')
  const crlf = 'a\r\nb\r\nc'
  assert.deepEqual(truncatePreviewLines(crlf), { text: 'a\nb\nc', more: 0 }, 'CRLF is normalised before counting')
})

// ---------------------------------------------------------------------------
// The page carries the overlay, the styles and both locales' copy
// ---------------------------------------------------------------------------

test('the shell carries the lightbox overlay, its styles and the locale copy', () => {
  for (const locale of ['zh', 'en']) {
    const { css, js } = assets[locale]
    assert.ok(js.includes('id="lightbox"') || css.includes('.lightbox{'), `${locale}: overlay present`)
    assert.match(css, /position:fixed/, 'the lightbox is fixed')
    assert.match(css, /100dvh/, 'the lightbox sizes to the dynamic viewport')
    assert.match(css, /\.lightbox\.zoomed /, 'the second zoom level has its rule')
    assert.match(css, /\.md-image\{/, 'markdown images have their style')
    assert.match(css, /\.md-image-fallback\{/, 'the 404 fallback has its style')
    assert.match(css, /\.attach-preview\{/, 'the inline preview has its style')
    assert.match(css, /\.presented-desc\{/, 'presented captions have their style')
    const page = locale === 'zh' ? assets.zh.js : assets.en.js
    assert.ok(page.includes('data-lightbox-stage'), 'the stage the zoom taps live in')
  }
  assert.equal(labels('zh').save, '保存')
  assert.equal(labels('zh').viewAll, '查看全部')
  assert.equal(labels('en').save, 'Save')
  assert.equal(labels('en').copied, 'Copied')
})

// ---------------------------------------------------------------------------
// Bridge half: the pure collector and the type table
// ---------------------------------------------------------------------------

test('collectFilePaths reads presented files and markdown images in every frame shape', () => {
  const set = new Set()
  collectFilePaths(set, { event: { type: 'deliverables/presented', seq: 1, data: { files: [{ path: WIN_PATH }] } } })
  collectFilePaths(set, { event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '![a](<' + WIN_SCRIPT + '>) ![b](C:\\plain\\form.png)' }] } } } })
  collectFilePaths(set, { type: 'deliverables/presented', data: { files: [{ path: 'D:\\bare\\record.png' }] } })
  collectFilePaths(set, { records: [{ event: { type: 'deliverables/presented', data: { files: [{ path: 'E:\\snap\\shot.png' }] } } }] })
  assert.deepEqual(
    [...set].sort(),
    [WIN_PATH, WIN_SCRIPT, 'C:\\plain\\form.png', 'D:\\bare\\record.png', 'E:\\snap\\shot.png'].sort(),
    'all four frame shapes contribute',
  )
})

test('collectFilePaths ignores other events and malformed entries', () => {
  const set = new Set()
  collectFilePaths(set, { event: { type: 'tool/call', data: { name: 'read', arguments: { path: 'F:\\tool\\arg.txt' } } } })
  collectFilePaths(set, { event: { type: 'assistant/message', data: { message: { content: [{ type: 'image', attachment: { name: 'x.png' } }] } } } })
  collectFilePaths(set, { event: { type: 'deliverables/presented', data: { files: [{ description: 'no path' }, 'junk', 42] } } })
  collectFilePaths(set, null)
  collectFilePaths(set, 'text')
  assert.equal(set.size, 0, 'tool arguments and pathless entries never widen the set')
})

test('sessionFileType: the extension table', () => {
  assert.equal(sessionFileType('F:\\a\\pic.PNG'), 'image/png')
  assert.equal(sessionFileType('F:\\a\\photo.jpeg'), 'image/jpeg')
  assert.equal(sessionFileType('/x/y.webp'), 'image/webp')
  assert.equal(sessionFileType('C:\\notes.txt'), 'text/plain')
  assert.equal(sessionFileType('data.json'), 'application/json')
  assert.equal(sessionFileType('no-extension'), 'application/octet-stream')
  assert.equal(sessionFileType('.gitignore'), 'application/octet-stream')
  assert.equal(sessionFileType('page.html'), 'application/octet-stream', 'html serves as a download by omission')
  assert.equal(sessionFileType(''), 'application/octet-stream')
})

// ---------------------------------------------------------------------------
// Bridge half: the endpoint round trip
// ---------------------------------------------------------------------------

test('session-file: a known path serves inline, an unknown one 404s, and no path reaches the log', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pocket-session-file-'))
  try {
    const png = join(dir, 'probe pic.png')
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
    await writeFile(png, pngBytes)
    const t = await startBridge()
    try {
      const cookie = await t.pairMobile('PocketSessionFile/1.0')
      t.bridge.noteSessionFilePaths('sess-1', [
        { event: { type: 'deliverables/presented', data: { files: [{ path: png, description: 'shot' }] } } },
      ])

      const ok = await httpFetch(`${t.base}/api/session-file?sessionId=sess-1&path=${encodeURIComponent(png)}`, { headers: { cookie } })
      assert.equal(ok.status, 200)
      assert.equal(ok.headers.get('content-type'), 'image/png', 'images serve inline')
      assert.equal(ok.headers.get('content-disposition'), null, 'no download header for an inline picture')
      assert.equal(ok.headers.get('cache-control'), 'private, no-store')
      const body = Buffer.from(await new Response(ok.body).arrayBuffer())
      assert.deepEqual([...body], [...pngBytes], 'the exact bytes come back')

      const outside = join(dir, 'secret.txt')
      await writeFile(outside, 'secret')
      const refused = await httpFetch(`${t.base}/api/session-file?sessionId=sess-1&path=${encodeURIComponent(outside)}`, { headers: { cookie } })
      assert.equal(refused.status, 404, 'a path the session never showed is refused')

      const other = await httpFetch(`${t.base}/api/session-file?sessionId=sess-2&path=${encodeURIComponent(png)}`, { headers: { cookie } })
      assert.equal(other.status, 404, 'another session cannot name this one\'s path')

      const missing = await httpFetch(`${t.base}/api/session-file?sessionId=sess-1&path=${encodeURIComponent(join(dir, 'gone.png'))}`, { headers: { cookie } })
      assert.equal(missing.status, 404, 'a deleted file answers 404, not 500')

      for (const log of t.logs) {
        assert.ok(!log.message.includes(dir), 'no log line ever carries the local path')
      }
    } finally {
      await t.stop()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('session-file: a non-image known path downloads under its real name', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pocket-session-file-'))
  try {
    const log = join(dir, 'run log.txt')
    await writeFile(log, 'hello')
    const t = await startBridge()
    try {
      const cookie = await t.pairMobile('PocketSessionFile/1.0')
      t.bridge.noteSessionFilePaths('sess-1', [
        { event: { type: 'deliverables/presented', data: { files: [{ path: log }] } } },
      ])
      const res = await httpFetch(`${t.base}/api/session-file?sessionId=sess-1&path=${encodeURIComponent(log)}`, { headers: { cookie } })
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('content-type'), 'application/octet-stream', 'non-images never render on this origin')
      assert.equal(res.headers.get('content-disposition'), 'attachment; filename="run log.txt"', 'the save keeps the real file name')
    } finally {
      await t.stop()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('session-file: the gates — pairing, origin, and required params', async () => {
  const t = await startBridge()
  try {
    const noCookie = await httpFetch(`${t.base}/api/session-file?sessionId=s&path=${encodeURIComponent('C:\\x.png')}`)
    assert.equal(noCookie.status, 401, 'no mobile cookie, no file')

    const cookie = await t.pairMobile('PocketSessionFile/1.0')
    const cross = await httpFetch(`${t.base}/api/session-file?sessionId=s&path=${encodeURIComponent('C:\\x.png')}`, {
      headers: { cookie, origin: 'https://evil.example' },
    })
    assert.equal(cross.status, 403, 'a cross-site request is refused')

    const noPath = await httpFetch(`${t.base}/api/session-file?sessionId=s`, { headers: { cookie } })
    assert.equal(noPath.status, 400, 'a missing path is a 400')

    const noSession = await httpFetch(`${t.base}/api/session-file?path=${encodeURIComponent('C:\\x.png')}`, { headers: { cookie } })
    assert.equal(noSession.status, 400, 'a missing session id is a 400')
  } finally {
    await t.stop()
  }
})

// ---------------------------------------------------------------------------
// ensureSession: concurrent first actions share ONE in-flight create.
// The old draftBusy flag answered every follower with null and their work was
// dropped silently — a draft-state multi-select upload kept only the first
// file, with no draft row, no error and no log (found 2026-10-12).
// ---------------------------------------------------------------------------

/** Build the page's ensureSession over injectable surroundings. The shared
 * extractor starts at `function ensureSession(` and eats the `async` keyword,
 * so it is put back here — the body awaits. */
function ensureSessionSandbox() {
  const ensure = extractFunction(assets.zh.js, 'ensureSession')
  return new Function('rpc', 'showError', `
    let activeSession=null, draftWorkspaceId='ws-1', draftEnsurePromise=null
    let sessionBlank=true, followStream=true
    const workspaces=[{workspaceId:'ws-1',sessionIds:[]}]
    const pendingCreatedSessions=[], sessionSummaries=[]
    // 2026-10-15: ensureSession now flushes the draft settings buffer onto the new
    // session before returning. This file pins the fan-out (one create, no dropped
    // files) — the buffer stays empty here, so the flush is a no-op stub.
    let draftPending=null
    async function applyDraftPending(){}
    const history={replaceState(){}}
    const L={untitled:'untitled'}
    const openRealtime=()=>{}
    async ${ensure}
    return { ensureSession, state: () => ({ activeSession, draftWorkspaceId }) }
  `)
}

test('draft fan-out: racing first actions mint ONE session — multi-select no longer drops files', async () => {
  let creates = 0
  const rpc = async (method) => {
    assert.equal(method, 'session.create')
    creates += 1
    await new Promise(resolve => setTimeout(resolve, 20))
    return { sessionId: 'sess-new', origin: 'user' }
  }
  const ctx = ensureSessionSandbox()(rpc, () => {})
  const [a, b, c] = await Promise.all([ctx.ensureSession(), ctx.ensureSession(), ctx.ensureSession()])
  assert.equal(creates, 1, 'three racing callers must reach the Host once')
  assert.equal(a, 'sess-new')
  assert.equal(b, a, 'a follower awaits the shared create instead of getting null')
  assert.equal(c, a, 'the third caller is served by the same in-flight create')
  assert.equal(ctx.state().activeSession, a, 'the materialized session sticks')
  assert.equal(ctx.state().draftWorkspaceId, null, 'the draft is consumed')
})

test('draft fan-out: one failing create surfaces one error and stays retryable', async () => {
  let attempts = 0
  let errors = 0
  const failingRpc = async () => {
    attempts += 1
    await new Promise(resolve => setTimeout(resolve, 5))
    throw new Error('host down')
  }
  const ctx = ensureSessionSandbox()(failingRpc, () => { errors += 1 })
  const results = await Promise.all([ctx.ensureSession(), ctx.ensureSession()])
  assert.deepEqual(results, [null, null], 'every caller of a failed create is told')
  assert.equal(attempts, 1, 'the failing create is not duplicated per caller')
  assert.equal(errors, 1, 'one failure surfaces one error, not one per caller')
  assert.equal(await ctx.ensureSession(), null, 'it still fails while the Host is down')
  assert.equal(attempts, 2, 'a consumed failure is retried on the next call, not cached forever')
})
