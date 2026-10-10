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
 *  - **邮班**（dispatch）＝ 一次发送。三种时机发车，谁先到算谁：
 *      · 包里攒够 `lettersMax` 封 —— 装满了就走；
 *      · 最后一封进来后安静 `rideMs` —— 这一波收尾了，别让人干等（末班车）；
 *      · 最早一封压了 `holdMs` 还没走 —— 强制发车，来再多也不能把第一封压没。
 *    另外任何一趟已发的信（挂号信、或你按了桌面「测试」）都**顺路把包里的平邮带走**：
 *    车都开了，信就别留在邮局。
 *
 * 用户给的时间尺度是「十几二十分钟」，所以默认 `rideMs` 6 分钟、`holdMs` 20 分钟：
 * 只跑完一件事时你大约 6 分钟后收到（不会等到 20），连着跑完一批时最迟 20 分钟一趟，
 * 一批里塞得下 8 件事。压后的代价要说清：超过 `ttlMs`（默认 2 小时）的平邮就不寄了——
 * 隔了半天再告诉你「某个会话昨晚跑完了」，那是噪音不是消息，丢掉并在日志里说明。
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
 *   lettersMax?: number    一封装几件就发车
 *   rideMs?: number        最后一件进来后安静多久发车（末班车）
 *   holdMs?: number        最早一件最多被压多久（强制发车）
 *   registeredMax?: number 待补投的挂号信数量上限
 *   ttlMs?: number         平邮在包里放多久就作废
 * }} [limits]
 */
export function createMailbag(limits = {}) {
  const lettersMax = Math.floor(num(limits.lettersMax, 8))
  const rideMs = num(limits.rideMs, 6 * 60_000)
  const holdMs = num(limits.holdMs, 20 * 60_000)
  const registeredMax = Math.floor(num(limits.registeredMax, 8))
  const ttlMs = num(limits.ttlMs, 2 * 60 * 60_000)

  /** @type {{ title: string, body: string, key: string }[]} */
  const registered = []
  /** 平邮按会话去重（同一个会话跑完两次只说一次）；插入顺序就是要发的顺序。 */
  const ordinary = new Map()
  /** 最近一件平邮进包的时间：末班车看的是它，不是最早那件。 */
  let lastInAt = 0
  /** 因为太旧被作废掉的平邮封数——发信时要说一声，不静默吞。 */
  let voided = 0

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
    if (inAt >= lastInAt) lastInAt = inAt
    return true
  }

  /** 把太旧的平邮作废掉，返回作废了几封。 */
  function voidStale(now) {
    if (!Number.isFinite(now)) return 0
    let dropped = 0
    for (const [key, item] of [...ordinary]) {
      if (now - item.inAt > ttlMs) {
        ordinary.delete(key)
        dropped += 1
      }
    }
    voided += dropped
    return dropped
  }

  /**
   * 这一班该发了吗。
   * @param {number} now
   * @returns {boolean}
   */
  function due(now) {
    if (ordinary.size === 0) return false
    if (ordinary.size >= lettersMax) return true
    if (Number.isFinite(now) && now - lastInAt >= rideMs) return true
    const oldest = ordinary.values().next().value
    if (oldest && Number.isFinite(oldest.inAt) && now - oldest.inAt >= holdMs) return true
    return false
  }

  /**
   * 取出这一班要寄的东西，并清空邮包。
   *
   * 取走即清空；寄失败的挂号信由调用方用 {@link post} 放回来——这正是
   * 「你在等的那件事不能因为额度用完就消失」的落点。平邮失败时也放回来，
   * 但放回的时间戳不变不了（`post` 会盖成当前时间），所以真卡住时它最终会
   * 被 `ttlMs` 作废，而不是无限堆着。
   * @param {number} now
   * @returns {{ registered: { title: string, body: string, key: string }[], ordinary: { title: string, body: string, key: string }[] }}
   */
  function take(now) {
    voidStale(now)
    const gone = registered.length > 0 ? registered.splice(0, registered.length) : EMPTY
    const mail = []
    if (ordinary.size > 0) {
      for (const item of ordinary.values()) mail.push(item)
      ordinary.clear()
      lastInAt = 0
    }
    const expired = voided
    voided = 0
    return { registered: gone, ordinary: mail, voided: expired }
  }

  return {
    post,
    due,
    take,
    voidStale,
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
    },
    get voidedCount() {
      return voided
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
    title: `${list.length} 个会话${shared || '有进展'}`.slice(0, titleMax),
    body: lines.join('\n')
  }
}

// 落盘不在这里：桥用 `ordinaryLetters()` 取快照、用 `post(POST_ORDINARY, {…letter, inAt})`
// 灌回来（`inAt` 会被认出来，重启前已经压了 18 分钟的平邮不会重新数封顶时间），
// 文件读写在 lib/mailbag-store.js。作废判定只有一处（`voidStale` 用的 `ttlMs`），
// 不在恢复路径上再写第二个时限。

