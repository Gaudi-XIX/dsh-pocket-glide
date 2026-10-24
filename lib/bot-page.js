/**
 * The Bot page: the phone's own window on the DS Bot team.
 *
 * Why a page of its own instead of a card on the landing (user 2026-10-24:
 * 「在 pocket 页面右下角加一个浮窗…点击后进入 dsbot 页面」 + 「DS BOT 不在主页
 * 的会话里面显示，只在点进去 DS BOT 的那个页面里面显示」):
 *
 *   - The landing no longer carries that workspace at all (bridge.js
 *     `withoutWorkspaceRows`), so its conversations have to live somewhere.
 *   - The team's member list and its groups are not DSH sessions of the
 *     landing's kind — they come from `POST /api/bot` (`bot.team`), which the
 *     landing has no room for.
 *
 * Deliberate choices:
 *   - This shell is NOT part of `mobilePageAssets()`. The landing's byte budget
 *     (`test/mobile-assets.test.js`, `ASSET_BUDGET_BYTES`) covers the landing's
 *     own css+js only; a separate route that a phone opens on demand is what
 *     keeps the landing at its current weight and this page free to grow.
 *     It reuses `/app.css` for the type scale and the palette, so the two
 *     screens look like one product without duplicating a stylesheet.
 *   - Group history needs no endpoint of its own: a group's id IS a Session id
 *     (ds-bot `src/host/roster.js:344-348`), so `session.history` reads it and
 *     `session.prompt` posts into it — the same two methods the landing already
 *     uses, no new write surface.
 *   - A member's chat is `bot.sessionId` (its current own-chat part). A long
 *     chat hands its context on and starts a fresh part, so that one part holds
 *     only the newest exchange. Two kinds of "before" stack above it on open:
 *     the rest of this part (`session.history` + `beforeSeq`, paged newest
 *     first) and then the parts before it (`bot.earlier`, ds-bot
 *     src/host/parts.js earlierPage — the same endpoint the landing's
 *     earlier-parts feed reads). Stopping at the newest page alone made a year
 *     of history look like it never happened.
 *   - The page script avoids template literals on purpose: it is embedded in a
 *     String.raw block, where `${` and backticks cannot be escaped cleanly.
 */

/**
 * The Bot page's script.
 *
 * @type {string}
 */
