// Guard: every "locate one code point" anchor used by the W2a-era tests must hit
// EXACTLY ONCE in the shipped zh and en page assets (mobilePageAssets().js).
//
// Why: W2a stripped comments from the shipped shell, so multiple tests switched
// from "anchor lives in a comment we control" to "anchor string appears in the
// shipped js". That only proves the right code point was found if the anchor is
// UNIQUE in the shipped bytes — a duplicated anchor can match a different site
// than the one the test means to pin. This file keeps the anchor list in ONE
// array so future anchors are added (and counted) here.
//
// Rules for adding an anchor: it must be semantically a "locate this one spot"
// anchor (not a count assertion like `content-visibility:auto` appearing once,
// which is already its own count test, and not a loose substring like
// `closeSessionSettings()` which legitimately appears 8 times as call sites).
// Run: node --test test/asset-anchor-uniqueness.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { mobilePageAssets } from '../lib/pages.js'

// [anchor string, source test file:line]
const ANCHORS = [
  // test/mobile-assets.test.js — slice() start/end anchors
  ['function evictSessionCache()', 'test/mobile-assets.test.js:188'],
  ['function renderBlock(', 'test/mobile-assets.test.js:188'],
  ['async function showSessionList()', 'test/mobile-assets.test.js:198'],
  ['function scheduleViewportFill()', 'test/mobile-assets.test.js:221'],
  ["document.addEventListener('visibilitychange'", 'test/mobile-assets.test.js:221'],
  ['function armStreamRetry(sessionId)', 'test/mobile-assets.test.js:257'],
  ['function armStreamStaleWatch(sessionId)', 'test/mobile-assets.test.js:257'],
  ['function showTranscriptRetry()', 'test/mobile-assets.test.js:291'],
  ['async function rpc(', 'test/mobile-assets.test.js:305'],
  ['function isStreamDownCopy(text)', 'test/mobile-assets.test.js:305'],
  ['function rpcFailure(body,status)', 'test/mobile-assets.test.js:322'],
  ['function closeSessionStream(', 'test/mobile-assets.test.js:390'],
  ['function applyHistory(', 'test/mobile-assets.test.js:390'],
  ['function sheetFocusables(){', 'test/mobile-assets.test.js:553'],
  ['function openPlus(){', 'test/mobile-assets.test.js:553'],
  ['function closePlus(', 'test/mobile-assets.test.js:561'],
  ['function fieldText(', 'test/mobile-assets.test.js:658'],
  ['function renderSessionSettings(', 'test/mobile-assets.test.js:658'],
  ['function scheduleViewport()', 'test/mobile-assets.test.js (regex)'],
  ['function applyViewportHeight()', 'test/mobile-assets.test.js (regex)'],
  // test/pick-toggle-anchor-restore.test.js — slice() anchors
  ['function togglePickField(field){', 'test/pick-toggle-anchor-restore.test.js:31'],
  ['function applyPick(field,value)', 'test/pick-toggle-anchor-restore.test.js:31'],
  ['function restoreTranscriptAnchor(box,anchor,tries,turn){', 'test/pick-toggle-anchor-restore.test.js:86'],
  ['function settleOlderShift(box,anchor,tries,turn){', 'test/pick-toggle-anchor-restore.test.js:86'],
  ['function settleTailStick(box,tries,turn,pinned){', 'test/pick-toggle-anchor-restore.test.js:179'],
  ["(()=>{const box=$('messages');if(!box)return;box.addEventListener('scroll'", 'test/pick-toggle-anchor-restore.test.js:264'],
  ['function settlePromptJump(box,anchor,tries){', 'test/pick-toggle-anchor-restore.test.js:365'],
  ["$('scrollAnchors').onclick=", 'test/pick-toggle-anchor-restore.test.js:365'],
  // test/error-visibility.test.js — between()/extractUntil() anchors
  ['async function loadHistory(initial,force)', 'test/error-visibility.test.js:310'],
  ['const FALLBACK_IMAGE_LIMITS', 'test/error-visibility.test.js:310'],
  ['function renderTunnelWarning(expiresAt)', 'test/error-visibility.test.js:501'],
  ['function formatDeviceExpiryTime', 'test/error-visibility.test.js:501'],
  ['function setStatusCopy(text)', 'test/error-visibility.test.js:515'],
  ['function applyLiveStatus(body)', 'test/error-visibility.test.js:528'],
  ['function openSessionStream(sessionId)', 'test/error-visibility.test.js:678'],
  ["source.addEventListener('status'", 'test/error-visibility.test.js:689'],
  ["source.addEventListener('snapshot'", 'test/error-visibility.test.js:689'],
  ["source.addEventListener('event'", 'test/error-visibility.test.js:830'],
  ['source.onerror=()=>{', 'test/error-visibility.test.js:827'],
  ["box.addEventListener('touchstart'", 'test/error-visibility.test.js:841'],
  ["box.addEventListener('touchmove'", 'test/error-visibility.test.js:841'],
  ['function olderButtonHtml()', 'test/error-visibility.test.js:847'],
  ['function paintMessages(', 'test/error-visibility.test.js:847'],
  ['async function ensureTranscriptFilled()', 'test/error-visibility.test.js:849'],
  ['function oldestEventSeq()', 'test/error-visibility.test.js:849'],
  ['function loadingShell()', 'test/error-visibility.test.js:820'],
  ['const STREAM_CODE_COPY=', 'test/error-visibility.test.js:119'],
  ['STREAM_DOWN_COOLDOWN_MS=', 'test/error-visibility.test.js:122'],
  ['STREAM_DOWN_STABLE_MS=', 'test/error-visibility.test.js:123'],
  ['const SSE_KEEPALIVE_MS=', 'test/error-visibility.test.js:655'],
  ['const BRIDGE_TRANSPORT_CODES=', 'test/error-visibility.test.js:857'],
  // test/stream-watermark.test.js — between()/extractFunction() anchors
  ['const streamWatermarks=new Map()', 'test/stream-watermark.test.js:80'],
  ['function streamWatermark(sessionId)', 'test/stream-watermark.test.js:81'],
  ['function transcriptHasContent(){', 'test/stream-watermark.test.js:123'],
  // test/send-pending-ledger.test.js — between() anchors
  ['const SEND_KEY=', 'test/send-pending-ledger.test.js:85'],
  ['}catch(e){stashTake(owner)', 'test/send-pending-ledger.test.js:86'],
  ['async function send(', 'test/send-pending-ledger.test.js:85'],
  ['function stashSend(', 'test/send-pending-ledger.test.js:208'],
  ['function stashTake(', 'test/send-pending-ledger.test.js:209'],
  ['function resumeSend(', 'test/send-pending-ledger.test.js:210'],
  ['function applyRunningMarks(', 'test/send-pending-ledger.test.js:144'],
  ['function openSession(', 'test/send-pending-ledger.test.js:150'],
  ['function attachFailureCopy(', 'test/send-pending-ledger.test.js:206'],
  // test/pages-scroll-anchors.test.js — regex extraction anchors
  ['UNREAD_RECENCY_MS=', 'test/pages-scroll-anchors.test.js:386'],
  ['LAST_MESSAGE_KEY=', 'test/pages-scroll-anchors.test.js:494'],
]

const count = (haystack, needle) => haystack.split(needle).length - 1

for (const locale of ['zh', 'en']) {
  test(`anchor uniqueness in shipped ${locale} js`, () => {
    const js = mobilePageAssets({ locale }).js
    for (const [anchor, source] of ANCHORS) {
      assert.equal(
        count(js, anchor), 1,
        `anchor ${JSON.stringify(anchor)} (${source}) must hit exactly once in the shipped ${locale} js, got ${count(js, anchor)}`,
      )
    }
  })
}
