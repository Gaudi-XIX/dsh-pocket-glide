/**
 * 邮包（mailbag）：不急的消息先攒进包里，攒成一趟一起寄；急的（挂号信）当场就送。
 *
 * 为什么要有这只包。微信那边一条入站只换 10 条出站推送，而老写法是**每个跑完的会话
 * 各自寄一封**：几个会话同一分钟交活，10 条额度一秒内就烧穿了（本机 2026-10-10
 * 09:34:23 实测：一秒 13 发、12 发被拒），紧接着真正要命的那封「有提问等你回答」
 * 也就寄不出去了。省的办法不是少说事，是**把同一批的事装进同一封信**。
 *
 * 三种角色，一套邮政的说法：
 *  - **挂号信**（`POST_REGISTERED`）＝ 提问、报错停止：你在等它，投出去就算完事，
 *    不排队、不合并；这一趟没送出去（额度空了）就留在手里，下次邮班**第一件补它**。
 *  - **平邮**（`POST_ORDINARY`）＝ 任务完成：不催人，可以等下一班邮车一起走。
 *  - **邮班**（dispatch）＝ 一次发送。
 *
 * 发车规则只有**两条**（用户 2026-10-10 22:33 亲口砍到这么简单：
 * 「只有特殊消息立即发；你进手机端立即重置待发送，打个时间戳啥的；否则最早一条满 15 分钟
 * 打包发一条摘要。就这么简单」）：
 *  - **最早一件压满 `holdMs`（15 分钟）** ⇒ 打包发一条摘要；
 *  - **你进了手机端** ⇒ 立刻重置计时（{@link notePresence}），包**留着不发**。
 *
 * 砍掉了什么、为什么：
 *  - `lettersMax`（攒够 5 件就走）——它和「满 15 分钟」是同一件事的两种量度，
 *    而它带来的额外行为是「任务密的时候提前发」；用户要的是**时间**一个尺度。
 *  - `rideMs`（最后一件进来后安静 15 分钟）——它的动因是「别让人干等这一波收尾」，
 *    但用户的原话是「**最早一条**满 15 分钟」，看的是最早那件，不是最后一波。
 *    留着它就有了两个时间尺度（15 和 30 并存），那正是用户说的「太复杂了」。
 *  - 于是 `holdMs` 从 30 分钟改成 **15 分钟**：它现在是**唯一**的时间尺度。
 *
 * 「进手机端就重置」是什么意思（用户原话「打个时间戳啥的」）：人在页面前台，
 * 消息他会直接看到，推送就是噪音；而重置计时的效果是**他放下手机之后才重新开始数 15 分钟**。
 * 所以这不是「在场就不推」，是「刚看过就不用再告诉他一遍」。
 *
 * **包里没有「放太久就作废」这条规矩**（用户 2026-10-10 20:55 定的，理由见下）：
 * 既然「最早一件满 15 分钟」这条封顶在，正常路径下一封信在包里最多躺一刻钟——一个「两小时」
 * 的作废阈值在正常情况下永远轮不到触发，它只为「额度死着、信发不出去」那个故障状态兜底，
 * 而那正是最不该丢信的场合：微信卡了一早上，等它通了，这些事就该一次全发过来。
 * 所以发车那一刻**不筛、不丢**，包里有什么发什么。代价是额度长期死掉时包会越积越多，
 * 这个代价用户认了——「卡住了该发就发」比「替你决定哪件不算数」重要。
 *
 * 只有微信 ClawBot 有「10 条」这回事，所以只有它会真把信留在包里不发；
 * Server酱／Bark／WxPusher 没有额度，包一样攒，但发车时不会被挡。
 *
 * 这里不读时钟、不碰磁盘、不抛异常：`now` 由调用方传进来，落盘在 lib/mailbag-store.js，
 * 所以整套班次规则能用一个手工时钟全部测完。
 */

/** 挂号信：立刻送，送不出去就留着补投。 */
export const POST_REGISTERED = 'registered'
/** 平邮：进邮包，等下一班。 */
export const POST_ORDINARY = 'ordinary'

const EMPTY = Object.freeze([])

