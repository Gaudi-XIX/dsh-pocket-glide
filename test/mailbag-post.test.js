// 邮包接在桥上（0.4.12）。这四件事单元测试看不见，却是这版真正要保的：
//   1. 一批同时跑完的会话**发一封**，不是一个 tick 把 10 条额度点光
//      （线上实测 2026-10-10 09:34:23：一秒 13 发、12 发被拒）；
//   2. 服务端说这轮没额度了，信是**留下**而不是丢掉，下一次入站补发——
//      包括 `context_token` 字符串没变的那种入站（续期发生在每一条入站上）；
//   3. 「通道已就绪」只在首次绑定发一次：续期再发就是白拿一条额度去说废话；
//   4. 包落盘：宿主重启（这台机今天已经重启几次了）不该把攒着的完成通知一起带走。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startBridge, httpFetch } from './helpers.js'
import { createSettingsStore } from '../lib/settings-store.js'
import { createMailbagStore, mailbagPath } from '../lib/mailbag-store.js'
import { POST_REGISTERED } from '../lib/mailbag.js'
import { NOTIFY_JUDGE_THRESHOLDS, NOTIFY_MAILBAG, NOTIFY_MAIL_LIST_MAX } from '../lib/bridge.js'

const B = NOTIFY_MAILBAG
const J = NOTIFY_JUDGE_THRESHOLDS
const BOT = 'bot_token_mailbag'
const CTX = 'ctx_mailbag'

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/**
 * 删掉一整个临时目录，删不动就重试。
 *
 * Windows 上文件被刚释放的句柄多占几十毫秒是常态：桥的落盘写是异步的，
 * 即便 `await t.stop()` 已经回来，最后一个原子改名的句柄也可能还没关。
 * 裸 `rmSync` 这时抛 EBUSY/EPERM，而它在 `finally` 里 —— 异常会把已经通过的
 * 断言整档带红，同时把目录留在 `%TEMP%`（实测积到 252 个 `dsh-pocket-mailbag-settings-*`）。
 * 重试是唯一的办法：`force: true` 只吞 ENOENT，吞不掉共享冲突。
 */
async function removeTempDir(dir, attempts = 8) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      // maxRetries/retryDelay 交给 fs 自己处理瞬时共享冲突；外面这层兜的是
      // 桥的异步落盘句柄（释放比 t.stop() 回来晚）。
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 })
      return
    } catch (error) {
      if (i === attempts - 1) throw error
      await new Promise((resolve) => setTimeout(resolve, 25 * (i + 1)))
    }
  }
}

/**
 * 一只 clawbot 桥，整条外线都是录影。
 *
 * 每个应答同时给 `json()` 和 `text()`：iLink 客户端读 sendmessage 用 `.text()`
 * （64 位 message_id 不能走 JSON.parse），读 getupdates/notifystart 用 `.json()`。
 *
 * @param {{ refuse?: boolean, mailbagStore?: object, settingsStore?: object, contextToken?: string }} [behaviour]
 *   refuse ＝ 服务端回 prepare failed；mailbagStore ＝ 用真的落盘 store；
 *   contextToken 传空串＝刚绑定还没换到过令牌的存档（首绑那一封回执的判据）
 */
