// Coverage #8 pages send() mode — RENDER/SOURCE-LEVEL (no DOM needed).
// pages.js is plain ESM importable under Node; the send() function exists as
// emitted inline <script> text inside renderMobilePage, never executed here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderMobilePage, renderMobileReconnectPage } from '../lib/pages.js'

test('mobile page send() issues session/prompt with mode queue, not steer', () => {
  const html = renderMobilePage({ locale: 'zh' })
  assert.ok(html.includes("mode:'queue'"), 'send() must use queue mode')
  assert.ok(!html.includes("mode:'steer'"), 'send() must not use steer mode')
  // Sanity: the prompt call itself is present.
  assert.ok(html.includes("rpc('session.prompt'"))
})

test('mobile page exposes EventSource on the real stream endpoint', () => {
  const html = renderMobilePage({ locale: 'zh' })
  assert.ok(html.includes("new EventSource('/api/session/stream?sessionId='"))
})

test('mobile reconnect page is importable and returns non-empty markup', () => {
  const html = renderMobileReconnectPage('zh', 'lan')
  assert.ok(html.length > 100)
  assert.match(html, /<!doctype html>/)
})
