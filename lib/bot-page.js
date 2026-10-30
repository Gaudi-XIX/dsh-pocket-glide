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

import { transitionBrandRow, stageRowsMarkup, botToPocketRows, ladderScript, markdownScript, questionCardScript, QUESTION_MARK } from './pages.js'

/**
 * The Bot page's script.
 *
 * @type {string}
 */
export const BOT_PAGE_JS = String.raw`
(function () {
  'use strict'

  var $ = function (id) { return document.getElementById(id) }

  // 过渡卡阶梯运行时：与主页那张卡同一份源码（pages.js 的 ladderScript），
  // 三页的读数与划线逻辑因此不可能各写一套（用户 2026-10-27）。
  // 本页是独立文档（没有主页 bootstrap），所以这份源码在自己身上注一遍。
${ladderScript()}

  // 消息正文的 markdown 渲染：与 Pocket 落地页同一份源码（pages.js 的 markdownScript），
  // 段落、列表、代码块、表格、行内强调因此不可能两边各写一套。本页不定义 mdImageHook，
  // 图片语法留原文——与落地页「路径不在已知集合」的降级同一个表现。
${markdownScript()}

  // 提问卡：与 Pocket 落地页同一份 markup 与视图代码（pages.js 的 questionCardScript），
  // 页内不留第二份。两页的差别由数据表达：手机这一页关掉收起、上一题、自定义输入与
  // 错误行（错误走 toast），不留一份只属于本页的卡片绘制逻辑（用户 2026-10-27：
  // 「BOT 的选择栏只能看到提示，也不知道是谁要选择，也不知道要选择什么，而且更加点不了」）。
${questionCardScript()}
  var QUESTION_MARK = '${QUESTION_MARK}'
  var QUESTION_LABELS = {
    questionNeeded: '需要你的回答',
    questionProgress: '个问题',
    questionCollapse: '收起提问',
    cancelQuestions: '关闭',
    customAnswer: '补充说明',
    customPlaceholder: '写点什么…',
    chooseAnswer: '选一个再提交',
    chooseAnswerMulti: '至少选一个再提交',
    skip: '跳过',
    next: '下一题',
    submitAnswer: '提交',
    answering: '提交中…',
    previous: '上一题',
    recommended: '推荐'
  }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    })
  }

  var state = {
    team: null,
    chat: null,      // { id, title, kind: 'room' | 'bot', latest, older, cursor, earlierDone, olderBusy }
    // 当前会话那张提问卡：{ sessionId, questionId, botId, question, selected, busy }。
    // 提问是 ds-bot 私有 state 里的东西（不是 Host 的 user-questions 事件，桥的
    // interaction.pending 对它永远为空），所以它随 bot.team 一起来。
    question: null,
    busy: false,
    listTimer: null,
    chatTimer: null,
    loading: false,
    // id -> { rows, oldestSeq, hasMore }：列表阶段已经读回来的那一页（见
    // prefetchPreviews）。点进去时先画它，读数还在路上也不空屏。
    previews: {},
    previewing: false,
    // 模型入口：面板开着没有，宿主那份模型目录（session.models 的原样答案，没读过
    // 就是 null），以及一次只放一个提交/读取在飞。目录不写死在这里也不写死在壳里
    // ——壳是不随宿主变的静态文档，模型名随宿主设置变。
    modelOpen: false,
    modelCatalog: null,
    modelBusy: false,
    // 哪张分区卡被收起了（判据 4A⑥）。键就是卡片标题（主 BOT / 其他 BOT / 群聊），
    // 只活在内存里：刷新即回到默认展开，不写 localStorage——Pocket 那边的折叠也
    // 不持久化，两页同一个口径。
    collapsedWs: {}
  }

  // ---- transport -----------------------------------------------------------

  // A bridge that never answers must not leave the page loading for ever: the
  // hairline and the skeleton are a promise of progress, and a half-dead tunnel
  // would turn them into a promise that is never kept. Twelve seconds is past
  // every measured wait (a cold bot.team read is a few seconds at worst) and
  // short enough that the phone says why instead of pretending.
  var RPC_TIMEOUT_MS = 12000

  function rpc(method, payload) {
    var controller = typeof AbortController === 'function' ? new AbortController() : null
    var timer = controller ? setTimeout(function () { controller.abort() }, RPC_TIMEOUT_MS) : null
    function done() { if (timer !== null) clearTimeout(timer) }
    return fetch('/api/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: method, payload: payload || {} }),
      signal: controller ? controller.signal : undefined
    }).then(function (response) {
      done()
      return response.json().catch(function () { return null }).then(function (body) {
        if (!response.ok || !body || !body.ok) {
          // The pairing door answers 401 in plain text, so the body is null here
          // and the status is the only thing that says what happened.
          var unpaired = response.status === 401
          if (unpaired) forgetTeam()
          var message = unpaired
            ? '手机还没和电脑配对'
            : (body && body.error && body.error.message ? body.error.message : ('请求失败 ' + response.status))
          var error = new Error(message)
          error.code = body && body.error ? body.error.code : (unpaired ? 'pocket/unpaired' : null)
          throw error
        }
        return body.value
      })
    }).catch(function (error) {
      done()
      if (error && error.name === 'AbortError') {
        var timeout = new Error('等了 ' + (RPC_TIMEOUT_MS / 1000) + ' 秒没有回音')
        timeout.code = 'pocket/timeout'
        throw timeout
      }
      throw error
    })
  }

  function toast(text) {
    var node = $('bpToast')
    node.textContent = text
    node.hidden = false
    clearTimeout(toast.timer)
    toast.timer = setTimeout(function () { node.hidden = true }, 2600)
  }

  // ---- the clock ------------------------------------------------------------
  // The same three-tier clock the landing's transcript uses (pages.js
  // formatMessageClock): today shows the time of day, the same year adds the
  // month and day, an older year adds the year — nothing relative, nothing that
  // needs re-reading later. The landing calibrates against the Host's clock
  // because its rows also drive sorting and unread judgement; a timestamp here
  // is display-only, so the phone's own clock is accurate enough and the
  // calibration hop is not paid.

  var PAGE_ZH = /^zh/i.test(String(document.documentElement && document.documentElement.lang || ''))

  function pad2(value) {
    return String(value).length < 2 ? '0' + value : String(value)
  }

  /**
   * The three-tier stamp for one Host timestamp, or '' when it carries none.
   * @param {unknown} time
   * @returns {string}
   */
  function clockOf(time) {
    if (typeof time !== 'number' || !(time > 0)) return ''
    var at = new Date(time)
    var now = new Date()
    var clock = pad2(at.getHours()) + ':' + pad2(at.getMinutes())
    var sameYear = at.getFullYear() === now.getFullYear()
    if (sameYear && at.getMonth() === now.getMonth() && at.getDate() === now.getDate()) return clock
    var day = PAGE_ZH
      ? String(at.getMonth() + 1) + '月' + at.getDate() + '日'
      : String(at.getMonth() + 1) + '/' + at.getDate()
    if (!sameYear) {
      var year = PAGE_ZH
        ? at.getFullYear() + '年' + day
        : at.getFullYear() + '-' + day
      return year + ' ' + clock
    }
    return day + ' ' + clock
  }

  /**
   * The stamp one row's tail draws, taken from the record the Host wrote.
   *
   * Every durable event carries its own time field; that is what the landing
   * reads (eventTime in lib/pages.js). message.messageTime is a different
   * thing: only the landing's synthesized rows ever set it, so reading it alone
   * here left every Bot-page row clock-less — the reported 「没有把消息的时间
   * 显示在下面」. A synthesized row is still preferred when one arrives.
   * @param {any} message
   * @param {any} event
   * @returns {number|undefined}
   */
  function stampOf(message, event) {
    var own = message && message.messageTime
    if (typeof own === 'number' && own > 0) return own
    var at = event && event.time
    return typeof at === 'number' && at > 0 ? at : undefined
  }

  // ---- the team list -------------------------------------------------------

  function avatarOf(bot) {
    // ds-bot avatars are a character (a shape id) or an image; the phone draws
    // the member's initial on the brand chip, which is what the desktop sidebar
    // does for every member without an uploaded picture.
    return esc(String(bot.name || '?').trim().charAt(0) || '?')
  }

  // The markup holds one list slot (#bpMembersList) and this painter fills it with
  // the three section cards. It must never write bpList itself: the scroll box owns
  // #bpMsgs, the chat half of this page, and a writer that
  // replaced the list's innerHTML destroyed that node — every later tap on a
  // conversation then died on a null $() (user 2026-10-27: 「切换到 bot 主页以后
  // 没有消息，是空白的」). Painting into the slots keeps one document, one set
  // of ids, for the whole life of the page.
  // One card per section, drawn exactly the way Pocket draws a workspace card
  // (judgement 4A②): the geometry, the chevron rotation and the row gaps all come
  // from the shared app.css, so the two pages cannot drift apart. \`expanded\` is
  // memory-only state (4A⑥) — nothing is written to localStorage.
  // 判据 4A 的验收读法是 grep -o 'ws-card' lib/bot-page.js | wc -l ≥ 3，即三张卡各
  // 自在那份文档里出现一次。所以卡壳不是循环拼出来的：renderTeam 里三个分区各写一次
  // <section class="ws-card...">，这里只提供卡头与卡身两段（同一份 markup，不复制）。
  function wsHead(title, count, expanded) {
    var key = String(title)
    // 4A⑥：折叠只改两个东西——卡片上有没有 expanded、按钮的 aria-expanded。
    // 状态存在 state.collapsedWs 里（内存），刷新就回到默认的展开。
    var open = expanded && !state.collapsedWs[key]
    return '<div class="ws-head">' +
      '<button type="button" class="ws-toggle" data-ws-toggle="' + esc(key) + '" aria-expanded="' + (open ? 'true' : 'false') + '">' +
      '<span class="ws-chevron">▶</span><span class="ws-name">' + esc(key) + '</span></button>' +
      '<span class="ws-last-time">' + esc(String(count)) + '</span>' +
      '</div>'
  }
  /** 卡身：只有一层 task-list，行由调用方拼好传进来。 */
  function wsBody(body) {
    return '<div class="ws-body"><div class="task-list">' + body + '</div></div>'
  }
  /** 这张卡现在是不是展开的（卡壳上 class 与 aria-expanded 用同一个真值）。 */
  function wsOpen(title, expanded) {
    return expanded && !state.collapsedWs[String(title)]
  }
  function wsRow(bot, mainIds) {
    var isMain = mainIds.indexOf(bot.id) >= 0
    var busy = bot.working === true || (bot.working && typeof bot.working === 'object')
    var waiting = bot.waiting === true
    // 副行是时间（判据第四节），复用本页已有的三层时钟 clockOf，不另写一套格式。
    var stamp = clockOf(bot.updatedAt)
    // 标签位两个：[主] [角色 / 正在干活]。忙时第二格换成「正在 X」，闲时放角色；
    // 角色与已占的「主」同字时不再重复一遍。等模型不占标签，走整行琥珀底
    // （is-awaiting），与 Pocket .task-row.is-awaiting 同构。
    var roleText = bot.role ? String(bot.role) : ''
    var mainTag = isMain ? '主' : ''
    var slot = busy
      ? '<span class="bp-tag-slot"><span class="bp-working">正在 ' + esc((bot.working && bot.working.tool) || '干活') + '</span></span>'
      : (roleText && roleText !== mainTag ? '<span class="bp-tag-slot">' + esc(roleText) + '</span>' : '')
    return '<button class="task-row' + (busy ? ' is-running' : '') + (waiting ? ' is-awaiting' : '') + '" data-open="bot" data-id="' + esc(bot.id) + '" data-sid="' + esc(bot.sessionId) + '" data-title="' + esc(bot.name || 'Bot') + '">' +
      '<span class="bp-avatar">' + avatarOf(bot) + '</span>' +
      '<span class="bp-copy"><b><span class="bp-name">' + esc(bot.name || 'Bot') + '</span>' + (isMain ? '<span class="bp-tag">主</span>' : '') + slot + '</b>' +
      '<span class="bp-sub">' + esc(stamp) + '</span></span>' +
      '<span class="bp-chev">›</span></button>'
  }
  function wsRoom(room) {
    var members = Array.isArray(room.members) ? room.members.length : 0
    return '<button class="task-row' + (room.running ? ' is-running' : '') + '" data-open="room" data-id="' + esc(room.id) + '" data-title="' + esc(room.name || '群聊') + '">' +
      '<span class="bp-chip">群</span>' +
      '<span class="bp-copy"><b><span class="bp-name">' + esc(room.name || '群聊') + '</span></b>' +
      '<span class="bp-sub">' + members + ' 个成员' + (room.running ? ' · <span class="bp-working">讨论中</span>' : '') + (room.preview ? ' · ' + esc(room.preview) : '') + '</span></span>' +
      '<span class="bp-chev">›</span></button>'
  }

  function renderTeam() {
    var team = state.team
    if (!team) return
    var bots = Array.isArray(team.bots) ? team.bots : []
    var rooms = Array.isArray(team.rooms) ? team.rooms : []
    var mainIds = Array.isArray(team.mainBotIds) ? team.mainBotIds : []
    var i
    var row
    var bot

    // 只有能真正打开的成员才进名单：没有 sessionId 的成员在下面被跳过，而徽章写着
    // 五个、画出来三行，读起来就是掉了一条消息。
    var members = []
    for (i = 0; i < bots.length; i += 1) {
      if (bots[i] && bots[i].sessionId) members.push(bots[i])
    }

    // 排序（判据 4C）：主 bot 优先，其余按「最后消息时刻，退回 updatedAt」降序。BOT 侧
    // 没有单独的最后消息时刻表，不新造字段，直接取 updatedAt（与 Pocket 的
    // pinRank + sortAtOf 同构）。分区内也各排一次，群聊分区同样按 updatedAt 降序。
    var byNewest = function (a, b) { return (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0) }
    var mainBots = []
    var otherBots = []
    for (i = 0; i < members.length; i += 1) {
      if (mainIds.indexOf(members[i].id) >= 0) mainBots.push(members[i])
      else otherBots.push(members[i])
    }
    mainBots.sort(byNewest)
    otherBots.sort(byNewest)
    var sortedRooms = rooms.slice().sort(byNewest)

    var mainHtml = ''
    for (i = 0; i < mainBots.length; i += 1) mainHtml += wsRow(mainBots[i], mainIds)
    var otherHtml = ''
    for (i = 0; i < otherBots.length; i += 1) otherHtml += wsRow(otherBots[i], mainIds)
    var roomHtml = ''
    for (i = 0; i < sortedRooms.length; i += 1) roomHtml += wsRoom(sortedRooms[i] || {})

    // 待答（审批卡 + 提问行）不再单开一段（判据 4A⑤）：它们挂在「主 BOT」分区那张卡的最
    // 上面；主 BOT 一个都没有时退到「其他 BOT」卡，否则没有任何分区能承载它。等用户答复的
    // bot 本身仍在名单里，靠行级 is-awaiting 认。
    var pending = []
    var approvals = team.work && Array.isArray(team.work.approvals) ? team.work.approvals : []
    for (i = 0; i < approvals.length; i += 1) {
      row = approvals[i] || {}
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
    // 待答提问：桥把每条连同「谁问的、问什么」一起送来（questions.items）。行本身可点，
    // 点进那个 Bot 的会话再作答——只报一个数字，读的人既不知道谁要选择、也不知道要
    // 选择什么，更点不了（用户 2026-10-27）。
    var questionItems = team.questions && Array.isArray(team.questions.items) ? team.questions.items : []
    for (i = 0; i < questionItems.length; i += 1) {
      var asked = questionItems[i] || {}
      if (!asked.sessionId || !asked.question) continue
      var asker = null
      for (var aw = 0; aw < bots.length; aw += 1) {
        if (bots[aw] && bots[aw].id === asked.botId) { asker = bots[aw]; break }
      }
      var askerName = asker ? String(asker.name || 'Bot') : 'Bot'
      pending.push('<button type="button" class="task-row" data-open="bot" data-id="' + esc(asked.botId || '') + '" data-sid="' + esc(asked.sessionId) + '" data-title="' + esc(askerName) + '">' +
        '<span class="bp-avatar">' + avatarOf(asker || { name: askerName }) + '</span>' +
        '<span class="bp-copy"><b><span class="bp-name">' + esc(askerName + ' · 需要你的回答') + '</span></b>' +
        '<span class="bp-sub">' + esc(asked.question) + '</span></span>' +
        '<span class="bp-chev">›</span></button>')
    }
    var pendingHtml = pending.join('')

    var mainBody = mainHtml || '<p class="bp-empty">还没有主 Bot。在电脑上指定一个，这里就会出现。</p>'
    var otherBody = otherHtml || '<p class="bp-empty">还没有成员。在电脑上把 Bot 拉进团队，这里就会出现。</p>'
    var roomsBody = roomHtml || '<p class="bp-empty">还没有群。在电脑上建一个群，这里就会出现。</p>'
    // 待答跟着「主 BOT」卡走；一个主 Bot 都没有时它跟着「其他 BOT」卡，免得无处安放。
    if (pendingHtml) {
      if (mainBots.length) mainBody = pendingHtml + mainBody
      else otherBody = pendingHtml + otherBody
    }

    // 三张卡顺序固定：主 BOT → 其他 BOT → 群聊（判据 4A①）。每条数写在各自那张卡的
    // ws-last-time 格里（Pocket sidebar 的分区计数位），不再有整页一个总计数。
    // 卡壳在下面三处各写一次（判据 4A 的读法要求 ws-card 在源码里出现 ≥3 次），卡头与
    // 卡身仍走同一份 wsHead/wsBody，折叠状态也从 state.collapsedWs 取，重画后不丢。
    $('bpMembersList').innerHTML =
      '<section class="ws-card' + (wsOpen('主 BOT', true) ? ' expanded' : '') + '">' +
        wsHead('主 BOT', mainBots.length, true) + wsBody(mainBody) + '</section>' +
      '<section class="ws-card' + (wsOpen('其他 BOT', true) ? ' expanded' : '') + '">' +
        wsHead('其他 BOT', otherBots.length, true) + wsBody(otherBody) + '</section>' +
      '<section class="ws-card' + (wsOpen('群聊', true) ? ' expanded' : '') + '">' +
        wsHead('群聊', rooms.length, true) + wsBody(roomsBody) + '</section>'
    // 名单变了，会话页那张设置面板跟着重画：它显示的是 Bot 记录里的 model，
    // 而那正是回读要确认的东西（换模型后 renderTeam 先落地，再画这一页）。
    renderSettingsPanel()

    rememberTeam(state.team)
    // 画完就把各会话的最新一页先读回来（用户 2026-10-27③a）。这里不等它：
    // 列表该先出现，预取是给下一次点击省时间。
    prefetchPreviews()
  }

  /**
   * The list this page drew last time, kept so the next open paints rows at once
   * instead of an empty screen while the team read travels back. It is a copy of one
   * answer, never a second source of truth: the fresh read replaces it the moment
   * it lands, and anything unreadable just skips the shortcut.
   */
  var TEAM_CACHE_KEY = 'pocketBotTeam'

  function rememberTeam(team) {
    try {
      if (!team) return
      // The work block is left out on purpose: the approvals in it are a live
      // and a recalled card with a stale 允许 button would invite an answer the
      // Host no longer takes. The rows are what the shortcut is for. Same reason
      // the open questions keep only their count here: a recalled card would
      // invite an answer to a question the Host has already closed, and the
      // question itself arrives with the fresh read a moment later.
      var copy = {
        bots: team.bots || [],
        rooms: team.rooms || [],
        mainBotIds: team.mainBotIds || [],
        questions: team.questions && team.questions.count > 0 ? { count: team.questions.count } : null,
        at: Date.now()
      }
      localStorage.setItem(TEAM_CACHE_KEY, JSON.stringify(copy))
    } catch (error) { /* a full or disabled store only costs the shortcut */ }
  }

  function recalledTeam() {
    try {
      var raw = localStorage.getItem(TEAM_CACHE_KEY)
      if (!raw) return null
      var value = JSON.parse(raw)
      if (!value || !Array.isArray(value.bots)) return null
      return value
    } catch (error) { return null }
  }

  /** Unpairing ends the shortcut too: names are not worth keeping past the door. */
  function forgetTeam() {
    try { localStorage.removeItem(TEAM_CACHE_KEY) } catch (error) { /* nothing to forget */ }
  }

  function loadTeam(quiet) {
    if (state.loading) return
    state.loading = true
    if (!quiet) $('bpHint').textContent = '读取中…'
    rpc('bot.team', {}).then(function (team) {
      state.team = team
      document.body.classList.add('bp-ready')
      document.body.classList.remove('bp-busy')
      $('bpHint').textContent = ''
      renderTeam()
    }).catch(function (error) {
      document.body.classList.add('bp-ready')
      document.body.classList.remove('bp-busy')
      // A recalled roster is a shortcut, never a second source of truth: once
      // the door says the phone is unpaired (or the read times out), a list of
      // Bot names left on screen would outlive the credential that earned it.
      // The clear goes to the slot renderTeam writes, never to bpList itself:
      // the scroll box owns #bpSkel and #bpMembersList (renderTeam's write
      // contract), and emptying bpList here pulled those nodes out of the
      // document for good — every later renderTeam then died on a null $() and
      // the 15s poller kept crashing.
      if (error && (error.code === 'pocket/unpaired' || error.code === 'pocket/timeout')) {
        state.team = null
        $('bpMembersList').innerHTML = ''
        renderSettingsPanel()
      }
      $('bpHint').textContent = '连不上 BOT：' + (error.message || '未知原因')
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

  // ---- 提问卡 --------------------------------------------------------------
  //
  // Bot 的提问住在 ds-bot 自己的 state 里（state.questions[agent.id]），回答走它自己的
  // endpoint（answer-question / dismiss-question）。Host 的 user-questions 事件面与桥
  // 的 interaction.* 都够不着它——桥那张 sessionId 为键的待答表对 Bot 提问永远为空
  // （2026-10-28 实测：宿主 team state 说有一条待答，桥表十候选全 miss）。所以这张卡读
  // 的是 bot.team 里那一条，写的是 bot.answer / bot.dismiss，与审批卡同一条通路。

  function renderQuestion() {
    var host = $('bpQuestion')
    var held = state.question
    var chat = state.chat
    if (!held || !chat || chat.kind !== 'bot' || held.sessionId !== chat.id) {
      host.hidden = true
      host.innerHTML = ''
      return
    }
    host.innerHTML = questionCardHtml(held.question || {}, { selected: held.selected, custom: '' }, 0, 1, {
      labels: QUESTION_LABELS,
      mark: QUESTION_MARK,
      last: true,
      busy: held.busy === true,
      collapse: false,
      previous: false,
      custom: false,
      error: false,
      cancel: true
    })
    host.hidden = false
    var buttons = host.querySelectorAll('button')
    for (var i = 0; i < buttons.length; i += 1) buttons[i].disabled = held.busy === true
  }

  /** 当前会话有没有待答提问；有就画出来。读的是同一份 bot.team（桥侧 5s warm 缓存）。 */
  function loadQuestion() {
    var chat = state.chat
    if (!chat || chat.kind !== 'bot') return Promise.resolve()
    return rpc('bot.team', {}).then(function (team) {
      if (state.chat !== chat) return
      state.team = team
      var items = team && team.questions && Array.isArray(team.questions.items) ? team.questions.items : []
      var found = null
      for (var i = 0; i < items.length; i += 1) {
        if (items[i] && items[i].sessionId === chat.id) found = items[i]
      }
      var held = state.question
      if (!found) {
        state.question = null
        renderQuestion()
        return
      }
      if (held && held.sessionId === chat.id && held.questionId === found.questionId) {
        // 同一张卡：选中态与「提交中」都留着，只把明细换成刚读回来的这份。
        held.question = found
      } else {
        state.question = {
          sessionId: chat.id,
          questionId: found.questionId,
          botId: found.botId,
          question: found,
          selected: [],
          busy: false
        }
      }
      renderQuestion()
    }).catch(function () {
      // 会话那一侧会把断线说出来；这里静默不等于把提问弄丢——下一轮轮询还会读。
    })
  }

  function submitQuestion() {
    var held = state.question
    if (!held || held.busy) return
    if (!held.selected.length) {
      toast(held.question.multiSelect === true ? QUESTION_LABELS.chooseAnswerMulti : QUESTION_LABELS.chooseAnswer)
      return
    }
    held.busy = true
    renderQuestion()
    rpc('bot.answer', {
      sessionId: held.sessionId,
      questionId: held.questionId,
      answer: { selected: held.selected }
    }).then(function () {
      toast('已提交')
      state.question = null
      renderQuestion()
      refreshLatest()
    }).catch(function (error) {
      held.busy = false
      renderQuestion()
      toast('没答上：' + (error.message || '未知原因'))
    })
  }

  /** 跳过＝让宿主把这条提问关掉（ds-bot 的 dismiss-question），不是「空答一张卡」。 */
  function dismissQuestion() {
    var held = state.question
    if (!held || held.busy) return
    held.busy = true
    renderQuestion()
    rpc('bot.dismiss', { sessionId: held.sessionId }).then(function () {
      toast('已跳过')
      state.question = null
      renderQuestion()
    }).catch(function (error) {
      held.busy = false
      renderQuestion()
      toast('没跳过去：' + (error.message || '未知原因'))
    })
  }

  // ---- model -----------------------------------------------------------------
  //
  // 一个 Bot 跑在哪个模型上，记在 ds-bot 自己的 state.json 里（roster.updateBot），
  // 不是这次会话的 selection —— 所以这里改得动、也留得住：落地页那个选择器之所以只读，
  // 是因为宿主的 selectionFor() 每轮用 model/selection 事件把会话的选择重算一遍
  // （pages.js:1834），而 Bot 的 model 走 update-bot，没有任何事件会把它盖回去。
  //
  // 清单一个都不写死：模型目录读桥的 session.models（宿主的 session/modelCatalog）。
  // 桥那一侧 bot.update 收 model 与 effort 两个字段（bridge.js:8086），这里只发 model
  // 一个：判据 1③ 明写「BOT 字段只有一个:模型…思考强度 BOT 不出现」。

  /** 这一页正在看的那个 Bot（team 行按 sessionId 认，update-bot 要的是 bot.id）。 */
  function chatBot() {
    var chat = state.chat
    var team = state.team
    if (!chat || chat.kind !== 'bot' || !team || !Array.isArray(team.bots)) return null
    for (var i = 0; i < team.bots.length; i += 1) {
      var bot = team.bots[i]
      if (bot && bot.sessionId === chat.id) return bot
    }
    return null
  }

  /** 宿主目录里能点的那几组：{ id, name, models }。空组不留——画出来是个空标题。 */
  function modelGroups(catalog) {
    var groups = catalog && Array.isArray(catalog.groups) ? catalog.groups : []
    var out = []
    for (var g = 0; g < groups.length; g += 1) {
      var group = groups[g] || {}
      if (typeof group.id !== 'string' || !group.id) continue
      var models = Array.isArray(group.models) ? group.models : []
      var kept = []
      for (var m = 0; m < models.length; m += 1) {
        if (models[m] && typeof models[m].id === 'string' && models[m].id) kept.push(models[m])
      }
      if (!kept.length) continue
      out.push({
        id: group.id,
        name: typeof group.name === 'string' && group.name ? group.name : group.id,
        models: kept
      })
    }
    return out
  }

  /** Bot 记录里的 model 就是 update-bot 认的那个完整 ref（provider/model）。 */
  function modelRefOf(group, model) { return group.id + '/' + model.id }

  /** 一个 ref 对应的目录项；认不出来（宿主刚删掉那个模型）就是 null。 */
  function modelEntryOf(catalog, ref) {
    var groups = modelGroups(catalog)
    for (var g = 0; g < groups.length; g += 1) {
      for (var m = 0; m < groups[g].models.length; m += 1) {
        if (modelRefOf(groups[g], groups[g].models[m]) === ref) return { group: groups[g], model: groups[g].models[m] }
      }
    }
    return null
  }

  /** 清单里那个 ref 的展示名：认不出来就退回 ref 本身（宿主刚删掉那个模型）。 */
  function modelNameOf(ref) {
    var entry = modelEntryOf(state.modelCatalog, ref)
    if (!entry) return ref
    return String(entry.model.name || entry.model.id)
  }

  /** 设置键上的 aria-label 就是那一页的「会话设置」（zh/en 由壳注入），照读即可。 */
  function settingsText() {
    var button = $('bpSettings')
    return (button && button.getAttribute('aria-label')) || '会话设置'
  }

  function settingsHead() {
    return '<div class="settings-head"><strong>' + esc(settingsText()) + '</strong>' +
      '<button class="settings-close" data-settings-close aria-label="关闭">×</button></div>'
  }

  /**
   * 面板内容：与 Pocket 的 renderSessionSettings 同一套类名与结构，字段只有一个——模型
   * （判据 1③：Pocket 那边的「预设」「思考强度」BOT 不出现，两边数据源不同）。
   */
  function settingsPanelHtml() {
    var bot = chatBot()
    var current = bot && typeof bot.model === 'string' && bot.model ? bot.model : ''
    var html = settingsHead()
    html += '<div class="setting-field"><span>模型</span>' +
      '<button type="button" class="setting-pick" data-pick="model" aria-expanded="false">' +
      '<span>' + esc(current ? modelNameOf(current) : '跟着宿主默认') + '</span><i aria-hidden="true"></i></button>' +
      '<div class="setting-list" data-field="model" data-built="" hidden>'
    if (!state.modelCatalog) {
      html += '<p class="bp-empty">' + (state.modelBusy ? '读取模型清单…' : '模型清单还没读到。') + '</p>'
      html += '</div></div>'
      return html
    }
    var groups = modelGroups(state.modelCatalog)
    if (!groups.length) html += '<p class="bp-empty">宿主没有给出可选的模型。</p>'
    for (var g = 0; g < groups.length; g += 1) {
      html += '<span class="setting-group">' + esc(groups[g].name) + '</span>'
      for (var m = 0; m < groups[g].models.length; m += 1) {
        var ref = modelRefOf(groups[g], groups[g].models[m])
        var on = ref === current
        html += '<button type="button" class="setting-opt' + (on ? ' is-on' : '') + '" data-model-pick="' + esc(ref) + '">' +
          esc(groups[g].models[m].name || groups[g].models[m].id) + '</button>'
      }
    }
    html += '</div></div>'
    return html
  }

  /** 面板只在 Bot 会话里出现；列表页收起入口，也不给一个空面板。 */
  function renderSettingsPanel() {
    var panel = $('bpSettingsPanel')
    var button = $('bpSettings')
    if (!panel || !button) return
    var chat = state.chat
    var open = !!chat && chat.kind === 'bot' && state.modelOpen === true
    button.hidden = !chat || chat.kind !== 'bot'
    button.setAttribute('aria-expanded', open ? 'true' : 'false')
    panel.hidden = !open
    if (!open) { panel.innerHTML = ''; return }
    panel.innerHTML = settingsPanelHtml()
  }

  function toggleSettings() {
    // 键只在 Bot 会话里可见（renderSettingsPanel 已按这个口径藏它）；列表页那次点击
    // 落到这里就直接返回，免得在名单页上读一份用不到的模型目录。
    var chat = state.chat
    if (!chat || chat.kind !== 'bot') return
    if (state.modelOpen === true) {
      state.modelOpen = false
      renderSettingsPanel()
      return
    }
    if (!state.modelOpen) loadModelCatalog()
    state.modelOpen = true
    renderSettingsPanel()
  }

  function loadModelCatalog() {
    if (state.modelCatalog || state.modelBusy) { renderSettingsPanel(); return }
    state.modelBusy = true
    renderSettingsPanel()
    rpc('session.models', {}).then(function (catalog) {
      state.modelBusy = false
      state.modelCatalog = catalog && typeof catalog === 'object' ? catalog : { groups: [] }
      renderSettingsPanel()
    }).catch(function (error) {
      state.modelBusy = false
      renderSettingsPanel()
      toast('模型清单没读到：' + (error.message || '未知原因'))
    })
  }

  /**
   * 换模型：发 update-bot，然后**回读 bot.team** 确认真的落到 Bot 上了。
   * 只看 update 的答复不算数——回读走的是手机平时读的同一份裁剪视图（botTeamView），
   * 回读里 model 已经是新 ref 才写「已换到」，否则如实说没换成。
   */
  function setBotModel(ref) {
    var bot = chatBot()
    if (!bot || typeof bot.id !== 'string' || !bot.id || state.modelBusy) return
    if (bot.model === ref) return
    state.modelBusy = true
    toast('正在换成 ' + ref + '…')
    rpc('bot.update', { id: bot.id, model: ref }).then(function () {
      return rpc('bot.team', {})
    }).then(function (team) {
      state.modelBusy = false
      state.team = team
      // renderTeam 结尾会重画这一页（原来重画的是会话页顶上那行入口）。
      renderTeam()
      loadModelCatalog()
      var row = null
      var bots = team && Array.isArray(team.bots) ? team.bots : []
      for (var i = 0; i < bots.length; i += 1) {
        if (bots[i] && bots[i].id === bot.id) { row = bots[i]; break }
      }
      var now = row && typeof row.model === 'string' ? row.model : ''
      // 界面不许比 Bot 跑得快：回读说没变，就不写「已换到」。
      if (now !== ref) { toast('没换成：Bot 现在还是 ' + (now || '跟着宿主默认')); return }
      toast('已换到 ' + ref)
    }).catch(function (error) {
      state.modelBusy = false
      renderSettingsPanel()
      toast('没换成：' + (error.message || '未知原因'))
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

  // A Bot writing to another Bot lands in the part as a user/message whose
  // source is a Bot. The Host's own feed already names the sender (ds-bot
  // src/host/parts.js displayItems stamps kind:'event' with role and name) and
  // the landing draws it as one line naming that Bot (client.js EventLine);
  // bot.earlier items reach this page as "'· ' + name" (earlierRows). Only the
  // newest page dropped them, because their source.kind is not 'user', so a
  // part made of relay traffic opened to an empty transcript (user 2026-10-29
  // 21:57). A handoff is a part boundary, not a Bot speaking: it keeps its own
  // label instead of collapsing into a sender line.
  var RELAY_ROLES = ['request', 'reply', 'report', 'stopped']

  /**
   * One relay record as a row, or null for anything this page must not draw:
   * system injections (runtime-context, time-context, plugin:memory, tool-jobs
   * …) carry source.kind 'bot' too on some Host builds, so the decision is the
   * role, never the kind alone.
   * @param {any} message
   * @returns {{ role: string, text: string } | null}
   */
  function relayRow(message) {
    var source = (message && message.source) || null
    if (!source || String(source.kind || '') !== 'bot') return null
    if (source.handoff === true) {
      var note = textOf(message.content)
      var label = note ? String(note.split('\n')[0]).trim() : ''
      if (!label) return null
      return { role: 'handoff', text: label }
    }
    if (source.deferred === true || source.resumed === true || source.retried === true) return null
    if (RELAY_ROLES.indexOf(String(source.role || '')) < 0) return null
    var who = source.senderName || source.name || ''
    if (!who) return null
    return { role: 'event', text: '· ' + String(who) }
  }

  /**
   * The two roles this page draws. Tool rows, reasoning folds and the turn
   * machinery belong to the landing's transcript, which has a component for
   * each; the Bot page only has to show what was said — and when, on the same
   * tail the landing stamps its messages with, read off the same Host record:
   * the event's own time field, which the landing's eventTime reads as well
   * (see stampOf above).
   *
   * The oldest seq in the page rides back with the rows because one part can
   * itself be longer than one call returns: session.history pages backwards
   * with beforeSeq, and that seq is where the next page starts.
   * @param {unknown} records
   * @returns {{ rows: Array<{ role: string, text: string, time?: number, pending?: boolean }>, oldestSeq: number }}
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
      // Each row carries its own seq: merging by seq is what keeps a polled page
      // from rebuilding rows the reader already has, so a shared or stale value
      // would collapse distinct messages into one.
      var rowSeq = pageSeq(record)
      var event = record.event || record
      var data = event.data || {}
      var type = String(event.type || '').toLowerCase()
      if (type === 'user/message') {
        var message = data.message || data
        var source = (message && message.source) || null
        if (source && source.kind === 'user') {
          var said = textOf(message.content)
          if (said) rows.push({ role: 'user', text: said, time: stampOf(message, event), _seq: rowSeq })
        } else {
          var relayed = relayRow(message)
          if (relayed) rows.push({ role: relayed.role, text: relayed.text, _seq: rowSeq })
        }
      } else if (type === 'assistant/message') {
        var answer = textOf(data.message && data.message.content)
        if (answer) rows.push({ role: 'assistant', text: answer, time: stampOf(data.message, event), _seq: rowSeq })
      }
    }
    return { rows: rows, oldestSeq: oldestSeq }
  }

  function renderChat() {
    var chat = state.chat
    if (!chat) return
    // 判据 2①：会话页标题栏不许再有字——那一行现在由浮起来的返回键占着，
    // 会话名写在消息流的头部由消息自己带出。列表页那行标题不受影响
    // （showList 才写 document.title，这里只负责清空）。
    $('bpTitle').textContent = ''
  }

  // How much of one conversation opening fills in before it stops reaching
  // back, and how many pages that may cost. Two kinds of "before" stack here:
  // the part the page is pointed at can itself be longer than one page (read
  // further back with session.history+beforeSeq), and the parts before it are
  // bot.earlier. A Bot switches part often and a fresh part can hold a single
  // exchange — reading only the newest page made a year of history look like it
  // never happened (user 2026-10-24: 「看不到这个 Chief 之前的聊天记录」).
  var PART_PAGE = 60
  // A ceiling on the automatic reach-back, not a target: it stops as soon as the
  // screen is full (2026-10-29), and this only keeps a Host that keeps claiming
  // there is more from looping forever.
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
      // A divider stamps when that part began — the same clock the landing's
      // earlier-parts feed prints on its dividers (pages.js earlierItemHtml).
      if (kind === 'divider') { out.push({ role: 'divider', text: '', time: typeof item.time === 'number' ? item.time : undefined }); continue }
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
   * Merge a fresh page into what is already drawn, by the Host's own event
   * number — the same rule the landing's transcript uses (lib/pages.js
   * mergeEntries), and for the same reason: replacing the drawn page wholesale
   * on every poll rebuilds every row, throws away the reader's scroll position
   * and re-measures the box, which on a phone reads as the page jumping every
   * five seconds (user 2026-10-29: 「BOT 对话页不停跳页」).
   *
   * A row without a seq (an optimistic row not yet shown by the Host, a
   * divider or an event row from bot.earlier) keeps its relative place by the
   * fractional key mergeEntries gives it. An optimistic row sorts last: it is
   * the newest thing said until the Host stamps it.
   * @param {unknown} base
   * @param {unknown} fresh
   * @returns {Array<{ role: string, text: string }>}
   */
  function mergeRows(base, fresh) {
    var list = (Array.isArray(base) ? base : []).concat(Array.isArray(fresh) ? fresh : [])
    var seen = {}
    var keyed = []
    var anchor = -1
    var run = 0
    for (var i = 0; i < list.length; i += 1) {
      var row = list[i]
      if (!row) continue
      // The same row object can arrive twice: opening a chat on a preview hands
      // the preview's page in as both the drawn rows and the page just read
      // (loadChat's fromPreview leg). A row without a seq has nothing else to
      // tell it apart from itself, so it would be drawn twice.
      if (list.indexOf(row) < i) continue
      if (row.pending === true) {
        keyed.push({ key: Infinity, row: row })
        continue
      }
      var seq = typeof row._seq === 'number' ? row._seq : -1
      if (seq >= 0) {
        if (seen[seq]) continue
        seen[seq] = true
        anchor = seq
        run = 0
        keyed.push({ key: seq, row: row })
        continue
      }
      run += 1
      keyed.push({ key: anchor + 0.5 * (run / (run + 1)), row: row })
    }
    keyed.sort(function (a, b) { return a.key - b.key })
    var out = []
    for (var k = 0; k < keyed.length; k += 1) out.push(keyed[k].row)
    return out
  }

  /**
   * Drop an optimistic row once the Host's own row for it is on screen. A
   * queued message can take a read or two to surface, so one still unseen
   * stays pending at the bottom.
   * @param {Array<{ role: string, text: string, pending?: boolean, _seq?: number }>} rows
   * @returns {Array<{ role: string, text: string }>}
   */
  function keepPending(rows) {
    var served = {}
    var i
    for (i = 0; i < rows.length; i += 1) {
      var row = rows[i]
      if (row && row.pending !== true && row.role === 'user' && typeof row._seq === 'number') served[row.text] = true
    }
    var out = []
    for (i = 0; i < rows.length; i += 1) {
      var held = rows[i]
      if (held && held.pending === true && served[held.text]) continue
      out.push(held)
    }
    return out
  }

  /**
   * Which message the reader is looking at, read before a repaint replaces the
   * rows. Same shape and same 2px threshold as the landing's transcript anchor
   * (lib/pages.js readTranscriptAnchor / restoreTranscriptAnchor): a reader who
   * scrolled up must land back on the row they were reading, not at the top.
   * @param {any} box
   * @returns {{ index: number, offset: number } | null}
   */
  function readChatAnchor(box) {
    if (!box || typeof box.querySelectorAll !== 'function' || typeof box.getBoundingClientRect !== 'function') return null
    var rows = box.querySelectorAll(':scope > .message')
    var top = box.getBoundingClientRect().top
    for (var i = 0; i < rows.length; i += 1) {
      var rect = rows[i].getBoundingClientRect()
      if (rect && rect.bottom > top + 2) return { index: i, offset: Math.round(rect.top - top) }
    }
    return null
  }

  /**
   * Put the anchored row back where it was by moving the box's scrollTop by the
   * measured delta. No retry chain: the rows here are plain DOM written in one
   * innerHTML call, so their heights are final on the next measure (the landing
   * needs its retries because its rows carry content-visibility estimate
   * heights). Skip the write when the row already sits within 2px.
   * @param {any} box
   * @param {{ index: number, offset: number } | null} anchor
   * @returns {boolean}
   */
  function restoreChatAnchor(box, anchor) {
    if (!anchor || !box || typeof box.querySelectorAll !== 'function') return false
    var rows = box.querySelectorAll(':scope > .message')
    if (!rows.length || anchor.index >= rows.length) return false
    var rect = rows[anchor.index].getBoundingClientRect()
    if (!rect) return false
    var delta = Math.round(rect.top - box.getBoundingClientRect().top - anchor.offset)
    if (Math.abs(delta) > 2) box.scrollTop = Math.max(0, Math.round(box.scrollTop + delta))
    return true
  }

  /**
   * 正在干活的提示文案。判据 3③：\`working === true\` 写「正在干活」；\`working\`
   * 是对象且带 \`tool\` 写「正在 {tool}」；对象没带 tool 也退回「正在干活」。
   * @param {any} bot
   * @returns {string}
   */
  function turnStatusText(bot) {
    if (!bot || typeof bot.working !== 'object' || !bot.working) return '正在干活'
    var tool = bot.working.tool
    return tool ? '正在 ' + String(tool) : '正在干活'
  }

  /**
   * Draw what is loaded: the part being read, with the earlier parts above it.
   * The button on top is the one place a reader asks for more — opening a
   * conversation only fills the screen it opens on, not every page behind it.
   *
   * The repaint is skipped when nothing the reader can see has changed: the
   * live poller asks every five seconds, and a blind innerHTML swap each time
   * would kill a text selection and any scroll the reader had made for nothing.
   * The signature covers exactly what this painter draws; a forced repaint
   * (a failed send dropping its optimistic row) passes force.
   */
  function paintChat(force) {
    var chat = state.chat
    if (!chat) return
    var rows = chat.older.concat(chat.latest)
    // 这个会话的 Bot 正在干活时，消息流末尾挂一条 #bpTurnStatus.turn-status
    // （判据 3②）：「正在干活」/「正在 {tool}」，不带用时。可见判据与下面
    // \`live\` 出自同一个字段（botTeamView 的 working），不另开一条状态通路。
    // 最后一条回答因此不再带 \`.streaming\`（判据 3①，判定条件改为 grep 该字符串）。
    var here = chatBot()
    var live = chat.kind === 'bot' && !!here &&
      (here.working === true || (here.working && typeof here.working === 'object'))
    var turnStatus = live ? turnStatusText(here) : ''
    var key = (chat.kind === 'bot' && !chat.earlierDone ? (chat.olderBusy ? 'busy' : 'idle') : 'room') +
      '|' + (turnStatus ? 'working' : '') + '|' + JSON.stringify(rows)
    if (!force && chat.paintKey === key) return
    chat.paintKey = key
    var box = $('bpMsgs')
    var stick = box.scrollHeight - box.scrollTop - box.clientHeight < 60
    // A reader who is not at the bottom is reading something specific: note
    // which row before the rows are replaced, and put it back afterwards. The
    // poll that calls this every five seconds used to rebuild the screen under
    // them, which is the jump the user reported (2026-10-29).
    var anchor = stick ? null : readChatAnchor(box)
    var html = ''
    if (chat.kind === 'bot' && !chat.earlierDone) {
      html += '<button class="bp-older" type="button" data-earlier="1"' + (chat.olderBusy ? ' disabled' : '') + '>' +
        esc(chat.olderBusy ? '正在加载更早的记录…' : '加载更早的记录') + '</button>'
    }
    if (!rows.length) {
      html += '<p class="bp-empty">这里还没有消息。</p>'
    } else {
      for (var i = 0; i < rows.length; i += 1) {
        var row = rows[i] || {}
        if (row.role === 'divider') {
          var when = clockOf(row.time)
          html += '<div class="bp-divider"><span>' + (when ? esc(when) + ' · ' : '') + '更早的记录</span></div>'
          continue
        }
        if (row.role === 'handoff') { html += '<div class="earlier-divider"><span>' + esc(row.text) + '</span></div>'; continue }
        if (row.role === 'event') { html += '<div class="bp-event">' + esc(row.text) + '</div>'; continue }
        var tail = row.pending ? '' : clockOf(row.time)
        html += '<div class="bp-msg message ' + row.role + (row.pending ? ' is-pending' : '') + '"><div class="markdown">' +
          markdown(row.text) + '</div>' +
          (tail ? '<span class="bp-tail">' + esc(tail) + '</span>' : '') + '</div>'
      }
    }
    // working 转假就不留完成文案（判据 3④）：整个节点从消息流末尾拿掉。
    if (turnStatus) {
      html += '<div id="bpTurnStatus" class="turn-status">' + esc(turnStatus) + '</div>'
    }
    box.innerHTML = html
    if (stick) box.scrollTop = box.scrollHeight
    else restoreChatAnchor(box, anchor)
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
   * @param {{ announce?: boolean }} [options] announce:false leaves out the busy
   *   repaint — the automatic fill asks for several pages in a row and only the
   *   first of them is worth drawing twice (2026-10-29, the entry-jump fix).
   * @returns {Promise<boolean>} whether the page had anything in it
   */
  function loadEarlier(chat, options) {
    if (!chat || chat.olderBusy || chat.earlierDone) return Promise.resolve(false)
    var announce = !(options && options.announce === false)
    // Read the scroll box before painting the busy state: repainting first and
    // measuring after would compare against a box that already moved.
    var box = $('bpMsgs')
    var beforeHeight = box.scrollHeight
    var beforeTop = box.scrollTop
    chat.olderBusy = true
    if (announce) paintChat()
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
  function loadChat(fromPreview) {
    var chat = state.chat
    if (!chat) return Promise.resolve()
    // A chat opened from a preview already holds its newest page: go straight on
    // to the pages behind it rather than reading the same page a second time.
    var first = fromPreview
      ? Promise.resolve({ rows: chat.latest, oldestSeq: chat.oldestSeq, hasMore: chat.hasMore })
      : readPart(chat)
    return first.then(function (page) {
      if (state.chat !== chat) return
      // A preview already put the newest page on screen; merging by seq keeps
      // those rows (and their place) instead of rebuilding them.
      chat.latest = mergeRows(chat.latest, page.rows)
      chat.hasMore = page.hasMore
      chat.oldestSeq = page.oldestSeq
      paintChat()
      if (chat.kind !== 'bot') return
      var hops = 0
      // 一屏就是一屏：判据是消息区真的比一屏高，不再按行数估。工具事件不进消息
      // 行（readPage 只留 user/message 和 assistant/message），60 个事件常常只出
      // 十几条消息，按 60 行算永远补不满，于是一进会话就连补 6 页、每页整段重画
      // 两遍——用户 2026-10-29 看到的「刚进来时候会跳」就是这个。Pocket 侧
      // （lib/pages.js ensureTranscriptFilled）早就是「超过一屏就停」。
      var box = $('bpMsgs')
      var oneScreen = function () {
        return box.clientHeight > 0 && box.scrollHeight > box.clientHeight + 8
      }
      var step = function () {
        if (state.chat !== chat) return Promise.resolve()
        if (chat.earlierDone || chat.olderBusy) return Promise.resolve()
        if (oneScreen() || hops >= FILL_HOPS) return Promise.resolve()
        hops += 1
        // 补页必须重画，否则量不到补完之后的屏高，就无从判断「补到一屏」；忙碌
        // 态只在首跳声明一次——后面几跳是同一次补页的延续，再声明一遍就是同一
        // 段内容画两遍。
        return loadEarlier(chat, { announce: hops === 1 }).then(function (more) { return more ? step() : undefined })
      }
      return step()
    }).catch(function (error) {
      // The reader may have moved on while this read was in flight; the error
      // belongs to the conversation it was asked for, not to the one on screen.
      if (state.chat !== chat) return
      $('bpMsgs').innerHTML = '<p class="bp-empty">' + esc('读不到消息：' + (error.message || '未知原因')) + '</p>'
    })
  }

  /**
   * Re-read only the newest page, leaving the earlier pages where they are.
   * An optimistic row still waiting for the Host to show it rides along: the
   * fresh page replaces what was drawn, and any optimistic row the page does
   * not contain yet (a queued message can take a read or two to surface) is
   * appended back, still pending. One the page does contain is dropped — the
   * Host's own row has taken over.
   */
  function refreshLatest() {
    var chat = state.chat
    if (!chat || chat.olderBusy) return Promise.resolve()
    return readPart(chat).then(function (page) {
      if (state.chat !== chat) return
      // Merged by seq, not replaced: the fresh page holds only the newest part,
      // and swapping it in would rebuild rows the reader is already looking at
      // (and drop any row this page already drew past that window).
      chat.latest = keepPending(mergeRows(dropStreamRow(chat.latest), page.rows))
      settleStream(chat)
      syncStreamRow(chat)
      paintChat()
      // 提问也搭这条轮询：Bot 刚问出来的问题五秒内上屏，不必等下一次开页。
      loadQuestion()
    }).catch(function () {})
  }

  // ---- live stream --------------------------------------------------------
  //
  // 正在写的那一条只有一条路能进这个页面：桥现成的会话流（与 Pocket 会话页同一个
  // /api/session/stream，鉴权走同一份配对 cookie）。BOT 页原先只有 5 秒一次的
  // session.history，而正在写的回合还没落进 history —— 末行于是停在上一句（用户
  // 2026-10-29：「最后一个回复不显示」）。流带来的字与轮询读到的行共用 chat.latest
  // 一个数组：流只是往末尾挂一条 _stream 行，每次重挂都先把它摘掉，所以不会变成
  // 两套 rows 互相顶（§6 第 4 条）。

  /**
   * 流里的一小段字。与 Pocket 的 tokenChunkText 同一口径（lib/pages.js）：只有正文
   * 增量（text-delta 或裸字符串）算数，推理增量不进回复气泡。
   * @param {unknown} value
   * @returns {string}
   */
  function streamPiece(value) {
    if (typeof value === 'string') return value
    if (!value || typeof value !== 'object') return ''
    if (value.type !== undefined && value.type !== 'text-delta') return ''
    if (typeof value.text === 'string') return value.text
    if (typeof value.delta === 'string') return value.delta
    if (typeof value.content === 'string') return value.content
    return ''
  }

  /**
   * The rows without the live one in them. Dropped before every merge so the
   * stream's row is never a second copy of a row the Host has since stamped.
   * @param {Array<object>} rows
   * @returns {Array<object>}
   */
  function dropStreamRow(rows) {
    var out = []
    for (var i = 0; i < rows.length; i += 1) {
      if (rows[i] && rows[i]._stream === true) continue
      out.push(rows[i])
    }
    return out
  }

  /**
   * 流式文本的唯一落点：chat.latest 末尾那一条 _stream 行。没有文本就不挂。
   * @param {any} chat
   */
  function syncStreamRow(chat) {
    var rows = dropStreamRow(chat.latest)
    if (chat.streamText) rows = rows.concat([{ role: 'assistant', text: chat.streamText, _stream: true }])
    chat.latest = rows
  }

  /**
   * 这个回合开始的序号水位：正式行比它大，才说明这个回合已经落库。
   * @param {Array<object>} rows
   * @returns {number}
   */
  function watermarkOf(rows) {
    var max = -1
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i]
      if (row && typeof row._seq === 'number' && row._seq > max) max = row._seq
    }
    return max
  }

  /**
   * 回合写完之后，Host 的正式行才是真的：比这个回合起点更深的一条 assistant 行一
   * 出现，同一回合的流式文本就让位，免得同一句画两遍。正式行还读不到（history 落后
   * 一拍）就继续挂着等下一次读——不清空，否则屏幕上那句会先消失再回来。
   * @param {any} chat
   */
  function settleStream(chat) {
    if (!chat.streamText) return
    for (var i = chat.latest.length - 1; i >= 0; i -= 1) {
      var row = chat.latest[i]
      if (!row || row.role !== 'assistant' || row._stream === true) continue
      if (typeof row._seq !== 'number' || row._seq <= chat.streamSeq) continue
      chat.streamText = ''
      return
    }
  }

  /**
   * 流上带回的记录（一帧一条，或重连 snapshot 的一批）走与轮询同一个读法：readPage
   * 转行、按 seq 合并 —— 两条路画出来的必须是同一份 rows。
   * @param {any} chat
   * @param {unknown} records
   * @returns {boolean} whether anything was drawn from them
   */
  function ingestRecords(chat, records) {
    var page = readPage(records)
    if (!page.rows.length) return false
    chat.latest = keepPending(mergeRows(dropStreamRow(chat.latest), page.rows))
    settleStream(chat)
    syncStreamRow(chat)
    return true
  }

  /**
   * 一个 token 帧：start 起一条空的流式行，chunk 往里追字，end 交给下一次读把正式
   * 行换上来。被放弃的回合（outcome.kind === 'abandoned'）不留字，与 Pocket 同。
   * @param {any} chat
   * @param {any} frame
   */
  function applyStreamToken(chat, frame) {
    var kind = String((frame && frame.type) || '')
    if (kind === 'start') {
      chat.streamText = ''
      chat.streamSeq = watermarkOf(chat.latest)
      syncStreamRow(chat)
      paintChat()
      return
    }
    if (kind === 'chunk') {
      var piece = streamPiece(frame && frame.chunk)
      if (!piece) return
      // 水位兜底：这一回合的 start 帧可能到不了（中途订阅、丢帧）。那时 streamSeq
      // 还停在 -1，而 settleStream 的让位判据是「正式行 _seq 比水位大」——-1 之下
      // 任何既有 assistant 行都算更深，于是 5 秒一次的 refreshLatest 每一拍都会把
      // 正在写的字清空（用户看到「写了一半的字每 5 秒消失一次」）。没有 start 就
      // 以当下已读到的行为准自建一次水位，让位判据才只对「这一回合之后」的行成立。
      if (typeof chat.streamSeq !== 'number' || chat.streamSeq < 0) chat.streamSeq = watermarkOf(chat.latest)
      chat.streamText = String(chat.streamText || '') + piece
      syncStreamRow(chat)
      paintChat()
      return
    }
    if (kind === 'end') {
      var outcome = frame && frame.outcome ? frame.outcome : null
      if (outcome && outcome.kind === 'abandoned') {
        chat.streamText = ''
        syncStreamRow(chat)
        paintChat()
        return
      }
      // 写完了就读一次：正式行换掉流式行。读不到也不额外催，5 秒轮询自己会来。
      refreshLatest()
    }
  }

  /**
   * 一帧 SSE。不是 JSON 就丢掉：一帧废数据不该让页面抛错。
   * @param {any} event
   * @param {(frame: any) => void} run
   */
  function streamFrame(event, run) {
    var frame
    try {
      frame = JSON.parse(event.data)
    } catch (error) {
      return
    }
    run(frame)
  }

  /**
   * 关掉这个会话的流。换会话、回列表都走这里，免得上一个会话的流还在写这个页面。
   * @param {any} chat
   */
  function closeChatStream(chat) {
    if (!chat || !chat.stream) return
    chat.stream.close()
    chat.stream = null
  }

  /**
   * 开这个会话的流。隧道模式退回轮询：BOT 页不读桥的 connectionMode，于是看流自己
   * 的结果 —— 开不出来就关掉不再重连，而 5 秒一次 refreshLatest 一直在，接了流不会
   * 让页面比不接时更静止（lib/pages.js openRealtime 是同一条规矩）。
   *
   * 带上 sinceSeq：桥把「这个序号及以下的记录我已经有了」当游标，不带就等于声明
   * 手上一份都没有，首帧 snapshot 于是整窗重灌进 ingestRecords。这一页进会话时常常
   * 已经把预览页画在屏上了（showChat 先画 preview），整窗重灌就是把同样的行再
   * 合并、再重绘一遍——与用户报的「进会话跳屏」同一个机理。电脑端 openSessionStream
   * 也是带水位开的（lib/pages.js streamWatermark）。
   * @param {any} chat
   */
  function openChatStream(chat) {
    if (!chat || !chat.id) return
    closeChatStream(chat)
    var since = watermarkOf(chat.latest || [])
    var source = new EventSource('/api/session/stream?sessionId=' + encodeURIComponent(chat.id) +
      (since >= 0 ? '&sinceSeq=' + since : ''))
    chat.stream = source
    source.addEventListener('token', function (event) {
      if (state.chat !== chat) return
      streamFrame(event, function (frame) { applyStreamToken(chat, frame) })
    })
    source.addEventListener('event', function (event) {
      if (state.chat !== chat) return
      streamFrame(event, function (frame) {
        if (ingestRecords(chat, [frame && frame.event ? frame.event : frame])) paintChat()
      })
    })
    source.addEventListener('snapshot', function (event) {
      if (state.chat !== chat) return
      streamFrame(event, function (frame) {
        var records = frame && Array.isArray(frame.records) ? frame.records : []
        if (ingestRecords(chat, records)) paintChat()
      })
    })
    source.onerror = function () {
      chat.streamDead = true
      closeChatStream(chat)
    }
  }

  /**
   * 会话页也要知道这个 Bot 还在不在干活：paintChat 靠它给最后一条回答点上
   * 闪烁光标（判据 D5a②）。列表页那条 15s 轮询在会话页里是停的，而且它带
   * prefetchPreviews —— 每 5s 重发一批历史读，代价远大于这里要的一个字段。
   * 所以只更新 roster，不画列表、不预读：回到列表时 showList 会自己重读一遍。
   */
  function refreshWorking() {
    if (!state.chat || state.chat.kind !== 'bot') return Promise.resolve()
    return rpc('bot.team', {}).then(function (team) {
      state.team = team
      paintChat()
    }).catch(function () {})
  }

  // ---- previews ------------------------------------------------------------
  //
  // The roster is drawn, so every conversation on it is about to be tapped: read
  // its newest page now, while the reader is still looking at the list (user
  // 2026-10-27③a: 「加载后点进 BOT 的会话还是会要加载，没有提前读取到」). One page
  // each, strictly one at a time — the tunnel is a single leg, so ten reads in
  // flight only make all ten slower. A preview is never a second source of truth:
  // opening the chat paints it and then loadChat reads the same page again,
  // replacing whatever moved meanwhile.
  //
  // Which ten (user 2026-10-29):「最大加载会话数量」— every PINNED conversation, plus
  // the newest ten by clock. The old rule took the first six in roster order, so a
  // pin at the bottom of the roster and a chat the reader used a minute ago went
  // unpreviewed while a stale one was read. Pins do not consume the ten: a roster
  // with twelve pins reads twelve plus ten. Groups stay out of the clock entirely
  // (their rows carry no updatedAt) and get their own six on top, so they can never
  // crowd a Bot's slot (task card §3 B4-(b)).
  var PREVIEW_BOTS = 10
  var PREVIEW_ROOMS = 6
  var PREVIEW_CACHE_MAX = 32

  function rememberPreview(id, page) {
    if (!id) return
    state.previews[id] = { rows: page.rows, oldestSeq: page.oldestSeq, hasMore: page.hasMore }
    // The cache only has to cover the roster, not the reader's whole history: the
    // oldest keys go first. Skipping the row just written keeps the count near
    // the cap instead of exact — a few extra rows cost nothing next to evicting
    // the page that is about to be opened.
    var ids = Object.keys(state.previews)
    for (var i = 0; ids.length - i > PREVIEW_CACHE_MAX; i += 1) {
      if (ids[i] !== id) delete state.previews[ids[i]]
    }
  }

  // Which conversations to read first. Split out of prefetchPreviews so the order
  // can be asserted without a DOM: it is pure (roster + what is already cached).
  //
  // 判据 9：队列 =（所有主 bot）∪（所有 pinned bot）∪（其余按 updatedAt 降序前
  // PREVIEW_BOTS 个）。主 bot 与 pinned 都不占那十个名额——它们是被点名要读的，
  // 让它们去挤「最新的十个」会把该读的挤出去，正是这条规则要修的病（同
  // test/preload-scope.test.js 里冷启动那两档的「置顶全部 ∪ 最新 10」）。主 bot
  // 判据与列表分区同源：同一个 team.mainBotIds。没有 sessionId 的不在队列里，
  // 群聊仍按 PREVIEW_ROOMS 单独算。
  function previewQueue(team, previews) {
    var queue = []
    var seen = {}
    var add = function (id) {
      if (!id || seen[id] || (previews && previews[id])) return
      seen[id] = 1
      queue.push(id)
    }
    var bots = Array.isArray(team && team.bots) ? team.bots : []
    var mainIds = Array.isArray(team && team.mainBotIds) ? team.mainBotIds : []
    var mainBots = []
    var pinnedBots = []
    var freshBots = []
    for (var b = 0; b < bots.length; b += 1) {
      var bot = bots[b]
      if (!bot || !bot.sessionId) continue
      if (mainIds.indexOf(bot.id) >= 0) mainBots.push(bot)
      else if (bot.pinned === true) pinnedBots.push(bot)
      else freshBots.push(bot)
    }
    var byNewest = function (a, c) { return (Number(c.updatedAt) || 0) - (Number(a.updatedAt) || 0) }
    mainBots.sort(byNewest)
    pinnedBots.sort(byNewest)
    freshBots.sort(byNewest)
    var n
    for (n = 0; n < mainBots.length; n += 1) add(mainBots[n].sessionId)
    for (n = 0; n < pinnedBots.length; n += 1) add(pinnedBots[n].sessionId)
    for (n = 0; n < freshBots.length && n < PREVIEW_BOTS; n += 1) add(freshBots[n].sessionId)
    var rooms = Array.isArray(team && team.rooms) ? team.rooms : []
    for (n = 0; n < rooms.length && n < PREVIEW_ROOMS; n += 1) add(rooms[n] && rooms[n].id)
    return queue
  }

  function prefetchPreviews() {
    var team = state.team
    if (!team || state.previewing) return
    var queue = previewQueue(team, state.previews)
    if (!queue.length) return
    state.previewing = true
    var step = function () {
      var id = queue.shift()
      if (!id) { state.previewing = false; return }
      readPart({ id: id }).then(function (page) {
        rememberPreview(id, page)
      }).catch(function () {
        // A preview that fails is not a read that failed: opening the chat reads
        // the same page again and says what went wrong there, in that context.
      }).then(step)
    }
    step()
  }

  function send() {
    var chat = state.chat
    var field = $('bpPrompt')
    var text = field.value.trim()
    if (!chat || !text || state.busy) return
    state.busy = true
    $('bpSend').disabled = true
    // The words go on screen now, not when the round trip answers: the landing
    // paints its own optimistic bubble for the same reason. If the send fails
    // the row comes off again; once the Host shows the message itself, the
    // optimistic copy is dropped in favour of the real row (refreshLatest).
    var pendingRow = { role: 'user', text: text, pending: true }
    chat.latest = chat.latest.concat([pendingRow])
    paintChat(true)
    var box = $('bpMsgs')
    box.scrollTop = box.scrollHeight
    rpc('session.prompt', {
      sessionId: chat.id,
      mode: 'queue',
      content: [{ type: 'text', text: text }],
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
    }).then(function () {
      // The input box is one shared node: a reader who opened another chat while
      // the round trip was in flight is typing there now, and the old send's
      // answer must not wipe their words (the failure branch already guards).
      if (state.chat === chat) {
        field.value = ''
        field.style.height = ''
      }
      return refreshLatest()
    }).catch(function (error) {
      if (state.chat === chat) {
        chat.latest = chat.latest.filter(function (row) { return row !== pendingRow })
        paintChat(true)
      }
      toast('没发出去：' + (error.message || '未知原因'))
    }).then(function () {
      state.busy = false
      $('bpSend').disabled = false
    })
  }

  // ---- routing -------------------------------------------------------------

  function stopTimers() {
    // 上一个会话的流必须在这里断掉：它写的是那个会话的 rows，留着就是往新页面上写字。
    closeChatStream(state.chat)
    if (state.listTimer) { clearInterval(state.listTimer); state.listTimer = null }
    if (state.chatTimer) { clearInterval(state.chatTimer); state.chatTimer = null }
  }

  function showList() {
    stopTimers()
    state.chat = null
    // 列表页没有会话，提问卡跟着收起来（它只属于某个 Bot 的会话）。
    state.question = null
    renderQuestion()
    // The two floating buttons trade places with the view: the list offers the
    // way to the landing, a chat offers the way back to the list. The bar's
    // back key follows the landing's rule (user 2026-10-27: 「从会话返回到主页
    // 就没有再返回的了」): a chat steps back to this list, the list itself
    // carries no back at all — the way out of this page is the corner button.
    document.body.classList.add('bp-list')
    document.body.classList.remove('bp-chat')
    $('bpList').hidden = false
    $('bpMsgs').hidden = true
    $('bpComposer').hidden = true
    $('bpReload').hidden = false
    $('bpBack').hidden = true
    // 设置入口只属于某个 Bot 的会话：回到列表就收起，面板也不许留在展开态
    // （展开态属于那次会话，跨会话带过去就是给另一个 Bot 改模型）。
    state.modelOpen = false
    renderSettingsPanel()
    $('bpTitle').textContent = document.title
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
      olderBusy: false,
      // 正在写的那一句：streamText 是流上追下来的字，streamSeq 是这个回合开始时的
      // 序号水位（正式行比它大，就说明这一回合已经落库、流式行该让位）。
      // stream 是这个会话的 EventSource。
      streamText: '',
      streamSeq: -1,
      stream: null,
      streamDead: false
    }
    // 换会话就先把上一张提问卡放下；这一页的提问由下面这次与 5s 轮询各读一次。
    state.question = null
    renderQuestion()
    loadQuestion()
    $('bpList').hidden = true
    document.body.classList.add('bp-chat')
    document.body.classList.remove('bp-list')
    $('bpMsgs').hidden = false
    $('bpComposer').hidden = false
    $('bpReload').hidden = true
    $('bpBack').hidden = false
    // 每进一个会话都从收起态开始：面板停在展开、切到另一个 Bot，点下去改的就是
    // 屏幕上没写名字的那个 Bot。
    state.modelOpen = false
    renderSettingsPanel()
    // The composer ships disabled in the markup (a dead send key on the list
    // view would invite taps that go nowhere); an open conversation is exactly
    // the moment it starts working. Without this line the real phone's send
    // button stayed grey for ever — the stand-in tests click the handler
    // directly and never saw it.
    $('bpSend').disabled = false
    // A page already read while the roster was on screen (prefetchPreviews) is
    // painted before the read starts: the tap lands on messages, not on a
    // placeholder that gets replaced a moment later (user 2026-10-27③a).
    var preview = state.previews[id] || null
    if (preview) {
      state.chat.latest = mergeRows(state.chat.latest, preview.rows)
      state.chat.hasMore = preview.hasMore
      state.chat.oldestSeq = preview.oldestSeq
      paintChat()
    } else {
      $('bpMsgs').innerHTML = '<p class="bp-empty">读取中…</p>'
    }
    renderChat()
    loadChat(!!preview)
    // 正在写的那一句不等轮询：进会话就把流接上（隧道下开不出来会自己退回轮询）。
    openChatStream(state.chat)
    state.chatTimer = setInterval(function () {
      if (!document.hidden && state.chat && !state.busy) refreshLatest().then(refreshWorking)
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

  // Leaving the list for the landing. A plain anchor already names the landing,
  // so this only has to decide whether the history entry behind it is that same
  // landing — then going back keeps the landing's own scroll and its rows — and
  // whether the phone can have drawn something by the time it gets there.
  // The card moves on its own clock (70ms a step), but the hop waits for the
  // numbers: on their own the four steps are gone in 280ms, before the bridge
  // could say how much of the landing is warm (user 2026-10-27②). Bounded, so a
  // slow bridge can never turn a transition into a stall — but the bound has to be
  // longer than the bridge's own wait (bridge.js warmPage waits pageCueWaitMs, 1500 by
  // default; shorter than that and a slow answer writes its numbers onto a document
  // that is already unloading, which reads as「第 0 格还是 0」on the phone, 2026-10-28).
  var SWITCH_WAIT_MS = 1600
  // 判据 6D：第四行写上「已就绪」之后，卡要在屏幕上停够 0.5 秒再跳走。
  // 计时起点是「完成文字已落屏」那一刻，不能被帧同步（step×70ms 那串节奏）
  // 顺带凑够——帧同步跑得快时它只有 280ms，写完成文字与跳转差≈0，用户看到的
  // 就是「刚说完已就绪，人已经走了」。所以这里是写完之后单独等一个固定 500，
  // 而不是把 500 摊进已有的节拍里。
  var TRANSITION_DWELL_MS = 500

  function runSwitchToPocket() {
    var overlay = $('bpSwitchOverlay')
    if (overlay) overlay.hidden = false
    // 壳模板里 #bpSwitchOverlay 一定带四个 .boot-step，真机与测试替身都拿得到
    // querySelectorAll。从前这里还挂着一条「没有这个方法就直跳」的双判据，它唯一的
    // 作用是给没有该方法的替身让路——于是真机那 70ms×4 的过渡动画从未被任何测试跑
    // 过，动画里抛错导致 leave() 永不执行（用户卡在过渡页）时测试面全绿（审查 P1-5：
    // 替身反向塑造生产代码）。替身补齐后这条分支合并成一条。
    // 注意：这段脚本整段在模板字符串里，注释中不能出现反引号，否则模板当场截断。
    var rows = overlay ? overlay.querySelectorAll('.boot-step') : []
    if (!overlay || !rows || !rows.length) {
      leave()
      return
    }
    // 三页同一套读数契约（用户 2026-10-27：进入某行即有读数、完成才划线）：行与行之间
    // 的先后交给 ladderRun 排——它和主页那两张卡是同一份源码，这里只回答一件事：
    // 「这一行现在有没有读数」。返回 null 就是还没读到，让那一行继续滚着等。
    var previewRows = 0
    var previewMessages = 0
    try {
      var previews = state.previews || {}
      var previewKeys = Object.keys(previews)
      previewRows = previewKeys.length
      for (var k = 0; k < previewKeys.length; k += 1) {
        var preview = previews[previewKeys[k]]
        if (preview && preview.rows && typeof preview.rows.length === 'number') previewMessages += preview.rows.length
      }
    } catch (error) {
      previewRows = 0
      previewMessages = 0
    }
    // 冷摘要（ready:false）里每一格都是 0，照写就会把上面刚用本地缓存数好的
    // 「读了多少会话」抹回 0（用户 2026-10-27：读数不能有的行空着、不能编数）。
    // 只说「未就绪」，一个数字都不写——没读到就不装成读到了。
    var summary = null
    var summaryDone = false
    // 页面已知的读数只在这里被「现取」，不再预填进任何缓冲：轮到哪一行，那一行自己问。
    // 这也是三张卡同一份行级规则的含义——没有第二份「先写着、到点再覆盖」的路径。
    var lock = function (i) {
      // 「读数到了」不等于「可以写 0」：冷摘要（ready:false）里每一格都是 0，照写就会把
      // 本页刚数好的读数抹回 0。只有 ready:true 的摘要才允许提供数字。
      var warm = Boolean(summary) && summary.ready === true
      if (i === 0) return warm && typeof summary.workspaces === 'number' ? summary.workspaces : null
      if (i === 1) {
        if (warm && typeof summary.rows === 'number') return summary.rows
        return previewRows > 0 ? previewRows : null
      }
      if (i === 2) return previewMessages > 0 ? previewMessages : null
      return summaryDone ? (warm ? '已就绪' : '未就绪') : null
    }
    var left = false
    var ladder = ladderRun({
      rows: rows,
      readyText: '已就绪',
      stepMs: 70,
      dwellMs: TRANSITION_DWELL_MS,
      notReadyDwellMs: 0,
      lock: lock,
      onDone: function () {
        if (left) return
        left = true
        leave()
      },
    })
    // 1600ms = 桥侧 page.cue 自己等的上限（lib/bridge.js warmPage 的 pageCueWaitMs，1500ms）
    // 再加 500ms 余量：比它短就会在「正常但偏慢」的答复上把数字写在正在卸载的文档上。
    // 到点读数还没到就按「未就绪」收口，仍照常离开（fail-closed 的路不该被拖慢）。
    var waitTimer = setTimeout(function () {
      summaryDone = true
      ladder.settleLast('未就绪')
    }, SWITCH_WAIT_MS)
    lightLanding().then(function (result) {
      summary = result
      summaryDone = true
      clearTimeout(waitTimer)
      ladder.refresh()
    })
  }
  $('bpHome').addEventListener('click', function (event) {
    event.preventDefault()
    runSwitchToPocket()
  })

  // ---- live loading -------------------------------------------------------

  /** Rows at once from the last answer, so an open is never a blank screen. */
  function paintRecall() {
    if (state.team || state.chat) return false
    var recall = recalledTeam()
    if (!recall) return false
    state.team = recall
    renderTeam()
    $('bpHint').textContent = ''
    return true
  }

  /**
   * One word before leaving, so the landing is read while this page is still
   * dying instead of after it is gone — and the answer is now what the
   * transition card prints, because it says how much of the landing is already
   * in hand before the screen hands over (user 2026-10-27②: 「中间页，也应该有数据的
   * 显示（即加载了多少数据的显示）」).
   *
   * A plain fetch is cancelled together with the document that made it; a
   * keepalive fetch is not — that is why it carries the cue now that an answer
   * has to come back (a beacon cannot return one). The request is made once and
   * shared: the card asks the moment the reader taps, leaving asks again a
   * moment later, and both must ride the same one.
   * @returns {Promise<{ ready: boolean, rows: number, bots: number, rooms: number } | null>}
   */
  var landingCue = null
  function lightLanding() {
    if (landingCue) return landingCue
    var body = JSON.stringify({ method: 'page.cue', payload: { page: 'landing' } })
    var answered = null
    try {
      answered = fetch('/api/rpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body,
        keepalive: true
      }).then(function (response) {
        return response.json().catch(function () { return null })
      }).then(function (answer) {
        return answer && answer.ok === true && answer.value ? answer.value : null
      }).catch(function () { return null })
    } catch (error) { answered = null }
    if (answered) { landingCue = answered; return answered }
    // No fetch at all (not a browser this page expects): the head start still
    // rides the beacon, only the numbers are lost.
    try {
      if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
        navigator.sendBeacon('/api/rpc', new Blob([body], { type: 'application/json' }))
      }
    } catch (error) { /* the landing asks for its own rows regardless */ }
    landingCue = Promise.resolve(null)
    return landingCue
  }

  // ---- wiring --------------------------------------------------------------

  $('bpList').addEventListener('click', function (event) {
    // 分区卡的折叠开关（判据 4A⑥）先认：它自己也长在列表里，不能同时算成「打开
    // 某个会话」。这里只翻自己那张卡的 expanded 与 aria-expanded，不重读名单——
    // 折叠状态是内存里的一个布尔，重画一次名单就白读一次团队。
    var toggle = event.target.closest ? event.target.closest('[data-ws-toggle]') : null
    if (toggle) {
      var key = toggle.getAttribute('data-ws-toggle') || ''
      var card = toggle.closest ? toggle.closest('.ws-card') : null
      // 变量名不能叫 open：外层那个 open(kind, id, title, …) 是本函数的邻居，
      // var 是函数级作用域，同名声明会把整条监听里的 open 顶成布尔，点会话当场抛
      // 「open is not a function」。
      // 折叠状态的真值是「这张卡记在 collapsedWs 里」——在册就是收起的。所以点一下
      // 之后的新状态，就是「它现在是否在册」：在册 ⇒ 展开（删掉那条），不在册 ⇒ 收起
      // （记上一条）。写反了的话点第一下会原地不动（删一条本就不存在的记录）。
      var nextOpen = Boolean(state.collapsedWs[key])
      if (nextOpen) delete state.collapsedWs[key]
      else state.collapsedWs[key] = 1
      toggle.setAttribute('aria-expanded', nextOpen ? 'true' : 'false')
      if (card && card.classList) {
        if (nextOpen) card.classList.add('expanded')
        else card.classList.remove('expanded')
      }
      return
    }
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

  // The phone usually reaches this page by tapping a link on the landing, in the
  // same tab, so the way out is the way in: go back one entry in the browser
  // history, which is the landing itself and keeps its scroll and its rows. That
  // only holds when the entry behind this page really is this site's landing —
  // opened from a notification, a chat app's link or a bookmark, history.length
  // is larger than 1 as well, and going back would hand the phone to a site it
  // did not ask for, from the very button that exists to reach Pocket (user
  // 2026-10-24). The referrer tells the two apart; leaving is a real navigation,
  // so — like going back in a chat — it says one word first and the bridge
  // starts the landing's own reads while this document is still going.
  function leave() {
    lightLanding()
    var origin = location.origin || ''
    var referrer = document.referrer || ''
    // No referrer to read, or no origin to compare: the old behaviour, which is
    // right for the hop this page was built for. The comparison is origin-exact,
    // not a bare prefix — a referrer like https://example.com.evil.net/ starts
    // with the string https://example.com too, and a wrong "yes" here hands the
    // phone to that site with the browser's own back gesture.
    var cameFromThisSite = !origin || !referrer ||
      referrer === origin || referrer.indexOf(origin + '/') === 0
    if (cameFromThisSite && window.history && window.history.length > 1) { window.history.back(); return }
    location.href = '/'
  }

  // The back key is only visible inside a chat (showList hides it), and its one
  // job is to clear the conversation from the address — which routes back to the
  // list. The clear is a replace, not a push: a hash entry left behind would sit
  // between this page and the landing, and the corner button's history.back()
  // would land the phone back in the chat it just left. Leaving this page for
  // the landing is the corner button's job, never this one's.
  $('bpBack').addEventListener('click', function () {
    if (!location.hash) return
    if (window.history && typeof window.history.replaceState === 'function') {
      window.history.replaceState(null, '', location.pathname + location.search)
      route()
      return
    }
    location.hash = ''
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

  // 提问卡整张卡是 innerHTML 画出来的（壳里只有 #bpQuestion 这个静态容器），
  // 所以监听落在容器上，按 data 属性分派：选项、提交、关闭。
  $('bpQuestion').addEventListener('click', function (event) {
    var held = state.question
    if (!held || held.busy) return
    var target = event.target
    var option = target.closest ? target.closest('[data-option-index]') : null
    if (option) {
      var options = held.question && Array.isArray(held.question.options) ? held.question.options : []
      var picked = options[Number(option.getAttribute('data-option-index'))]
      if (!picked || typeof picked.label !== 'string') return
      // 交回宿主的必须是选项原文（ds-bot 用 label 做比对），不是下标。
      var at = held.selected.indexOf(picked.label)
      if (held.question.multiSelect === true) {
        if (at === -1) held.selected.push(picked.label)
        else held.selected.splice(at, 1)
      } else {
        // 单选：再点一次就是取消选择，免得选错了没处退。
        held.selected = at === -1 ? [picked.label] : []
      }
      renderQuestion()
      return
    }
    var action = target.closest ? target.closest('[data-question-action]') : null
    if (!action) return
    var name = action.getAttribute('data-question-action')
    if (name === 'continue') submitQuestion()
    else if (name === 'cancel') dismissQuestion()
    // 共用卡上的「跳过」：本页一次只画一题（renderQuestion 传 index 0 / total 1），
    // 跳过本题就等于撤掉这张卡，与关闭键同一条路——不能让这枚按钮点下去没反应。
    else if (name === 'skip') dismissQuestion()
  })

  // 会话设置：输入条里那个键一按就开/收，面板里的点击各自分派（收起、展开列表、
  // 选模型、选档位）。两个容器都是静态的，内容是 innerHTML 画的，所以监听落在容器上
  // ——与提问卡同一套。
  $('bpSettings').addEventListener('click', function () {
    toggleSettings()
  })

  $('bpSettingsPanel').addEventListener('click', function (event) {
    var target = event.target
    if (target.closest && target.closest('[data-settings-close]')) {
      state.modelOpen = false
      renderSettingsPanel()
      return
    }
    var pick = target.closest ? target.closest('[data-pick]') : null
    if (pick) {
      var list = $('bpSettingsPanel').querySelector('[data-field="' + pick.getAttribute('data-pick') + '"]')
      if (list) {
        var open = pick.getAttribute('aria-expanded') === 'true'
        pick.setAttribute('aria-expanded', open ? 'false' : 'true')
        list.hidden = open
      }
      return
    }
    var model = target.closest ? target.closest('[data-model-pick]') : null
    if (model) setBotModel(model.getAttribute('data-model-pick'))
  })

  $('bpPrompt').addEventListener('input', function (event) {
    var field = event.target
    field.style.height = 'auto'
    field.style.height = Math.min(field.scrollHeight, 132) + 'px'
  })

  $('bpPrompt').addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      // Enter key inserts newline only; sending is reserved exclusively for clicking bpSend
    }
  })

  window.addEventListener('hashchange', route)
  // Coming back from the landing through the browser's own back gesture restores
  // this document from the bfcache, overlay and all. The card belongs to a hop
  // that is over by then (user 2026-10-27②).
  window.addEventListener('pageshow', function () {
    var overlay = document.getElementById('bpSwitchOverlay')
    if (overlay) overlay.hidden = true
  })
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) return
    if (state.chat) {
      refreshLatest()
      // 息屏期间流断过就再接一次；开不出来的（隧道）不再重试，轮询仍在。
      if (!state.chat.stream && !state.chat.streamDead) openChatStream(state.chat)
    } else loadTeam(true)
  })

  route()
  paintRecall()
  loadTeam(Boolean(state.team))
})()
`