function makeFixture(behaviour = {}) {
  // 传了 settingsStore 就别再开目录：那只目录没人会用、也没人知道它存在，
  // 于是它留在 %TEMP% 里（实测每跑一轮漏 3 个，两个就是这么来的）。
  const dir = behaviour.settingsStore ? undefined : makeTempDir('dsh-pocket-mailbag-')
  const store = behaviour.settingsStore ?? createSettingsStore(dir)
  store.save({
    notify: {
      channel: 'clawbot',
      key: BOT,
      enabled: true,
      clawbot: {
        botToken: BOT,
        userId: 'user_mb',
        contextToken: behaviour.contextToken === undefined ? CTX : behaviour.contextToken
      }
    }
  })
  const sent = []
  const state = {
    refuse: behaviour.refuse === true,
    inbound: null,
    items: [],
    at: 10_000_000
  }
  const notifyFetchImpl = async (url, options) => {
    const u = String(url)
    if (u.includes('/sendmessage')) {
      const body = JSON.parse(options.body)
      const text = body.msg.item_list[0].text_item.text
      sent.push({
        text,
        token: body.msg.context_token,
        refused: state.refuse,
        // 入站的隧道地址交接不是通知：它一条入站只交接一次（地址变了才说），
        // 不计入通知额度、也不参与「这一班寄了几封」的计数。所以额外标一个 kind，
        // 让按业务计数的断言能把它排除掉（同样的事也发生在生产：它不走 clawbotQuotaTail）。
        kind: text.startsWith('Pocket 已打开') || text.startsWith('Pocket 隧道没打开')
          ? 'door'
          : 'notice'
      })
      const payload = state.refuse
        ? { ret: -2, errmsg: 'prepare failed' }
        : { ret: 0, message_id: 7514520117146685576 }
      return {
        ok: true,
        status: 200,
        json: async () => payload,
        text: async () => JSON.stringify(payload)
      }
    }
    if (u.includes('/getupdates')) {
      const msg = state.inbound
      state.inbound = null
      const payload = { ret: 0, msgs: msg ? [msg] : [], get_updates_buf: 'buf_1' }
      return {
        ok: true,
        status: 200,
        json: async () => payload,
        text: async () => JSON.stringify(payload)
      }
    }
    if (u.includes('api.day.app')) {
      // Bark 把消息放进路径：/key/<标题>/<正文>。解出来才看得见「换通道后寄了什么」。
      sent.push({ text: decodeURIComponent(u), token: '', refused: false })
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' }
    }
    return { ok: true, status: 200, json: async () => ({ ret: 0 }), text: async () => '{"ret":0}' }
  }
  const bridgePromise = startBridge({
    harness: 'fake',
    harnessOptions: {
      respond: (pathname) =>
        pathname === '/api/session/list' ? { ok: true, value: { items: state.items } } : undefined
    },
    bridgeOptions: {
      settingsStore: store,
      notifyFetchImpl,
      now: () => state.at,
      // 入站会让桥去确保公网隧道在跑（「在微信说一句就能拿到能打开的地址」）。必须打桩：
      // 不打桩会真的 ensureCloudflared，下载 54MB 真二进制并写进本机共享缓存，把同批跑的
      // tunnel.test.js 全档带红（实测 mailbag-post + tunnel 连跑必红 11 档，单独跑全绿）。
      // 这几档测的是邮包，不是隧道。
      createCloudflareTunnel: async () => ({
        url: 'https://mailbag-test.trycloudflare.com',
        provider: 'cloudflare',
        stop: async () => {},
        process: { once: () => {} }
      }),
      ...(behaviour.mailbagStore ? { mailbagStore: behaviour.mailbagStore } : {})
    }
  })
  // notices ＝ 只看通知（排除入站那条隧道地址交接）。按业务计数的断言用这个，
  // 免得把「顺路搭的一句话」算成「寄了一封信」。
  const notices = () => sent.filter((s) => s.kind !== 'door')
  return { dir, sent, notices, state, store, bridgePromise }
}

const tick = async (t) => {
  t.bridge._sessionListCache = undefined
  await t.bridge.pollNotifyRunning()
}

/**
 * 把若干会话推到「判为跑完」。判据要求这段工作被**证明过**才算跑完：
 * 两次 running 观测跨过 minBusyMs 才武装 longBusy，之后翻面才在 graceMs 之后判定完成。
 */
async function runThenSettle(t, fx, rows) {
  fx.state.items = rows.map((row) => ({ ...row, running: true, updatedAt: fx.state.at }))
  await tick(t)
  fx.state.at += J.minBusyMs + 10_000
  await tick(t)
  fx.state.at += 30_000
  fx.state.items = rows.map((row) => ({ ...row, running: false, updatedAt: fx.state.at - J.graceMs }))
  await tick(t)
}