export const BOT_PAGE_JS = String.raw`
(function () {
  'use strict'

  var $ = function (id) { return document.getElementById(id) }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    })
  }

  var state = {
    team: null,
    chat: null,      // { id, title, kind: 'room' | 'bot', latest, older, cursor, earlierDone, olderBusy }
    busy: false,
    listTimer: null,
    chatTimer: null,
    loading: false
  }

  // ---- transport -----------------------------------------------------------

  function rpc(method, payload) {
    return fetch('/api/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: method, payload: payload || {} })
    }).then(function (response) {
      return response.json().catch(function () { return null }).then(function (body) {
        if (!response.ok || !body || !body.ok) {
          var message = body && body.error && body.error.message ? body.error.message : ('请求失败 ' + response.status)
          var error = new Error(message)
          error.code = body && body.error ? body.error.code : null
          throw error
        }
        return body.value
      })
    })
  }

  function toast(text) {
    var node = $('bpToast')
    node.textContent = text
    node.hidden = false
    clearTimeout(toast.timer)
    toast.timer = setTimeout(function () { node.hidden = true }, 2600)
  }

  // ---- the team list -------------------------------------------------------

  function avatarOf(bot) {
    // ds-bot avatars are a character (a shape id) or an image; the phone draws
    // the member's initial on the brand chip, which is what the desktop sidebar
    // does for every member without an uploaded picture.
    return esc(String(bot.name || '?').trim().charAt(0) || '?')
  }

  function renderTeam() {
    var team = state.team
    if (!team) return
    var bots = Array.isArray(team.bots) ? team.bots : []
    var rooms = Array.isArray(team.rooms) ? team.rooms : []
    var mainIds = Array.isArray(team.mainBotIds) ? team.mainBotIds : []

    var pending = []
    var approvals = team.work && Array.isArray(team.work.approvals) ? team.work.approvals : []
    for (var i = 0; i < approvals.length; i += 1) {
      var row = approvals[i] || {}
      if (!row.id) continue
      // The shape is ds-bot src/host/approvals.js:21-30 — { id, sessionId, botId,
      // roomId?, tool, reason, detail: { text?, code? }, at, answerable }.
      var who = ''
      for (var w = 0; w < bots.length; w += 1) {
        if (bots[w] && bots[w].id === row.botId) { who = String(bots[w].name || ''); break }
      }
      var headline = (who ? who + ' · ' : '') + (row.tool || '工具请求')
      var body = (row.detail && typeof row.detail.text === 'string' && row.detail.text) || row.reason || ''
      pending.push('<div class="bp-pending-row"><b>' + esc(headline) + '</b>' +
        (body ? '<span>' + esc(body) + '</span>' : '') +
        (row.answerable === true
          ? '<span class="bp-actions"><button type="button" class="bp-allow" data-approve="allow" data-id="' + esc(row.id) + '">允许</button>' +
            '<button type="button" class="bp-reject" data-approve="reject" data-id="' + esc(row.id) + '">拒绝</button></span>'
          : '<span>这条要在电脑上回答</span>') +
        '</div>')
    }
    // The bridge sends this as { count: N } — the roster's own keys are session
    // ids, and the page only needs the number (a count of open questions).
    var questions = 0
    if (team.questions && typeof team.questions === 'object') {
      questions = typeof team.questions.count === 'number' ? team.questions.count : Object.keys(team.questions).length
    }
    if (questions > 0) pending.push('<div class="bp-pending-row">' + questions + ' 个问题等你回答</div>')

    var html = ''
    if (pending.length) {
      html += '<section class="bp-section"><h2>待处理</h2><div class="bp-pending">' + pending.join('') + '</div></section>'
    }

    html += '<section class="bp-section"><h2>群聊 <span class="bp-count">' + rooms.length + '</span></h2>'
    if (!rooms.length) {
      html += '<p class="bp-empty">还没有群。在电脑上建一个群，这里就会出现。</p>'
    } else {
      html += '<div class="bp-list">'
      for (var r = 0; r < rooms.length; r += 1) {
        var room = rooms[r] || {}
        var members = Array.isArray(room.members) ? room.members.length : 0
        html += '<button class="bp-row" data-open="room" data-id="' + esc(room.id) + '" data-title="' + esc(room.name || '群聊') + '">' +
          '<span class="bp-chip">群</span>' +
          '<span class="bp-copy"><b>' + esc(room.name || '群聊') + '</b>' +
          '<span class="bp-sub">' + members + ' 个成员' + (room.preview ? ' · ' + esc(room.preview) : '') + '</span></span>' +
          '<span class="bp-chev">›</span></button>'
      }
      html += '</div>'
    }
    html += '</section>'

    html += '<section class="bp-section"><h2>成员 <span class="bp-count">' + bots.length + '</span></h2><div class="bp-list">'
    for (var b = 0; b < bots.length; b += 1) {
      var bot = bots[b] || {}
      if (!bot.sessionId) continue
      var isMain = mainIds.indexOf(bot.id) >= 0
      html += '<button class="bp-row" data-open="bot" data-id="' + esc(bot.id) + '" data-sid="' + esc(bot.sessionId) + '" data-title="' + esc(bot.name || 'Bot') + '">' +
        '<span class="bp-avatar">' + avatarOf(bot) + '</span>' +
        '<span class="bp-copy"><b>' + esc(bot.name || 'Bot') + (isMain ? '<span class="bp-tag">主</span>' : '') + '</b>' +
        '<span class="bp-sub">' + esc(bot.role || '') + '</span></span>' +
        '<span class="bp-chev">›</span></button>'
    }
    html += '</div></section>'

    $('bpList').innerHTML = html
  }

  function loadTeam(quiet) {
    if (state.loading) return
    state.loading = true
    if (!quiet) $('bpHint').textContent = '读取中…'
    rpc('bot.team', {}).then(function (team) {
      state.team = team
      $('bpHint').textContent = ''
      renderTeam()
    }).catch(function (error) {
      $('bpHint').textContent = '连不上 DS Bot：' + (error.message || '未知原因')
    }).then(function () {
      state.loading = false
    })
  }

  /**
   * Answer one approval card. state.work.approvals only marks a card
   * answerable when the Host will take the answer from a chat (approvals.js:50
   * — a Bot's own chat keeps DSH's card instead), so the buttons are drawn from
   * that flag and the Host re-checks on arrival: a card that closed meanwhile
   * answers bot/stale, which shows as a toast and brings the fresh list.
   */
  function answerApproval(id, choice, button) {
    if (!id) return
    button.disabled = true
    rpc('bot.approval', { id: id, choice: choice }).then(function () {
      toast(choice === 'allow' ? '已允许' : '已拒绝')
      loadTeam(true)
    }).catch(function (error) {
      button.disabled = false
      toast('没答上：' + (error.message || '未知原因'))
      loadTeam(true)
    })
  }

  // ---- one conversation ----------------------------------------------------

  function textOf(content) {
    if (!Array.isArray(content)) return ''
    var parts = []
    for (var i = 0; i < content.length; i += 1) {
      var block = content[i]
      if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
    return parts.join('\n').trim()
  }

  /**
   * The Host's own event number, or -1 when the record carries none.
   * @param {unknown} entry
   * @returns {number}
   */
  function pageSeq(entry) {
    var event = (entry && entry.event) || entry || {}
    return typeof event.seq === 'number' ? event.seq : -1
  }

  /**
   * The two roles this page draws. Tool rows, reasoning folds and the turn
   * machinery belong to the landing's transcript, which has a component for
   * each; the Bot page only has to show what was said.
   *
   * The oldest seq in the page rides back with the rows because one part can
   * itself be longer than one call returns: session.history pages backwards
   * with beforeSeq, and that seq is where the next page starts.
   * @param {unknown} records
   * @returns {{ rows: Array<{ role: string, text: string }>, oldestSeq: number }}
   */
  function readPage(records) {
    var rows = []
    var oldestSeq = -1
    if (!Array.isArray(records)) return { rows: rows, oldestSeq: oldestSeq }
    var order = records.slice()
    // Two other readers of this same Host data sort by seq before drawing
    // (lib/projections.js fitTailToScreen, lib/pages.js mergeEntries), both
    // because they do not trust the array order. A page handed back out of
    // order would otherwise draw sixty messages backwards. Rows without a seq
    // keep their place: comparing them yields 0 and the sort is stable.
    order.sort(function (a, b) {
      var left = pageSeq(a)
      var right = pageSeq(b)
      if (left < 0 || right < 0) return 0
      return left - right
    })
    for (var i = 0; i < records.length; i += 1) {
      var seq = pageSeq(records[i])
      if (seq >= 0 && (oldestSeq < 0 || seq < oldestSeq)) oldestSeq = seq
    }
    for (var j = 0; j < order.length; j += 1) {
      var record = order[j] || {}
      var event = record.event || record
      var data = event.data || {}
      var type = String(event.type || '').toLowerCase()
      if (type === 'user/message') {
        var message = data.message || data
        if (message && message.source && message.source.kind === 'user') {
          var said = textOf(message.content)
          if (said) rows.push({ role: 'user', text: said })
        }
      } else if (type === 'assistant/message') {
        var answer = textOf(data.message && data.message.content)
        if (answer) rows.push({ role: 'assistant', text: answer })
      }
    }
    return { rows: rows, oldestSeq: oldestSeq }
  }

  function renderChat() {
    var chat = state.chat
    if (!chat) return
    $('bpChatTitle').textContent = chat.title
  }

  // How much of one conversation opening fills in before it stops reaching
  // back, and how many pages that may cost. Two kinds of "before" stack here:
  // the part the page is pointed at can itself be longer than one page (read
  // further back with session.history+beforeSeq), and the parts before it are
  // bot.earlier. A Bot switches part often and a fresh part can hold a single
  // exchange — reading only the newest page made a year of history look like it
  // never happened (user 2026-10-24: 「看不到这个 Chief 之前的聊天记录」).
  var PART_PAGE = 60
  var FILL_ROWS = 60
  var FILL_HOPS = 6

  /**
   * One bot.earlier item as a row this page draws. The Host already decided
   * what is showable (ds-bot src/host/parts.js displayItems drops handoff lines
   * and turned-over exchanges), so this only picks the kinds the page has a
   * shape for: a divider marks where one part begins, an event names another
   * Bot that wrote in, everything else shows its text.
   * @param {unknown} items
   * @returns {Array<{ role: string, text: string }>}
   */
  function earlierRows(items) {
    var out = []
    if (!Array.isArray(items)) return out
    for (var i = 0; i < items.length; i += 1) {
      var item = items[i] || {}
      var kind = String(item.kind || '')
      if (kind === 'divider') { out.push({ role: 'divider', text: '' }); continue }
      if (kind === 'user') { if (item.text) out.push({ role: 'user', text: String(item.text) }); continue }
      if (kind === 'event') {
        var who = item.name || item.role || ''
        if (who) out.push({ role: 'event', text: '· ' + String(who) })
        continue
      }
      if (item.text) out.push({ role: 'assistant', text: String(item.text) })
    }
    return out
  }

  /**
   * Draw what is loaded: the part being read, with the earlier parts above it.
   * The button on top is the one place a reader asks for more — opening a
   * conversation only fills a few screens (FILL_ROWS rows), not all of them.
   */
  function paintChat() {
    var chat = state.chat
    if (!chat) return
    var box = $('bpMsgs')
    var stick = box.scrollHeight - box.scrollTop - box.clientHeight < 60
    var html = ''
    if (chat.kind === 'bot' && !chat.earlierDone) {
      html += '<button class="bp-older" type="button" data-earlier="1"' + (chat.olderBusy ? ' disabled' : '') + '>' +
        esc(chat.olderBusy ? '正在加载更早的记录…' : '加载更早的记录') + '</button>'
    }
    var rows = chat.older.concat(chat.latest)
    if (!rows.length) {
      box.innerHTML = html + '<p class="bp-empty">这里还没有消息。</p>'
      return
    }
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i] || {}
      if (row.role === 'divider') { html += '<div class="bp-divider"><span>更早的记录</span></div>'; continue }
      if (row.role === 'event') { html += '<div class="bp-event">' + esc(row.text) + '</div>'; continue }
      html += '<div class="bp-msg ' + row.role + '">' + esc(row.text) + '</div>'
    }
    box.innerHTML = html
    if (stick) box.scrollTop = box.scrollHeight
  }

  /**
   * Whether a cursor the Host handed back is the one it was given. The bridge
   * re-makes that object on every hop (lib/bridge.js earlierCursor returns a
   * fresh {part, beforeSeq}), so the two values are never the same reference:
   * identity would always say "moved on" and the guard would do nothing. The
   * shape is the bridge's own: part is a non-negative integer, beforeSeq is
   * that or absent.
   * @param {unknown} left
   * @param {unknown} right
   * @returns {boolean}
   */
  function sameCursor(left, right) {
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
    return left.part === right.part && left.beforeSeq === right.beforeSeq
  }

  /**
   * Read the newest page of the part the page is pointed at — a Bot's current
   * own-chat part, or a group's own Session. hasMore says the part holds more
   * of its own before this page; the parts before it are bot.earlier.
   * @param {{ id: string }} chat
   * @returns {Promise<{ rows: Array<{ role: string, text: string }>, oldestSeq: number, hasMore: boolean }>}
   */
  function readPart(chat) {
    return rpc('session.history', { sessionId: chat.id, maxMessages: PART_PAGE }).then(function (value) {
      var page = readPage(value && value.events)
      return { rows: page.rows, oldestSeq: page.oldestSeq, hasMore: !!(value && value.hasMore === true) }
    })
  }

  /**
   * One page further back, prepended above what is already drawn. Two sources,
   * in this order: the rest of this part (session.history + beforeSeq), then
   * the parts before it (bot.earlier, cursor-paged newest-first). The cursor is
   * opaque here: the bridge checks its shape and the Host reads a wrong one as
   * the first page.
   * @param {any} chat
   * @returns {Promise<boolean>} whether the page had anything in it
   */
  function loadEarlier(chat) {
    if (!chat || chat.olderBusy || chat.earlierDone) return Promise.resolve(false)
    // Read the scroll box before painting the busy state: repainting first and
    // measuring after would compare against a box that already moved.
    var box = $('bpMsgs')
    var beforeHeight = box.scrollHeight
    var beforeTop = box.scrollTop
    chat.olderBusy = true
    paintChat()
    var leg
    if (chat.hasMore) {
      // Still inside the part being read: walk back within it first, or the
      // record would jump from the part's newest page straight to the part
      // before it, losing everything in between.
      var payload = { sessionId: chat.id, maxMessages: PART_PAGE }
      if (chat.oldestSeq > 0) payload.beforeSeq = chat.oldestSeq
      leg = rpc('session.history', payload).then(function (value) {
        if (state.chat !== chat) return false
        var page = readPage(value && value.events)
        // A page that brings no older seq is not progress. A Host that keeps
        // claiming hasMore while handing back the page just read would stack
        // the same rows on every tap, so this leg ends instead (the landing
        // guards the same thing: lib/pages.js fetchOlderPage).
        if (page.oldestSeq <= 0 || (chat.oldestSeq > 0 && page.oldestSeq >= chat.oldestSeq)) {
          chat.hasMore = false
          return false
        }
        chat.hasMore = !!(value && value.hasMore === true)
        chat.oldestSeq = page.oldestSeq
        if (page.rows.length) chat.older = page.rows.concat(chat.older)
        return page.rows.length > 0
      })
    } else {
      leg = rpc('bot.earlier', { sessionId: chat.id, cursor: chat.cursor }).then(function (value) {
        if (state.chat !== chat) return false
        var items = Array.isArray(value && value.items) ? value.items : []
        var next = value && value.cursor ? value.cursor : null
        // Same cursor handed back means the next call would read this page
        // again: treat it as the end rather than stack it on every tap.
        var stalled = sameCursor(next, chat.cursor)
        chat.cursor = next
        chat.earlierDone = !next || stalled
        if (items.length && !stalled) chat.older = earlierRows(items).concat(chat.older)
        return items.length > 0 && !stalled
      })
    }
    return leg.catch(function (error) {
      toast('读不到更早的记录：' + (error.message || '未知原因'))
      return false
    }).then(function (more) {
      if (state.chat !== chat) return more
      chat.olderBusy = false
      paintChat()
      // Reading further back must not move what the reader is looking at.
      box.scrollTop = beforeTop + (box.scrollHeight - beforeHeight)
      return more
    })
  }

  /**
   * Open a conversation: the newest page of the part it names, then — for a
   * Bot — as many pages back as it takes to fill one screen, this part first
   * and then the parts before it. Each leg paints as it arrives, so the second
   * one being slow never hides the first.
   */
  function loadChat() {
    var chat = state.chat
    if (!chat) return Promise.resolve()
    return readPart(chat).then(function (page) {
      if (state.chat !== chat) return
      chat.latest = page.rows
      chat.hasMore = page.hasMore
      chat.oldestSeq = page.oldestSeq
      paintChat()
      if (chat.kind !== 'bot') return
      var hops = 0
      var step = function () {
        if (state.chat !== chat) return Promise.resolve()
        if (chat.earlierDone || chat.olderBusy) return Promise.resolve()
        if (chat.older.length + chat.latest.length >= FILL_ROWS || hops >= FILL_HOPS) return Promise.resolve()
        hops += 1
        return loadEarlier(chat).then(function (more) { return more ? step() : undefined })
      }
      return step()
    }).catch(function (error) {
      // The reader may have moved on while this read was in flight; the error
      // belongs to the conversation it was asked for, not to the one on screen.
      if (state.chat !== chat) return
      $('bpMsgs').innerHTML = '<p class="bp-empty">' + esc('读不到消息：' + (error.message || '未知原因')) + '</p>'
    })
  }

  /** Re-read only the newest page, leaving the earlier pages where they are. */
  function refreshLatest() {
    var chat = state.chat
    if (!chat || chat.olderBusy) return Promise.resolve()
    return readPart(chat).then(function (page) {
      if (state.chat !== chat) return
      chat.latest = page.rows
      paintChat()
    }).catch(function () {})
  }

  function send() {
    var chat = state.chat
    var field = $('bpPrompt')
    var text = field.value.trim()
    if (!chat || !text || state.busy) return
    state.busy = true
    $('bpSend').disabled = true
    rpc('session.prompt', {
      sessionId: chat.id,
      mode: 'queue',
      content: [{ type: 'text', text: text }],
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
    }).then(function () {
      field.value = ''
      field.style.height = ''
      return refreshLatest()
    }).catch(function (error) {
      toast('没发出去：' + (error.message || '未知原因'))
    }).then(function () {
      state.busy = false
      $('bpSend').disabled = false
    })
  }

  // ---- routing -------------------------------------------------------------

  function stopTimers() {
    if (state.listTimer) { clearInterval(state.listTimer); state.listTimer = null }
    if (state.chatTimer) { clearInterval(state.chatTimer); state.chatTimer = null }
  }

  function showList() {
    stopTimers()
    state.chat = null
    $('bpList').hidden = false
    $('bpMsgs').hidden = true
    $('bpComposer').hidden = true
    $('bpReload').hidden = false
    $('bpChatTitle').textContent = document.title
    loadTeam()
    state.listTimer = setInterval(function () {
      if (!document.hidden && !state.chat) loadTeam(true)
    }, 15000)
  }

  function showChat(id, title, kind) {
    stopTimers()
    state.chat = {
      id: id,
      title: title,
      kind: kind,
      latest: [],
      older: [],
      // Within the part being read: hasMore says it holds more of its own
      // before this page, oldestSeq is where the next page starts. A group is
      // one whole Session, so it has neither.
      hasMore: false,
      oldestSeq: -1,
      cursor: null,
      earlierDone: kind !== 'bot',
      olderBusy: false
    }
    $('bpList').hidden = true
    $('bpMsgs').hidden = false
    $('bpComposer').hidden = false
    $('bpReload').hidden = true
    $('bpMsgs').innerHTML = '<p class="bp-empty">读取中…</p>'
    renderChat()
    loadChat()
    state.chatTimer = setInterval(function () {
      if (!document.hidden && state.chat && !state.busy) refreshLatest()
    }, 5000)
  }

  function open(target, id, title, kind) {
    var hash = '#s=' + encodeURIComponent(id) + '&k=' + kind + '&t=' + encodeURIComponent(title)
    if (location.hash === hash) { route(); return }
    location.hash = hash
  }

  function route() {
    var hash = String(location.hash || '')
    var match = /(?:^#|[&#])s=([^&]*)/.exec(hash)
    if (!match) { showList(); return }
    var id = decodeURIComponent(match[1])
    var kindMatch = /(?:^#|[&#])k=([^&]*)/.exec(hash)
    var titleMatch = /(?:^#|[&#])t=([^&]*)/.exec(hash)
    showChat(id, titleMatch ? decodeURIComponent(titleMatch[1]) : '对话', kindMatch ? kindMatch[1] : 'room')
  }

  // ---- wiring --------------------------------------------------------------

  $('bpList').addEventListener('click', function (event) {
    // An approval card first: its two buttons sit inside the list, and a click on
    // one must never also count as opening the row it lives in.
    var answer = event.target.closest ? event.target.closest('[data-approve]') : null
    if (answer) {
      answerApproval(answer.getAttribute('data-id'), answer.getAttribute('data-approve'), answer)
      return
    }
    var row = event.target.closest ? event.target.closest('[data-open]') : null
    if (!row) return
    var kind = row.getAttribute('data-open')
    var id = kind === 'bot' ? row.getAttribute('data-sid') : row.getAttribute('data-id')
    if (!id) return
    open(kind, id, row.getAttribute('data-title') || '对话', kind)
  })

  // The phone reached this page by tapping a link on the landing, in the same tab,
  // so the way out is the way in: go back one entry in the browser history, which
  // is the landing itself. Setting a hash is not leaving the page, and a page with
  // no history entry behind it (opened from a bookmark, a notification, a fresh
  // launch) has to name the landing instead of going silent.
  $('bpBack').addEventListener('click', function () {
    if (location.hash) { location.hash = ''; return }
    if (window.history && window.history.length > 1) { window.history.back(); return }
    location.href = '/'
  })

  $('bpReload').addEventListener('click', function () { loadTeam() })
  $('bpSend').addEventListener('click', send)

  // The earlier-parts button lives inside a painted feed, so the feed itself is
  // the listener: a click is delegated to whatever data-earlier row is there.
  $('bpMsgs').addEventListener('click', function (event) {
    var earlier = event.target.closest ? event.target.closest('[data-earlier]') : null
    if (!earlier || earlier.disabled) return
    loadEarlier(state.chat)
  })

  $('bpPrompt').addEventListener('input', function (event) {
    var field = event.target
    field.style.height = 'auto'
    field.style.height = Math.min(field.scrollHeight, 132) + 'px'
  })

  $('bpPrompt').addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      send()
    }
  })

  window.addEventListener('hashchange', route)
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) return
    if (state.chat) refreshLatest()
    else loadTeam(true)
  })

  route()
})()
`