/** @param {unknown} value @returns {string} */
function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** @param {unknown} value @param {number} fallback @returns {number} */
function num(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * @param {{ title?: unknown, body?: unknown, key?: unknown }} letter
 * @returns {{ title: string, body: string, key: string } | null}
 */
function normalize(letter) {
  const title = text(letter?.title)
  const body = text(letter?.body)
  if (!title && !body) return null
  return { title, body, key: text(letter?.key) || `t:${title}` }
}

/**
 * 造一只邮包。
 * @param {{
 *   holdMs?: number        最早一件最多被压多久（超过就打包发一条摘要）——唯一的时间尺度
 *   registeredMax?: number 待补投的挂号信数量上限
 * }} [limits]
 */
export function createMailbag(limits = {}) {
  const holdMs = num(limits.holdMs, 15 * 60_000)
  const registeredMax = Math.floor(num(limits.registeredMax, 8))

  /** @type {{ title: string, body: string, key: string }[]} */
  const registered = []
  /** 平邮按会话去重（同一个会话跑完两次只说一次）；插入顺序就是要发的顺序。 */
  const ordinary = new Map()

  /**
   * 投一件东西进邮包。
   * @param {string} kind {@link POST_REGISTERED} 或 {@link POST_ORDINARY}
   * @param {{ key?: string, title: string, body: string }} letter
   * @param {number} now
   * @returns {boolean} 收下了没有（空信不收）
   */
  function post(kind, letter, now) {
    const item = normalize(letter)
    if (!item) return false
    if (kind === POST_REGISTERED) {
      registered.push(item)
      while (registered.length > registeredMax) registered.shift()
      return true
    }
    ordinary.delete(item.key)
    // 落盘恢复时会带 `inAt` 回来：重启前已经压了 18 分钟的平邮，重启后 2 分钟就该走，
    // 不该重新数一遍封顶时间。没有这个字段才是新进来的信。
    const inAt = Number.isFinite(letter?.inAt) ? letter.inAt : now
    ordinary.set(item.key, { ...item, inAt })
    return true
  }

  /**
   * 你刚才在手机端（页面前台）露过面 —— 把整个包的计时**按现在重新起算**。
   *
   * 用户 2026-10-10 22:33 的原话：「你进手机端立即重置待发送，打个时间戳啥的」。
   * 人在页面前台，这些消息他本来就看得到，推送是噪音；而重置计时的效果是
   * **他放下手机之后才重新开始数那 15 分钟**。
   *
   * 只动时间戳、**不取走也不丢弃**包里的信：下一刻他锁屏出门，攒着的仍然会发。
   * 空包时什么都不做（没有东西需要重新计时）。
   * @param {number} now
   * @returns {number} 被重新计时的件数（0 ＝ 包里本来就没有）
   */
  function notePresence(now) {
    if (!Number.isFinite(now) || ordinary.size === 0) return 0
    for (const [key, letter] of ordinary) ordinary.set(key, { ...letter, inAt: now })
    return ordinary.size
  }

  /**
   * 这一班该发了吗：**只有一个条件** —— 最早那件压满 `holdMs`。
   *
   * 空包永远不到点（`ordinary.size === 0` 先挡掉），所以 `notePresence` 把
   * `inAt` 推到未来也不会让空包发车。
   * @param {number} now
   * @returns {boolean}
   */
  function due(now) {
    if (ordinary.size === 0) return false
    const oldest = ordinary.values().next().value
    if (oldest && Number.isFinite(oldest.inAt) && now - oldest.inAt >= holdMs) return true
    return false
  }

  /**
   * 取出这一班要寄的东西，并清空邮包。
   *
   * 取走即清空；寄失败的挂号信由调用方用 {@link post} 放回来——这正是
   * 「你在等的那件事不能因为额度用完就消失」的落点。平邮失败时也放回来，
   * 重复的会按 key 去重，所以不会堆成两封。
   * @param {number} now
   * @returns {{ registered: { title: string, body: string, key: string }[], ordinary: { title: string, body: string, key: string }[] }}
   */
  function take(now) {
    const gone = registered.length > 0 ? registered.splice(0, registered.length) : EMPTY
    const mail = []
    if (ordinary.size > 0) {
      for (const item of ordinary.values()) mail.push(item)
      ordinary.clear()
    }
    return { registered: gone, ordinary: mail }
  }

  return {
    post,
    due,
    notePresence,
    take,
    /** 包里现在有哪些平邮（只读，不取走）——落盘快照用。 */
    ordinaryLetters() {
      return [...ordinary.values()]
    },
    /** @param {number} now */
    pressureMs(now) {
      const oldest = ordinary.values().next().value
      if (!oldest || !Number.isFinite(oldest.inAt) || !Number.isFinite(now)) return 0
      return Math.max(0, now - oldest.inAt)
    },
    get ordinaryCount() {
      return ordinary.size
    },
    get registeredCount() {
      return registered.length
    }
  }
}

/**
 * 把包里的平邮封口成一封信（一封信只占一条额度）。
 *
 * 只有一件事时**保持原样**：标题是会话名、正文说清为什么（0.4.10 已验收的样子不动）。
 * 两件以上才有汇总的必要，写法按「人会不会先看标题」定：
 *  - 理由都一样（常见：都是跑完了）→ 标题把理由说掉，正文只列名字，不重复；
 *  - 理由不一样（跑完的和停了的混在一封里）→ 标题只说「有进展」，正文逐行带上各自理由。
 * 一次最多列 `listMax` 行，折掉多少要写在信里——不静默吞。
 *
 * **标题带上名字**（0.4.18，A 问「微信消息提示的时候，显示是哪个会话的消息」）。
 * 动因是 `lib/notify.js` 的最终线形状就是 `` `${title}\n\n${body}` ``——微信在通知栏
 * 只显示第一行，名字写在正文里等于没有：多会话收尾那一封原本只说「N 个会话已完成」，
 * 看不出是哪几个。现在标题在 `titleMax` 之内尽量把名字列上
 * （`2 个会话已完成：写周报、部署`），装不下或还有没列出的补一个「等」，
 * 不假装列全了；正文照旧逐行。
 *
 * @param {{ title: string, body: string }[]} letters
 * @param {{ titleMax?: number, listMax?: number }} [shape]
 * @returns {{ title: string, body: string }}
 */
export function sealOrdinaryMail(letters, shape = {}) {
  const titleMax = num(shape.titleMax, 60)
  const listMax = Math.floor(num(shape.listMax, 8))
  const list = (Array.isArray(letters) ? letters : [])
    .map((letter) => ({ title: text(letter?.title), body: text(letter?.body) }))
    .filter((letter) => letter.title || letter.body)
  if (list.length === 0) return { title: '', body: '' }
  if (list.length === 1) return { title: list[0].title, body: list[0].body }

  const shared = list.every((letter) => letter.body === list[0].body) ? list[0].body : ''
  const shown = list.slice(0, listMax)
  const hidden = list.length - shown.length
  const lines = shown.map((letter) =>
    shared ? `· ${letter.title}` : `· ${letter.title}${letter.body ? `：${letter.body}` : ''}`
  )
  if (hidden > 0) lines.push(`· 另有 ${hidden} 个就不列了`)
  return {
    title: mailTitle(list.length, shared || '有进展', shown.map((letter) => letter.title), hidden > 0, titleMax),
    body: lines.join('\n')
  }
}

/**
 * 汇总信的第一行：先说数量与理由，再把名字塞进剩下的预算里。
 * 名字是一个一个试的——放不下就不放，不砍半个名字；只要还有名字没进标题
 * （无论是被预算挡掉还是被 `listMax` 折掉），末尾补「等」。
 * @param {number} count
 * @param {string} reason
 * @param {string[]} names
 * @param {boolean} hasMore
 * @param {number} titleMax
 * @returns {string}
 */
function mailTitle(count, reason, names, hasMore, titleMax) {
  const listed = names.filter((name) => name.length > 0)
  let title = `${count} 个会话${reason}`
  let placed = 0
  for (const name of listed) {
    const joiner = placed === 0 ? '：' : '、'
    if (title.length + joiner.length + name.length > titleMax) break
    title += joiner + name
    placed += 1
  }
  if (placed > 0 && (hasMore || placed < listed.length) && title.length + 1 <= titleMax) title += '等'
  return title.slice(0, titleMax)
}

// 落盘不在这里：桥用 `ordinaryLetters()` 取快照、用 `post(POST_ORDINARY, {…letter, inAt})`
// 灌回来（`inAt` 会被认出来，重启前已经压了 18 分钟的平邮不会重新数封顶时间），
// 文件读写在 lib/mailbag-store.js。这里**没有任何时限判定**——发车只看 `due()` 那三条，
// 进包即留到发车为止（见文件头「包里没有放太久就作废这条规矩」）。

