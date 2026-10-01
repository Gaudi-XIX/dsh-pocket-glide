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

test('a reconnect snapshot merges with buffered events instead of replacing them', () => {
  const html = renderMobilePage({ locale: 'zh' })
  // SSE auto-reconnect re-sends a snapshot carrying only the last turn window.
  // The buffer must always merge by seq, or older turns vanish ("前面的消息
  // 突然就不见了" reported right after sending a message).
  assert.ok(
    html.includes('streamEvents=mergeEntries(streamEvents.concat(incoming))'),
    'snapshot records must merge into the existing buffer',
  )
  assert.ok(
    !html.includes('streamSinceSeq>=0?mergeEntries(streamEvents.concat(incoming)):incoming'),
    'non-handoff snapshots must not replace the buffer wholesale',
  )
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

// Minor-1: Esc closes the open sheet; focus moves into the sheet on open and
// back to the opener on close. The inline script never runs under Node, so the
// assertions target the emitted handler/binding source.
test('plus sheet wires Escape-to-close and open/close focus management', () => {
  const html = renderMobilePage({ locale: 'zh' })
  // A document-level keydown handler handles Escape only while the sheet is open.
  assert.ok(html.includes("document.addEventListener('keydown'"), 'document keydown handler must be bound')
  assert.ok(html.includes("e.key!=='Escape'||!plusOpen()"), 'Escape must be ignored unless the sheet is open')
  // openPlus remembers the previously focused element and focuses #plusFilter.
  assert.ok(html.includes('plusPreviousFocus=document.activeElement'), 'openPlus must record the previous focus')
  assert.ok(html.includes("$('plusFilter').focus()"), 'openPlus must move focus to #plusFilter')
  // closePlus restores focus to the recorded opener.
  assert.ok(html.includes('opener?.focus()'), 'closePlus must restore focus to the opener')
})

// Minor-2: filter text includes the stable command name so typing an English
// name (goal/compact/...) in the zh locale still matches.
test('plus rows carry a name field and root filtering matches against it', () => {
  const html = renderMobilePage({ locale: 'zh' })
  // Every row declares its stable name.
  for (const name of ['file', 'goal', 'plan', 'feedback', 'compact', 'permission', 'model', 'export']) {
    assert.ok(html.includes(`{id:'${name}',name:'${name}',`), `row ${name} must declare name`)
  }
  // The filter concatenates title + desc + name.
  assert.ok(
    html.includes("(r.title+' '+r.desc+' '+(r.name||'')).toLowerCase().includes(q)"),
    'filter text must include the row name'
  )
})

// Minor-3: addImageDrafts validates the whole batch (count/type/per-file/total)
// before committing anything; on failure no partial drafts remain.
test('addImageDrafts validates the full batch before pushing drafts or starting readers', () => {
  const html = renderMobilePage({ locale: 'zh' })
  const aggregateCheck = html.indexOf('aggregate+file.size>limits.maxMessageImageBytes')
  const commit = html.indexOf('for(const draft of accepted)composerDrafts.push(draft)')
  assert.ok(aggregateCheck >= 0, 'aggregate total validation must exist')
  assert.ok(commit > aggregateCheck, 'drafts must be pushed only after the aggregate check passes')
  // The old push-inside-the-validation-loop pattern must be gone.
  assert.ok(
    !html.includes('composerDrafts.push(draft);accepted.push(draft)'),
    'drafts must not be pushed inside the validation loop'
  )
  // FileReaders start only after the batch commit.
  const reader = html.indexOf('new FileReader()')
  assert.ok(reader > commit, 'FileReaders must start only after drafts are committed')
})

// Minor-5: an attachment-only message must not carry an empty text block.
test('send() omits the text content block when there is no text', () => {
  const html = renderMobilePage({ locale: 'zh' })
  assert.ok(
    html.includes('[...(text?[{type:\'text\',text}]:[]),...parts]'),
    'content must include the text block only when text is non-empty'
  )
  assert.ok(
    !html.includes('const content=[{type:\'text\',text},...parts]'),
    'the unconditional empty-text block must be removed'
  )
})