/**
 * The Bot page document.
 *
 * `/app.css` is reused rather than re-shipped: it is the landing's own sheet,
 * already in the phone's cache after the first open, and it carries the type
 * scale, the palette and the dark scheme this page needs. Everything specific
 * to the Bot page stays inline below (CSP allows `style-src 'unsafe-inline'`),
 * and the script is a `'self'` URL — so this document needs no nonce at all.
 *
 * @param {{locale?: string, cssUrl: string, jsUrl: string, icon?: string|null}} options
 * @returns {string}
 */
export function renderBotPage({ locale = 'zh', cssUrl, jsUrl, icon = null }) {
  const zh = /^zh/i.test(String(locale || ''))
  const copy = zh
    ? { title: 'DS Bot', back: '返回', reload: '刷新', placeholder: '给这里发一条消息…', send: '发送' }
    : { title: 'DS Bot', back: 'Back', reload: 'Reload', placeholder: 'Message this conversation…', send: 'Send' }
  return `<!doctype html>
<html lang="${zh ? 'zh-CN' : 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,interactive-widget=resizes-visual">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme:light)">
<meta name="theme-color" content="#141416" media="(prefers-color-scheme:dark)">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="${copy.title}">
<link rel="icon" href="${icon ? String(icon) : '/app-icon'}">
<link rel="stylesheet" href="${cssUrl}">
<title>${copy.title}</title>
<style>
  body{margin:0;background:var(--paper);color:var(--ink);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  .bp-shell{max-width:760px;height:var(--app-height,100dvh);margin:auto;display:flex;flex-direction:column;padding:calc(6px + env(safe-area-inset-top)) 14px calc(8px + env(safe-area-inset-bottom))}
  .bp-bar{flex:none;height:48px;display:flex;align-items:center;gap:8px;padding:0 2px}
  .bp-bar b{font-size:15px;font-weight:650;letter-spacing:-.01em;min-width:0;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .bp-bar .bp-hint{flex:none;max-width:45%;color:var(--muted);font-size:11.5px;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .bp-bar button{flex:none;height:38px;min-width:38px;border:1px solid var(--line);border-radius:999px;background:var(--card);color:var(--ink);padding:0 12px;font-size:13px}
  .bp-bar button:active{background:var(--hover)}
  .bp-scroll{flex:1;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;padding-bottom:10px}
  .bp-section{margin:14px 0 0}
  .bp-section h2{margin:0 0 8px 4px;font-size:12px;font-weight:650;letter-spacing:.04em;color:var(--muted)}
  .bp-count{font-weight:500}
  .bp-list{display:grid;gap:8px}
  .bp-row{display:flex;align-items:center;gap:10px;width:100%;min-height:56px;border:1px solid var(--line);border-radius:14px;background:var(--card);padding:8px 12px;text-align:left;color:var(--ink)}
  .bp-row:active{background:var(--hover)}
  .bp-avatar{flex:none;display:grid;place-items:center;width:34px;height:34px;border-radius:50%;background:color-mix(in srgb,var(--brand) 16%,var(--surface));color:var(--brand);font-weight:650;font-size:15px}
  .bp-chip{flex:none;display:grid;place-items:center;width:34px;height:34px;border-radius:11px;background:var(--surface);color:var(--muted);font-size:12px;font-weight:650}
  .bp-copy{min-width:0;flex:1;display:flex;flex-direction:column;gap:2px}
  .bp-copy b{font-size:14.5px;font-weight:600;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .bp-sub{color:var(--muted);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .bp-tag{margin-left:6px;padding:0 6px;border-radius:999px;background:color-mix(in srgb,var(--brand) 14%,var(--surface));color:var(--brand);font-size:10.5px;font-weight:650;vertical-align:1px}
  .bp-chev{flex:none;color:var(--muted);font-size:18px;line-height:1}
  .bp-pending{display:grid;gap:6px}
  .bp-pending-row{border:1px solid color-mix(in srgb,#c08400 40%,var(--line));border-radius:12px;background:color-mix(in srgb,#c08400 9%,var(--card));padding:9px 12px;font-size:13px}
  .bp-pending-row b{display:block;font-weight:600;margin-bottom:2px}
  .bp-pending-row span{color:var(--muted);font-size:12px}
  .bp-actions{display:flex;gap:8px;margin-top:8px}
  .bp-actions button{flex:1;min-height:36px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--ink);font:inherit;font-size:13px;font-weight:600}
  .bp-actions button:disabled{opacity:.55}
  .bp-allow{color:#1f8a4d;border-color:color-mix(in srgb,#1f8a4d 42%,var(--line))}
  .bp-reject{color:var(--danger,#d9484f)}
  .bp-empty{margin:10px 4px;color:var(--muted);font-size:12.5px;line-height:1.6}
  #bpMsgs{display:flex;flex-direction:column;gap:10px;padding:6px 2px 14px}
  .bp-older{align-self:center;margin:2px 0 6px;border:1px solid var(--line);border-radius:999px;background:var(--card);color:var(--muted);font:inherit;font-size:12.5px;padding:7px 16px}
  .bp-older:disabled{opacity:.6}
  .bp-divider{display:flex;align-items:center;gap:8px;margin:6px 0;color:var(--muted);font-size:11.5px}
  .bp-divider::before,.bp-divider::after{content:"";flex:1;height:1px;background:var(--line)}
  .bp-event{align-self:center;color:var(--muted);font-size:12px}
  .bp-msg{max-width:100%;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.65;font-size:14.5px}
  .bp-msg.user{align-self:flex-end;max-width:84%;background:var(--hover);border-radius:20px;padding:9px 14px}
  .bp-msg.assistant{align-self:stretch;padding:0 3px}
  .bp-composer{flex:none;display:flex;gap:8px;align-items:flex-end;border:1px solid var(--line);border-radius:22px;padding:7px 7px 7px 14px;background:var(--card);margin-top:8px}
  .bp-composer textarea{flex:1;min-height:38px;max-height:132px;border:0;outline:0;resize:none;background:transparent;color:var(--ink);font:inherit;font-size:16px;padding:8px 0;caret-color:var(--brand)}
  .bp-composer button{flex:none;height:40px;min-width:62px;border:0;border-radius:999px;background:var(--brand);color:#fff;font-size:14px;font-weight:600}
  .bp-composer button:disabled{background:var(--surface);color:var(--muted)}
  #bpToast{position:fixed;left:50%;bottom:calc(84px + env(safe-area-inset-bottom));transform:translateX(-50%);max-width:min(520px,calc(100vw - 40px));padding:9px 14px;border-radius:12px;background:#232428;color:#fff;font-size:13px;box-shadow:0 6px 20px rgba(0,0,0,.28);z-index:9}
  #bpToast[hidden]{display:none}
</style>
</head>
<body>
<div class="bp-shell">
  <header class="bp-bar">
    <button id="bpBack" aria-label="${copy.back}">‹</button>
    <b id="bpChatTitle">${copy.title}</b>
    <span class="bp-hint" id="bpHint"></span>
    <button id="bpReload">${copy.reload}</button>
  </header>
  <div class="bp-scroll" id="bpList"></div>
  <div class="bp-scroll" id="bpMsgs" hidden></div>
  <div class="bp-composer" id="bpComposer" hidden>
    <textarea id="bpPrompt" rows="1" placeholder="${copy.placeholder}"></textarea>
    <button id="bpSend">${copy.send}</button>
  </div>
</div>
<div id="bpToast" hidden></div>
<script src="${jsUrl}"></script>
</body>
</html>`
}