/** 把时钟推过封顶时间（15 分钟）并再走一轮。 */
async function rideTheBus(t, fx) {
  fx.state.at += B.holdMs + 1
  await tick(t)
}

const settleFor = async (what, limitMs = 9000) => {
  const deadline = Date.now() + limitMs
  for (;;) {
    if (what()) return
    if (Date.now() > deadline) throw new Error('邮车没跟上')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

test('一批会话同时跑完只发一封：一封摘要列不下的要说出来', async () => {
  const fx = makeFixture()
  const t = await fx.bridgePromise
  try {
    // 比一封摘要列得下的行数多一个，正好把「折行要说明」测了。
    // 0.4.17 起发车只看时间（最早一件满 15 分钟），所以这里靠 rideTheBus 推时钟，
    // 不再靠「装满就走」——名字的条数现在只影响信里列几行。
    const names = Array.from({ length: NOTIFY_MAIL_LIST_MAX + 1 }, (_, i) => `任务${i + 1}`)
    const rows = names.map((title, i) => ({ sessionId: `s${i}`, title }))
    await runThenSettle(t, fx, rows)
    await rideTheBus(t, fx)

    assert.equal(fx.notices().length, 1, '一趟就发完了，不是九趟')
    assert.ok(fx.notices()[0].text.includes(`${names.length} 个会话已完成`), fx.notices()[0].text)
    for (const name of names.slice(0, NOTIFY_MAIL_LIST_MAX)) {
      assert.ok(fx.notices()[0].text.includes(name), `列出来的名字要在：${name}`)
    }
    assert.ok(fx.notices()[0].text.includes(`另有 1 个就不列了`), '折掉的数量要说出来')
    assert.ok(fx.notices()[0].text.includes('（第 1/10 条）'), '九件事只花掉一条额度')
    assert.equal(t.bridge.mailbag.ordinaryCount, 0, '发完包就空了')
  } finally {
    await t.stop()
    await removeTempDir(fx.dir)
  }
})

test('只跑完一件事时不立刻发，等末班车', async () => {
  const fx = makeFixture()
  const t = await fx.bridgePromise
  try {
    await runThenSettle(t, fx, [{ sessionId: 'solo', title: '一个人' }])
    assert.equal(fx.sent.length, 0, '一件也在包里等末班车')
    assert.equal(t.bridge.mailbag.ordinaryCount, 1)
    await rideTheBus(t, fx)
    assert.equal(fx.sent.length, 1, '安静到点就发')
    assert.ok(fx.sent[0].text.includes('一个人'), '只有一件时保持原形状：标题就是会话名')
    assert.ok(fx.sent[0].text.includes('已完成'))
  } finally {
    await t.stop()
    await removeTempDir(fx.dir)
  }
})

test('服务端说没额度时信留在包里，下一次入站（哪怕令牌没变）立刻补发', async () => {
  const fx = makeFixture({ refuse: true })
  const t = await fx.bridgePromise
  try {
    await runThenSettle(t, fx, [{ sessionId: 'a', title: '甲' }])
    await rideTheBus(t, fx)

    assert.equal(fx.sent.length, 1, '试过一次')
    assert.equal(t.bridge.clawbotQuotaSpent, true, 'prepare failed 定性为「这轮没额度」')
    assert.equal(t.bridge.mailbag.ordinaryCount, 1, '被拒的不是丢掉，是留在包里')

    // 额度没回来之前再多跑完两件：只攒不发，不去每 30 秒撞一次墙。
    const tries = fx.sent.length
    await runThenSettle(t, fx, [
      { sessionId: 'b', title: '乙' },
      { sessionId: 'c', title: '丙' }
    ])
    for (let i = 0; i < 3; i++) {
      fx.state.at += 30_000
      await tick(t)
    }
    assert.equal(fx.sent.length, tries, '没额度期间不发班，免得白吃拒')
    assert.equal(t.bridge.mailbag.ordinaryCount, 3, '新跑完的排在后面')

    // 用户在微信回一句。令牌照旧是同一个字符串——续期照样发生。
    fx.state.refuse = false
    fx.state.inbound = { context_token: CTX, from_user_id: 'user_mb' }
    await settleFor(() => fx.notices().length >= 2)

    assert.equal(fx.notices().length, 2, '一次入站补发一封（同令牌不走「首次绑定」那封回执）')
    assert.equal(t.bridge.clawbotQuotaSpent, false)
    const last = fx.notices()[1].text
    assert.ok(last.includes('3 个会话已完成'), last)
    for (const name of ['甲', '乙', '丙']) assert.ok(last.includes(name))
    assert.ok(last.includes('（第 1/10 条）'), '续期后从第 1 条重新数')
  } finally {
    await t.stop()
    await removeTempDir(fx.dir)
  }
})

test('「通道已就绪」只在首次绑定发，之后每轮回话不再白占一条额度', async () => {
  // contextToken 传空串＝刚扫完码、还没换到过令牌的存档，也就是「首绑」那个状态。
  const fx = makeFixture({ contextToken: '' })
  const t = await fx.bridgePromise
  try {
    fx.state.inbound = { context_token: CTX, from_user_id: 'user_mb' }
    await settleFor(() => fx.sent.length >= 1)
    assert.ok(fx.sent[0].text.includes('通道已就绪'), fx.sent[0].text)
    assert.equal(fx.sent[0].token, CTX, '回执用的是刚换到的令牌')

    // 之后再回一句：令牌换了值（额度确实续上了），但不再发回执。
    fx.state.inbound = { context_token: `${CTX}_2`, from_user_id: 'user_mb' }
    await settleFor(() => t.bridge.notifyConfig.clawbot.contextToken === `${CTX}_2`)
    fx.state.at += 3_000
    // 这一档问的是「续期还发不发那封『通道已就绪』回执」，所以按**回执**数，不按总条数：
    // 入站现在还会捎一条隧道地址（2026-10-10 用户要的「说一句就能拿到能打开的地址」），
    // 那是另一件事、且只在新地址时发一次，拿总条数当替身会把两件事混算。
    const receipts = fx.sent.filter((s) => s.text.includes('通道已就绪'))
    assert.equal(receipts.length, 1, '续期不再发回执 ⇒ 那一条额度留给真正的消息')
  } finally {
    await t.stop()
    await removeTempDir(fx.dir)
  }
})

test('挂号信：提问当场就投；这轮投不出去就留着，下次入站第一件补它', async () => {
  const fx = makeFixture({ refuse: true })
  const t = await fx.bridgePromise
  try {
    fx.state.items = [{ sessionId: 'q1', running: false, title: '部署周报', updatedAt: 1 }]
    t.bridge.rememberPendingQuestion('evt-1', { rpcId: 'r1', sessionId: 'q1', questions: [{ id: 'one' }] })
    await settleFor(() => fx.sent.length >= 1)

    assert.equal(fx.sent.length, 1, '挂号信不进邮包，当场就投')
    assert.ok(fx.sent[0].text.includes('有问题需要你回答'))
    // A 问（用户 2026-10-11 01:20）：通知第一行必须是实际会话名。
    assert.ok(fx.sent[0].text.startsWith('部署周报'), `标题是会话名， got ${JSON.stringify(fx.sent[0].text)}`)
    assert.equal(t.bridge.clawbotQuotaSpent, true, '被服务端拒了')
    assert.equal(t.bridge.mailbag.registeredCount, 1, '没丢：留在待补投里')

    fx.state.refuse = false
    fx.state.inbound = { context_token: `${CTX}_9`, from_user_id: 'user_mb' }
    await settleFor(() => fx.sent.length >= 2)
    assert.ok(fx.sent[1].text.includes('有问题需要你回答'), '续期后第一件事就是补它')
    assert.equal(t.bridge.mailbag.registeredCount, 0, '投出去了就不再留着')
  } finally {
    await t.stop()
    await removeTempDir(fx.dir)
  }
})

test('名字取不到就说「会话」，不许把 sessionId 印到通知第一行冒充名字', async () => {
  // A 问（用户 2026-10-11 01:20：「标题退化我看到了，这个是错的。应该是实际名称」）。
  // 这一档钉的是退化那一半：强刷之后仍然没有名字时，标题说「会话」——
  // 一串机器 id 在通知栏里既读不出是谁、也搜不回去，比空着更难用。
  const fx = makeFixture()
  const t = await fx.bridgePromise
  try {
    fx.state.items = [{ sessionId: 'q9', running: false, updatedAt: 1 }]
    t.bridge.rememberPendingQuestion('evt-named', { rpcId: 'r9', sessionId: 'q9', questions: [{ id: 'one' }] })
    await settleFor(() => fx.sent.length >= 1)

    const text = fx.sent[0].text
    assert.ok(text.startsWith('会话'), `第一行是「会话」，got ${JSON.stringify(text)}`)
    assert.ok(!text.includes('q9'), 'sessionId 一个字都不出现在推送里')
    assert.ok(text.includes('有问题需要你回答'), '该说的事照说')
  } finally {
    await t.stop()
    await removeTempDir(fx.dir)
  }
})

test('桌面「测试」当场就投，并顺路把包里的信带走', async () => {
  const fx = makeFixture()
  const t = await fx.bridgePromise
  try {
    await runThenSettle(t, fx, [{ sessionId: 'z', title: '攒着的' }])
    assert.equal(t.bridge.mailbag.ordinaryCount, 1, '包里有信在等末班车')
    assert.equal(fx.sent.length, 0, '还没发')

    const desktop = await t.pairDesktop()
    const res = await httpFetch(`${t.base}/desktop/notify/test`, {
      method: 'POST',
      headers: { Cookie: desktop }
    })
    const json = JSON.parse(await res.text())
    assert.deepEqual(json, { ok: true, delivered: true, held: 0, quotaSpent: false })
    assert.equal(fx.sent.length, 2, '测试信投了，包里的信搭这趟车走')
    assert.ok(fx.sent[0].text.includes('通知测试'))
    assert.ok(fx.sent[1].text.includes('攒着的'))
    assert.ok(fx.sent[1].text.includes('（第 2/10 条）'), '两次投递数两条')
  } finally {
    await t.stop()
    await removeTempDir(fx.dir)
  }
})

test('落盘：宿主重启后包里的平邮还在、照原时间排队；挂号信不落盘（它可能已经过去了）', async () => {
  const mailbagDir = makeTempDir('dsh-pocket-mailbag-file-')
  const mailbagStore = createMailbagStore(mailbagDir)
  const shared = createSettingsStore(makeTempDir('dsh-pocket-mailbag-settings-'))
  try {
    const fx = makeFixture({ refuse: true, mailbagStore, settingsStore: shared })
    const t = await fx.bridgePromise
    await runThenSettle(t, fx, [
      { sessionId: 'a', title: '甲' },
      { sessionId: 'b', title: '乙' }
    ])
    await rideTheBus(t, fx)
    assert.equal(t.bridge.mailbag.ordinaryCount, 2, '两封都因额度被拒而留下')
    // 同时留一封挂号信，用来验证它不落盘。
    t.bridge.mailbag.post(POST_REGISTERED, { title: '丙', body: '有问题需要你回答' }, fx.state.at)
    await settleFor(() => fs.existsSync(mailbagPath(mailbagDir)))
    await t.stop()

    const onDisk = JSON.parse(fs.readFileSync(mailbagPath(mailbagDir), 'utf8'))
    assert.equal(onDisk.ordinary.length, 2, '平邮落了盘')
    assert.ok(!JSON.stringify(onDisk).includes('有问题需要你回答'), '挂号信不落盘：它是否还成立只有活着的桥知道')

    // 换一只新桥（＝宿主重启），用同一个文件与同一份设置。
    const fx2 = makeFixture({ mailbagStore, settingsStore: shared })
    const t2 = await fx2.bridgePromise
    assert.equal(t2.bridge.mailbag.ordinaryCount, 2, '重启后信还在包里')
    assert.equal(t2.bridge.mailbag.registeredCount, 0, '重启后没有陈年提问被补投')

    // 重启前已经等掉的时间照样算数：下一次入站就寄，不会重新等 10 分钟。
    fx2.state.refuse = false
    fx2.state.inbound = { context_token: CTX, from_user_id: 'user_mb' }
    await settleFor(() => fx2.sent.some((entry) => entry.text.includes('甲')))
    const letter = fx2.sent.find((entry) => entry.text.includes('甲'))
    assert.ok(letter.text.includes('乙'), '两封合成一封寄出')
    await t2.stop()
  } finally {
    await removeTempDir(mailbagDir)
    await removeTempDir(shared ? path.dirname(mailbagPath(mailbagDir)) : mailbagDir)
  }
})

test('换到没有额度的通道时解除「额度已尽」，否则包会永远留在邮局', async () => {
  const fx = makeFixture({ refuse: true })
  const t = await fx.bridgePromise
  try {
    await runThenSettle(t, fx, [{ sessionId: 'a', title: '甲' }])
    await rideTheBus(t, fx)
    assert.equal(t.bridge.clawbotQuotaSpent, true, '被拒过一次')
    assert.equal(t.bridge.mailbag.ordinaryCount, 1, '信留在包里等续期')

    // 用户改去 Bark（它没有额度这回事）。清掉那个标志的唯一事件是 clawbot 入站，
    // 而 clawbot 已经不跑了——不解除就会永久停摆。
    t.bridge.notifyConfig = { ...t.bridge.notifyConfig, channel: 'bark', key: 'bark_key_x' }
    await t.bridge.sendMail('tick')
    assert.equal(t.bridge.clawbotQuotaSpent, false, '换道即解除挂起')
    // 被拒的那封是**按原时间**放回包里的（它已经等过一整班），所以解除挂起后这一班就到点，不该插队也不该重新计时。
    assert.equal(fx.sent.length, 2, '早就过点的信，解除挂起后这一班就走')
    assert.ok(fx.sent[1].text.includes('甲'))
    assert.ok(!fx.sent[1].text.includes('第 '), '没有额度的通道不加那条计数')
    assert.equal(t.bridge.mailbag.ordinaryCount, 0, '寄完了')
  } finally {
    await t.stop()
    await removeTempDir(fx.dir)
  }
})

test('没配通道时邮包是哑的：不发信，也不往里堆', async () => {
  const dir = makeTempDir('dsh-pocket-mailbag-off-')
  const sent = []
  const t = await startBridge({
    harness: 'fake',
    harnessOptions: {
      respond: (pathname) =>
        pathname === '/api/session/list'
          ? { ok: true, value: { items: [{ sessionId: 'a', running: false, title: '甲', updatedAt: 1 }] } }
          : undefined
    },
    bridgeOptions: {
      settingsStore: { load: () => ({}), save: () => true },
      notifyFetchImpl: async (url) => {
        sent.push(String(url))
        return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' }
      },
      now: () => 9_000_000
    }
  })
  try {
    await t.bridge.pollNotifyRunning()
    await t.bridge.sendMail('inbound')
    assert.equal(sent.length, 0, '没配置就是安静的')
    assert.equal(t.bridge.mailbag.ordinaryCount, 0, '也不往里堆')
  } finally {
    await t.stop()
    await removeTempDir(dir)
  }
})