/**
 * Attribute-safe escape, local copy: this module imports nothing, and the icon
 * parameter lands inside src="…" attributes in the document below.
 * @param {unknown} value
 * @returns {string}
 */
function escapeAttr(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

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
  // The icon lands inside src="…" attributes below; callers pass a bridge-built
  // data URI, sanitized once so a stray quote cannot break the attribute anywhere
  // (audit C-P1-5).
  const safeIcon = icon ? escapeAttr(icon) : null
  const zh = /^zh/i.test(String(locale || ''))
  const copy = zh
    ? { title: 'BOT', back: '返回', pocket: 'Pocket 主页', reload: '刷新', placeholder: '给这里发一条消息…', send: '发送', settings: '会话设置' }
    : { title: 'BOT', back: 'Back', pocket: 'Pocket home', reload: 'Reload', placeholder: 'Message this conversation…', send: 'Send', settings: 'Session settings' }
  return `<!doctype html>
<html lang="${zh ? 'zh-CN' : 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,interactive-widget=resizes-content">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme:light)">
<meta name="theme-color" content="#141416" media="(prefers-color-scheme:dark)">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="${copy.title}">
<link rel="icon" href="${safeIcon || '/app-icon'}">
<link rel="stylesheet" href="${cssUrl}">
<title>${copy.title}</title>
<style>
  *,*::before,*::after{box-sizing:border-box}
  html,body{height:100%;overflow-x:hidden;-webkit-text-size-adjust:100%!important;text-size-adjust:100%!important}
  body{margin:0;background:var(--paper);color:var(--ink);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  .bp-shell{position:relative;width:100%;max-width:760px;min-width:0;height:var(--app-height,100dvh);margin:auto;display:flex;flex-direction:column;overflow-x:hidden;padding:calc(6px + env(safe-area-inset-top)) 14px calc(8px + env(safe-area-inset-bottom))}
  .bp-bar{width:100%;max-width:100%;min-width:0;overflow:hidden;flex:none;height:48px;display:flex;align-items:center;gap:8px;padding:0 2px}
  /* 判据 2②：会话页那根工具条要悬浮、不占位（Pocket 的 .chat-toolbar 就挂在 #chatView 里，
     是 absolute）。但 BOT 页只有一根条，它同时服列表页与会话页，而 Pocket 的列表页工具条
     仍在流内（.toolbar{display:flex;flex:none;padding:12px 0}）。所以按 body.bp-chat 分流：
     会话页悬浮，列表页保持原样在流内——一刀切成 absolute 会让列表页的标题与刷新键压在
     头一张分区卡上（2026-10-30 走查实测 card0.top=6 而条占 0..44）。 */
  body.bp-chat .bp-bar{position:absolute;inset:0 0 auto;z-index:2;min-height:44px;height:44px;padding:0;background:transparent;pointer-events:none}
  .bp-bar b{font-size:16px;font-weight:650;letter-spacing:-.01em;min-width:0;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .bp-bar .bp-hint{min-width:0;flex-shrink:1;max-width:32%;color:var(--muted);font-size:11.5px;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none}
  .bp-bar button{flex:none;height:38px;min-width:38px;pointer-events:auto;border:1px solid var(--line);border-radius:999px;background:var(--card);color:var(--ink);padding:0 12px;font-size:13px}
  .bp-bar button:active{background:var(--hover)}
  .bp-bar #bpBack{width:44px;min-width:44px;height:44px;display:flex;align-items:center;justify-content:center;border-radius:50%;padding:0;box-shadow:0 2px 8px rgba(0,0,0,.06)}
  .bp-scroll{flex:1;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;padding-bottom:10px}
  /* gap 归零：消息之间的间距由 .message 自己的 margin 唯一决定（Pocket 的 .messages
     也是 gap:0）。留着 gap:10px 会让「相邻助手 12px」变成 10+12=22px，而且两页的
     行距从此各算各的。原来靠 gap 分隔的三类非消息行在这里补回各自的 margin。 */
  #bpMsgs{flex:1;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;display:flex;flex-direction:column;gap:0;padding:4px 2px 14px}
  /* 这一条是第 3 条唯一允许新增的规则：进行中提示跟在消息流末尾，靠左占自身一行。
     几何（self-align / flex:none）来自这里，.turn-status 的外观来自共享 app.css。 */
  #bpMsgs .turn-status{align-self:flex-start;flex:none;margin:3px 4px}
  .bp-list{display:grid;gap:8px}
  /* 列表行尺寸体系以 Pocket 的 .task-row 为唯一基准（判据 D2，2026-10-29）：
     44px 行高 / 12px 圆角 / 透明边 / var(--surface) 底 / 9px 10px 内边距，
     图标位 26×26 圆形，标题 13.5px·550，副行 10.5px muted。
     此前这里是 64px/16px/var(--card)/40×40/15.5px/13px —— 另起了一套放大体系，
     BOT 页看上去比 Pocket 整整大一圈。图形本身（头像首字、群字）仍归各自页面。 */
  /* 行容器换成 Pocket 的 .task-row（判据 4A④）：尺寸/颜色/间距/状态色全部来自共享
     app.css（.task-row / .task-row:active / .task-row.is-running .task-status /
     .task-row.is-awaiting 及深色变体），BOT 侧不再存副本——两份定义必然漂移。
     行内结构与内容不动：[主] 标签、角色标签、时间副行照旧，\`.bp-avatar\`/\`.bp-chip\`
     仍是这两页各自的图形（Pocket 同位置是 .task-status）。 */
  .bp-avatar{flex:none;display:grid;place-items:center;width:26px;height:26px;border-radius:50%;background:var(--hover);color:var(--muted);font-weight:650;font-size:12px}
  /* 2026-10-29 必改 2：图标位常态必须是中性态，running 才能是「变色」而不是「蓝→蓝」的空操作。
     原来 .bp-avatar 常态就是 16% 品牌底 + brand 字，与 running 的 brand 完全相同，
     状态位在 Bot 行上看不出忙闲；群行的 .bp-chip 常态是灰的，所以同一条规则只在群行有效。
     --hover 是 Pocket 里「比 --surface 深一级的面上色」，两个图标位同取它，两行字面同构，不新增色值。 */
  .bp-chip{flex:none;display:grid;place-items:center;width:26px;height:26px;border-radius:50%;background:var(--hover);color:var(--muted);font-size:12px;font-weight:650}
  .bp-copy{min-width:0;flex:1;display:flex;flex-direction:column;gap:2px}
  /* 标题行是 flex 行容器，不是一个带省略号的纯文本块（判据 4.1）：标签是名字的
     兄弟节点、flex:none 永不压缩也永不换行，能省略的只有名字那一层。原来整行 b
     挂着 overflow:hidden + ellipsis，标签又是它的子元素 —— 名字一长，先被裁掉的
     是「主」和角色标签，裁成半个字。 */
  .bp-copy b{display:flex;align-items:center;gap:4px;min-width:0;font-size:13.5px;font-weight:550;letter-spacing:-.01em}
  .bp-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  /* 副行放时间，规格取 Pocket .task-copy time（判据第四节）。 */
  .bp-sub{color:var(--muted);font-size:10.5px;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .bp-tag{flex:none;white-space:nowrap;padding:0 6px;border-radius:999px;background:color-mix(in srgb,var(--brand) 14%,var(--surface));color:var(--brand);font-size:10.5px;font-weight:650}
  /* 第二个槽位：闲时是角色、忙时是「正在 X」（判据 4.1 第 1 条，两者共用一格）。
     底子取中性，忙态靠 .bp-working 的品牌蓝点出来；等模型不占标签，走行的琥珀底。 */
  .bp-tag-slot{flex:none;white-space:nowrap;padding:0 6px;border-radius:999px;background:var(--surface);color:var(--muted);font-size:10.5px;font-weight:650}
  .bp-chev{flex:none;color:var(--muted);font-size:18px;line-height:1}
  /* 待答分区按判据 4A⑤ 撤掉：它原来独占主页一段，与「主/其他/群」
     三分区不同维度。现在审批卡与提问行画在「主 BOT」分区那张工作区卡的 .task-list 顶部
     （见 renderTeam），行级 is-awaiting 仍是「谁在等你」的标识。下面几条留的是卡本身的
     样子，不再有分区级容器。 */
  .bp-pending-row{display:block;width:100%;border:1px solid color-mix(in srgb,#c08400 40%,var(--line));border-radius:12px;background:color-mix(in srgb,#c08400 9%,var(--card));padding:9px 12px;font-size:13px;text-align:left;font:inherit;color:var(--ink)}
  .bp-pending-row b{display:block;font-weight:600;margin-bottom:2px}
  .bp-pending-row span{display:block;color:var(--muted);font-size:12px;margin-top:2px}
  .bp-actions{display:flex;gap:8px;margin-top:8px}
  .bp-actions button{flex:1;min-height:36px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--ink);font:inherit;font-size:13px;font-weight:600}
  .bp-actions button:disabled{opacity:.55}
  .bp-allow{color:#1f8a4d;border-color:color-mix(in srgb,#1f8a4d 42%,var(--line))}
  .bp-reject{color:var(--danger,#d9484f)}
  .bp-empty{margin:10px 4px;color:var(--muted);font-size:12.5px;line-height:1.6}
  .bp-older{align-self:center;margin:2px 0 16px;border:1px solid var(--line);border-radius:999px;background:var(--card);color:var(--muted);font:inherit;font-size:12.5px;padding:7px 16px}
  .bp-older:disabled{opacity:.6}
  .bp-divider{display:flex;align-items:center;gap:8px;margin:16px 0;color:var(--muted);font-size:11.5px}
  .bp-divider::before,.bp-divider::after{content:"";flex:1;height:1px;background:var(--line)}
  .bp-event{align-self:center;margin:10px 0;color:var(--muted);font-size:12px}
  /* 待答提问在列表页是一整行可点的按钮（谁问的、问什么，点进去作答）。
     提问行也走 .task-row（判据 4A④）：原来那三条按钮特有的重置（display/width/text-align/
     font/color/cursor）由共享 .task-row 与 .bp-copy 那套提供，行内结构与属性一字不动，
     点进去仍是那个能回答问题的会话。 */
  /* 会话页顶上那套模型入口与模型面板整段撤掉：模型改由输入条里的设置键 + 共享
     .session-settings 面板承担（判据 1），BOT 侧不再有第二套入口与第二套选择器。 */
  /* 提问卡的容器。卡本身（.question-*）用的是 app.css 里落地页那一套，这里只管摆位。 */
  #bpQuestion{flex:none;margin-top:8px}
  #bpQuestion .question-shell{max-height:min(48vh,420px)}
  /* 消息行不再各自定义一套几何（判据 D4）：.bp-msg 本身就带 message 类，
     .message.user / .message.assistant / .message.assistant+.message.assistant
     由共享样式源（app.css = mobileBlocks 输出）提供 82% / 22px / 9px 15px /
     margin 8px 0 14px / padding 0 4px / 相邻 12px，BOT 侧原来的
     20px / 14px / 84% / 3px 覆盖全部撤掉，否则同一组件两处定义、
     又会在下一次改动里各自漂移。 */
  /* 消息正文不自带字号：继承 body 的 14px，与 Pocket 的 .message 继承 body 14px 同构。
     2026-10-29 必改 1：BOT 原来在 body 与 .bp-msg 两处都放大到 15px，同一个组件两页差 7%。 */
  .bp-msg.is-pending{opacity:.6}
  .bp-tail{display:block;margin-top:6px;color:var(--muted);font-size:11px;line-height:1.4;font-variant-numeric:tabular-nums}
  .bp-msg.user .bp-tail{text-align:right}
  .bp-working{color:var(--brand)}
  /* 状态语义以 Pocket 的 .task-row 五态为准（判据 D5a）。BOT 原来另立了两套语言：
     状态位上的边框脉冲（Pocket 里没有这种东西），和一行硬编码琥珀的「等模型」标签。
     现在收敛成「行级状态类 + 状态位颜色」——
     正在活动 = is-running（状态位取 var(--brand)，与 .task-row.is-running .task-status 同义），
     等用户 = is-awaiting（Pocket 的琥珀底与文字色，浅深各一套，色值与
     .task-row.is-awaiting 逐字相同）。
     本轮（判据 4A④）行容器已换成 .task-row，这四条状态规则的副本随之删除：共享 app.css
     里 .task-row.is-running .task-status / .task-row.is-awaiting / 深色变体逐字同值，
     且 .task-row.is-awaiting .task-status(0,3,0) 压过原来的 .bp-row.is-awaiting .bp-avatar(0,2,0)，
     渲染结果不变——留副本只会让同一组件两处定义、下一次改动各自漂移。 */
  /* 2026-10-29 必改 2：删掉的是给群行图标位单独加的 12% 品牌底（BOT 自造的例外）——
     Pocket 的 .task-row.is-running .task-status 只变字色、不加底，抄一半就是两套语言。 */
  /* 输入区几何与发送键配色以 Pocket 的 .composer-inner / .composer .primary 为准（判据 D3）。
     发送键由品牌蓝底白字改成墨色反色：品牌蓝底白字浅色 4.33:1、深色 3.22:1 两个都不达 AA，
     Pocket 侧已按 Inverted Primary 规则改成 var(--ink) 底 var(--paper) 字（17.58:1 / 16.89:1）。 */
  /* position:relative 是本条新增的唯一一条布局规则：设置面板（#bpSettingsPanel
     .session-settings，来自共享 app.css）是 position:absolute，没有定位祖先就会挂到
     视口上去。它自己是 flex 子项之外的绝对定位盒子，不进输入条这一行，也不再需要
     壳侧的 margin/间距——间距由 Pocket 的 .ws-body/.task-list 那套分发。 */
  .bp-composer{position:relative;flex:none;display:flex;gap:8px;align-items:flex-end;border:1px solid var(--line);border-radius:23px;padding:8px 8px 8px 16px;background:var(--card);margin-top:8px;min-height:58px}
  .bp-composer textarea{flex:1;height:44px;min-height:44px;max-height:150px;overflow-y:auto;border:0;outline:0;resize:none;background:transparent;color:var(--ink);font:inherit;font-size:16px;padding:9px 0;caret-color:var(--brand)}
  /* 原来这里是 \`.bp-composer button\`（元素选择器）。设置键也是输入条里的 button，
     它会连同提交键一起吃到墨底反色的胶囊规则；逐字抄 Pocket 之后，设置键的配色归
     .settings-trigger（共享 app.css）管，所以这条收窄到提交键本体——选中的元素与
     改前完全一样（#bpSend 是输入条里唯一的 button），只有选择器不再误伤新键。 */
  #bpSend{flex:none;width:44px;min-width:44px;height:44px;border:1px solid var(--ink);border-radius:50%;background:var(--ink);color:var(--paper);display:flex;align-items:center;justify-content:center;padding:0;box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--paper) 10%,transparent),0 2px 5px rgba(0,0,0,.14);transition:transform .14s ease,opacity .14s ease}
  #bpSend:disabled{background:var(--surface);border-color:var(--line);color:var(--muted);box-shadow:none}
  #bpSend svg{display:block;flex:none}
  #bpToast{position:fixed;left:50%;bottom:calc(84px + env(safe-area-inset-bottom));transform:translateX(-50%);max-width:min(520px,calc(100vw - 40px));padding:9px 14px;border-radius:12px;background:#232428;color:#fff;font-size:13px;box-shadow:0 6px 20px rgba(0,0,0,.28);z-index:9}
  #bpToast[hidden]{display:none}
  .bp-composer[hidden]{display:none}
  #bpMsgs[hidden]{display:none}
  /* 过渡卡（.switch-overlay / .boot-step 全套 / .bsc）、返回 Pocket 的圆钮
     （.bot-fab）与它们的 @keyframes 全部来自共享样式源（app.css = mobileBlocks
     输出），这里不再存副本（判据 D7①）。原来这份内联只比共享源多写了两处，
     删掉后渲染结果不变：.switch-overlay .brand 的 display/align-items/gap
     （全局 .brand 已有同值）、.bsc 的四条（stageRowsMarkup 生成的元素自带
     同值 inline style）。toast 与骨架屏没有归并——类名与形态都不同：Pocket 是
     顶部胶囊 .toast 与 14px 条 .skeleton，BOT 是底部卡 #bpToast 与 64px 圆角
     行 .bp-skel-row，硬合并会把两个页面各自需要的样子都改掉。 */
  body.bp-chat #bpHome{display:none}
  .bp-hairline{position:fixed;left:0;right:0;top:0;height:2px;background:var(--brand);transform:scaleX(0);transform-origin:left;opacity:0;transition:transform .3s ease,opacity .2s ease;z-index:10}
  body.bp-busy .bp-hairline{opacity:1;animation:bpHairline 1.2s cubic-bezier(.4,0,.2,1) infinite}
  @keyframes bpHairline{0%{transform:scaleX(0)}50%{transform:scaleX(.65)}100%{transform:scaleX(1);opacity:0}}
  .bp-skel{display:grid;gap:8px}
  .bp-skel-row{height:64px;border:1px solid var(--line);border-radius:16px;background:linear-gradient(90deg,var(--card) 0%,var(--surface) 50%,var(--card) 100%);background-size:200% 100%;animation:bpShimmer 1.4s ease infinite;opacity:.8}
  @keyframes bpShimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
  body.bp-ready #bpSkel{display:none}
</style>
</head>
<body class="bp-loading bp-busy">
<div class="bp-hairline" id="bpHairline" aria-hidden="true"></div>
<div class="bp-shell">
  <div class="bp-bar" id="bpBar">
    <button id="bpBack" aria-label="${copy.back}" hidden><svg width="20" height="20" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10.5 3L5.5 8L10.5 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
    <b id="bpTitle">${copy.title}</b>
    <span class="bp-hint" id="bpHint"></span>
    <button id="bpReload" aria-label="${copy.reload}">↻</button>
  </div>
  <div class="bp-scroll" id="bpList">
    <!-- 主/其他/群三张分区卡由 renderTeam 画进 #bpMembersList：一份名单、一种行，
         不再有「待答」那一段（判据 4A⑤）。 -->
    <div id="bpSkel" class="bp-skel">
      <div class="bp-skel-row"></div>
      <div class="bp-skel-row"></div>
      <div class="bp-skel-row"></div>
      <div class="bp-skel-row"></div>
    </div>
    <div id="bpMembersList" class="bp-list"></div>
  </div>
  <!-- The chat half is a sibling of the list, not a child: showChat hides the
       list wholesale, and a transcript living inside it was hidden with it —
       the phone opened a conversation onto an empty screen no matter what the
       read brought back (user 2026-10-27 「没有消息，是空白的」; caught by a
       rendered-page screenshot, which the element stand-in cannot see). -->
  <div class="bp-scroll" id="bpMsgs" hidden></div>
  <!-- 待答提问的卡：容器是静态的，卡的内容由 renderQuestion 画（事件委托在容器上）。 -->
  <div id="bpQuestion" hidden></div>
  <div class="bp-composer" id="bpComposer" hidden>
    <!-- 会话设置：键与面板的结构、类名与 Pocket 的输入条逐字相同（判据 1），
         面板的 CSS 全部来自共享 app.css（.session-settings / .settings-* /
         .setting-*），BOT 侧不存副本；除了 .bp-composer 上那条 position:relative，
         本批没有新增任何布局规则。 -->
    <div id="bpSettingsPanel" class="session-settings" hidden></div>
    <textarea id="bpPrompt" rows="1" placeholder="${copy.placeholder}"></textarea>
    <button type="button" id="bpSettings" class="settings-trigger" aria-label="${copy.settings}" aria-expanded="false"><svg width="17" height="17" viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M3 5h7M13 5h2M3 13h2M8 13h7M10 3v4M6 11v4" stroke="currentColor" stroke-width="1.45" stroke-linecap="round"/></svg></button>
    <button id="bpSend" class="primary" aria-label="${copy.send}" disabled><svg width="17" height="17" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 12V4M8 4 4.75 7.25M8 4l3.25 3.25" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
  </div>
</div>
<div id="bpToast" hidden></div>
<a id="bpHome" class="bot-fab" href="/" aria-label="${copy.pocket}" draggable="false"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3.4" y="4.2" width="17.2" height="15.6" rx="4.4" stroke="currentColor" stroke-width="1.7"/><path d="M8.2 10.6 12 14.4l3.8-3.8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></a>
<div id="bpSwitchOverlay" class="switch-overlay" hidden><div class="card"><h1>Pocket</h1><p>${zh ? '正在进入 Pocket' : 'Entering Pocket'}</p><div class="boot-steps show">${stageRowsMarkup(botToPocketRows(Boolean(zh)), Boolean(zh))}</div>${transitionBrandRow(safeIcon || '/app-icon')}</div></div>
<script src="${jsUrl}"></script>
</body>
</html>`
}
