// Coverage #8 pages send() mode — RENDER/SOURCE-LEVEL (no DOM needed).
// pages.js is plain ESM importable under Node; the send() function exists as
// emitted inline <script> text inside renderMobilePage, never executed here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderMobilePage, renderMobileReconnectPage } from '../lib/pages.js'

test('mobile page send() inherits desktop busy-enter mode while running', () => {
  const html = renderMobilePage({ locale: 'zh' })
  // While the agent runs the mode comes from the inherited busyEnter setting
  // (queue or steer); an initial prompt on an idle session is always queued.
  assert.ok(html.includes('agentRunning?busyEnter:\'queue\''), 'send() must derive mode from busyEnter')
  assert.ok(!html.includes("mode:'queue'"), 'send() must not hard-code queue')
  // Sanity: the prompt call itself is present.
  assert.ok(html.includes("rpc('session.prompt'"))
})

test('mobile page exposes EventSource on the real stream endpoint', () => {
  const html = renderMobilePage({ locale: 'zh' })
  assert.ok(html.includes("new EventSource('/api/session/stream?sessionId='"))
})

test('mobile page folds one whole turn into a single turn-process container', () => {
  const html = renderMobilePage({ locale: 'zh' })
  // Closed turns render one <details class="turn-process">; live turns render .turn-process-live.
  assert.ok(html.includes('turnProcess:true'), 'closed and live process messages must be flagged turnProcess')
  assert.ok(html.includes("class=\"turn-process\""), 'closed turn renders a foldable details')
  assert.ok(html.includes("class=\"message assistant turn-process-live\""), 'live turn renders without folding')
  // Only verbose opens the fold.
  assert.ok(html.includes("transcriptView==='verbose'"), 'fold opens only in verbose view')
})

test('mobile reconnect page is importable and returns non-empty markup', () => {
  const html = renderMobileReconnectPage('zh', 'lan')
  assert.ok(html.length > 100)
  assert.match(html, /<!doctype html>/)
})
