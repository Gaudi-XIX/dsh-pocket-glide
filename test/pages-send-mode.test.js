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
    !html.includes('sinceSeq>=0?incoming:mergeEntries'),
    'no watermark may switch the merge off — the buffer stays append-only',
  )
  // 2026-10-02 audit WP-A1 / A-1: the negative anchor this slot held named the
  // page-wide `streamSinceSeq`, which no longer exists, so it could no longer go
  // red for the shape it was guarding (change 2026-10-02-fix-pocket-audit-remediation).
  assert.ok(!html.includes('streamSinceSeq'), 'the page-wide watermark must be gone')
})

// AC-A2 (2026-10-02 audit, P0-A): the EventSource watermark must be the opened
// session's own, resolved at open time — a value that outlives the conversation
// it was taken from filters the next session's snapshot to nothing and drops its
// committed turn/end frames on the bridge.
test('the stream asks for what only THIS session has already shown', () => {
  const html = renderMobilePage({ locale: 'zh' })
  assert.ok(!html.includes("'&sinceSeq='+streamSinceSeq"), '跨会话全局水位线必须删除')
  assert.ok(html.includes("'&sinceSeq='+sinceSeq"), 'the URL carries the per-session local')
  assert.ok(html.includes('const sinceSeq=streamWatermark(sessionId)'), 'and it comes from the per-session map')
})

test('mobile page folds one whole turn into a single turn-process container', () => {
  const html = renderMobilePage({ locale: 'zh' })
  // Closed turns render one <details class="turn-process">; live turns render .turn-process-live.
  assert.ok(html.includes('turnProcess:true'), 'closed and live process messages must be flagged turnProcess')
  // Anchor rewritten by 2026-10-07-feat-pocket-smart-scroll-anchors (W3-卡6): the
  // details class now concatenates an optional msg-hist virtualization mark, so the
  // exact literal `class="turn-process"` no longer occurs in the source. The
  // intent — a closed turn renders a foldable details prefixed turn-process — is
  // kept by matching the emission prefix instead.
  assert.ok(html.includes('<details class="turn-process'), 'closed turn renders a foldable details')
  assert.ok(html.includes("class=\"message assistant turn-process-live\""), 'live turn renders without folding')
  // Only verbose opens the fold.
  assert.ok(html.includes("transcriptView==='verbose'"), 'fold opens only in verbose view')
})

test('fold headers drive the flip by hand, not through the native webview toggle', () => {
  const html = renderMobilePage({ locale: 'zh' })
  // Older WebKit webviews refuse to toggle a <details> whose <summary> is
  // display:flex — the phone symptom "点开没反应" (live report 2026-10-09). The
  // desktop client drives its process-group header with an onClick for the same
  // reason, so the page installs a delegated tap driver in bindOpenState.
  assert.ok(html.includes("box.dataset.summaryTapBound='1'"), 'the summary tap driver is installed once per #messages')
  assert.ok(html.includes("event.preventDefault();details.open=!details.open"), 'a summary tap preventDefaults the native action and flips .open by hand')
  assert.ok(html.includes("rememberOpenState(details.dataset.openKey,details.open)"), 'the manual flip is recorded, so it survives the next repaint')
  // The driver must only own summary taps inside #messages: sheets and the
  // pairing funnel keep their own native <details> semantics.
  assert.ok(html.includes("root.closest('#messages')"), 'the driver is scoped to the transcript, not the whole document')
})

test('mobile reconnect page is importable and returns non-empty markup', () => {
  const html = renderMobileReconnectPage('zh', 'lan')
  assert.ok(html.length > 100)
  assert.match(html, /<!doctype html>/)
})

// Minor-1: Esc closes the open sheet; focus moves back to the opener on close.
// Opening the sheet must NOT focus an input (Android raises the soft keyboard
// the moment an input is focused), so the search field is opt-in: the sheet
// opens on a plain button and only a real tap swaps in #plusFilter. The inline
// script never runs under Node, so the assertions target the emitted source.
test('plus sheet wires Escape-to-close and open/close focus management', () => {
  const html = renderMobilePage({ locale: 'zh' })
  // A document-level keydown handler handles Escape only while the sheet is open.
  assert.ok(html.includes("document.addEventListener('keydown'"), 'document keydown handler must be bound')
  assert.ok(html.includes("e.key!=='Escape'||!plusOpen()"), 'Escape must be ignored unless the sheet is open')
  // openPlus remembers the previously focused element.
  assert.ok(html.includes('plusPreviousFocus=document.activeElement'), 'openPlus must record the previous focus')
  // closePlus restores focus to the recorded opener.
  assert.ok(html.includes('opener?.focus()'), 'closePlus must restore focus to the opener')
})

// Minor-1b: opening the "+" sheet must not raise the on-screen keyboard.
// The search input is hidden behind a button until the user taps it.
test('plus search field is opt-in so opening the sheet cannot raise the keyboard', () => {
  const html = renderMobilePage({ locale: 'zh' })
  // openPlus() must leave the collapsed search affordance in place.
  assert.ok(html.includes('function openPlus(){'), 'openPlus must exist')
  assert.ok(
    !html.includes("setTimeout(()=>{$('plusFilter').focus()},0)"),
    'openPlus must not focus #plusFilter — that is what pops the Android IME'
  )
  // The search input lives inside a wrapper that is hidden until requested,
  // and the collapsed affordance is a real button (a tap, not focus).
  assert.ok(html.includes('id="plusSearchRow"'), 'the search row wrapper must exist')
  assert.ok(html.includes('id="plusSearchOpen"'), 'the collapsed search button must exist')
  assert.ok(
    html.includes('<div id="plusSearchRow" class="plus-search-row" hidden>'),
    'the search row must start hidden'
  )
  assert.ok(
    html.includes('data-plus-search-open'),
    'the collapsed affordance must be wired as a tap target'
  )
  assert.ok(
    html.includes("$('plusSearchOpen').onclick=()=>plusShowSearch()"),
    'tapping the affordance must open the search field'
  )
  // Only plusShowSearch() focuses the field, and it does so after unhiding.
  const show = html.indexOf('function plusShowSearch(){plusSetSearch(true);renderPlusRoot();$(\'plusFilter\').focus()}')
  assert.ok(show >= 0, 'plusShowSearch must unhide then focus #plusFilter')
  // Leaving the search resets the query so the next open is unfiltered.
  assert.ok(
    html.includes('function plusHideSearch(){plusSetSearch(false);renderPlusRoot()}'),
    'plusHideSearch must collapse the search and re-render the full list'
  )
  // No handler may re-focus the filter without a user gesture: the Esc-return
  // and back-button paths collapse the search instead.
  assert.ok(
    !html.includes("plusView='root';$('plusFilter').hidden=false;$('plusFilter').focus()"),
    'returning to the root view must not focus the search field'
  )
  assert.ok(
    html.includes("if(back){plusView='root';plusSetSearch(false);renderPlusRoot();return}"),
    'the back button must collapse the search instead of focusing it'
  )
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
  const aggregateCheck = html.indexOf('aggregate+item.file.size>limits.maxMessageImageBytes')
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
