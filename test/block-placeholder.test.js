// Dead attachments in a history message — WP-A3 / M19
// (change 2026-10-02-fix-pocket-audit-remediation, tasks WP-A3).
//
// Live report: a message that was only a picture simply does not appear in the
// transcript. The image branch of renderBlock returned an empty string once the
// host had dropped the attachment (offloaded / no attachmentId), and the page CSS
// carries `.message:empty{display:none}` — so the whole row collapsed. The block
// now leaves a named chip in place of the picture.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mobilePageAssets } from '../lib/pages.js'

const assets = { zh: mobilePageAssets({ locale: 'zh' }), en: mobilePageAssets({ locale: 'en' }) }

function labels(locale) {
  const line = assets[locale].js.match(/^const L=(\{.*\});/m)
  assert(line, `${locale}: the label table must render as one JSON line`)
  return JSON.parse(line[1])
}

// renderBlock is a single dense line that also contains braces inside string
// literals, so the slice runs to the next definition instead of counting braces.
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

const DEAD = { kind: 'image', attachment: { name: 'shot.png' }, offloaded: true }
const ORPHAN = { kind: 'image', attachment: {} }
const LIVE = { kind: 'image', attachment: { attachmentId: 'a-1', name: 'shot.png' } }
const FILE_LIVE = { kind: 'file', attachment: { attachmentId: 'f-1', name: 'report.pdf', bytes: 2048 } }
const FILE_GONE = { kind: 'file', attachment: { name: 'old.zip' } }

test('M19 a dropped image renders a named chip instead of nothing', () => {
  const { renderBlock } = renderSandbox('zh')
  for (const block of [DEAD, ORPHAN]) {
    const html = renderBlock(block, false)
    assert.notEqual(html, '', 'the block may not collapse to an empty string')
    assert.ok(html.includes('图片已过期，无法显示'), `the chip names itself (${block.offloaded ? 'offloaded' : 'no attachmentId'})`)
    assert.ok(html.includes('attach-gone'), 'the chip has its own class for the CSS')
    assert.ok(!html.includes('<img'), 'nothing may be requested for an attachment that is gone')
  }
})

test('M19 the chip is localized like the rest of the page', () => {
  assert.equal(labels('zh').imageGone, '图片已过期，无法显示')
  assert.equal(labels('en').imageGone, 'Image expired and cannot be shown')
  assert.ok(renderSandbox('en').renderBlock(DEAD, false).includes('Image expired and cannot be shown'))
})

test('M19 a live image still renders its picture', () => {
  const html = renderSandbox('zh').renderBlock(LIVE, false)
  assert.ok(html.includes('<img loading="lazy"'), 'the working path is untouched')
  assert.ok(html.includes('attachmentId=a-1'), 'and still points at the attachment route')
  assert.ok(!html.includes('attach-gone'), 'no chip for an image that can be shown')
})

test('M19 an image-only history message keeps its row on screen', () => {
  const { renderMessage } = renderSandbox('zh')
  const html = renderMessage({ role: 'user', blocks: [DEAD] })
  // The collapse came from the empty-message rule: an empty row is display:none.
  assert.ok(!/^<div class="message user"><\/div>$/.test(html), 'the row is no longer empty')
  assert.ok(html.includes('图片已过期，无法显示'), 'and the user can see why it has no picture')
  assert.ok(assets.zh.css.includes('.message:empty{display:none}'), 'the CSS rule that hid it is still there (it is not the bug)')
  assert.equal(assets.zh.css.split('.message:empty{display:none}').length - 1, 1, 'exactly one copy')
  assert.ok(assets.zh.css.includes('.attach-gone{'), 'the chip has a style of its own')
})

test('M19 the empty-string branch is gone from the source', () => {
  for (const locale of ['zh', 'en']) {
    const js = assets[locale].js
    assert.ok(!js.includes(`!a.attachmentId)return''`), `${locale}: the silent-return shape must not come back`)
    assert.ok(!js.includes(`if(block.offloaded||!a.attachmentId)return''`), `${locale}: an offloaded image must not collapse the row`)
    assert.ok(js.includes(`if(block.offloaded||!a.attachmentId)return'<div class="attach-image attach-gone">`), `${locale}: the chip branch is the only exit`)
  }
})

test('a live file renders a download card pointing at the attachment route', () => {
  const html = renderSandbox('zh').renderBlock(FILE_LIVE, false)
  assert.ok(html.startsWith('<a class="attach-file attach-file-open"'), 'the card is a link')
  assert.ok(html.includes('href="/api/session-attachment?sessionId=s1&attachmentId=f-1"'), 'points at the attachment route')
  assert.ok(html.includes('download'), 'the link asks the browser to save the file')
  assert.ok(html.includes('report.pdf'), 'the real name is shown')
  assert.ok(html.includes('2.0 KB'), 'the size is shown')
  assert.ok(html.includes('attach-file-action'), 'the download affordance is rendered')
  assert.ok(!html.includes('<img'), 'no image element for a file')
  assert.ok(assets.zh.css.includes('.attach-file-open{'), 'the card has a style of its own')
})

test('a file without an attachment id keeps the inert chip', () => {
  const html = renderSandbox('zh').renderBlock(FILE_GONE, false)
  assert.ok(html.startsWith('<span class="attach-file"'), 'no link when the attachment is gone')
  assert.ok(!html.includes('session-attachment'), 'nothing may be requested for a file that is gone')
  assert.ok(!html.includes('attach-file-open'), 'no download affordance on the inert chip')
  assert.ok(html.includes('old.zip'), 'the name still shows')
})
