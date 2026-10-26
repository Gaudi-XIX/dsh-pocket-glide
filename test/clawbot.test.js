import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  randomUin,
  buildIlinkHeaders,
  getBotQrCode,
  pollBotQrStatus,
  notifyStart,
  getUpdates,
  sendTextMessage,
  ILINK_AUTH_TYPE,
  ILINK_BOT_APP_ID,
  ILINK_CLIENT_VERSION
} from '../lib/clawbot.js'
import { notifySend, maskKey } from '../lib/notify.js'
import { CLAWBOT_QUOTA_LIMIT } from '../lib/constants.js'
import { createSettingsStore } from '../lib/settings-store.js'
import { startBridge, httpFetch } from './helpers.js'

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

test('clawbot: randomUin generates valid base64 uint32 string', () => {
  const uin = randomUin()
  assert.ok(typeof uin === 'string' && uin.length > 0)
  const decoded = Buffer.from(uin, 'base64').toString('utf8')
  const num = Number(decoded)
  assert.ok(Number.isInteger(num))
  assert.ok(num >= 0 && num <= 0xffffffff)
})

test('clawbot: buildIlinkHeaders provides required headers for iLink', () => {
  const headers = buildIlinkHeaders('test_bot_token_123')
  assert.equal(headers['Content-Type'], 'application/json')
  assert.equal(headers['AuthorizationType'], ILINK_AUTH_TYPE)
  assert.equal(headers['Authorization'], 'Bearer test_bot_token_123')
  assert.equal(headers['iLink-App-Id'], ILINK_BOT_APP_ID)
  assert.equal(headers['iLink-App-ClientVersion'], String(ILINK_CLIENT_VERSION))
  assert.ok(headers['X-WECHAT-UIN'])
})

test('clawbot: getBotQrCode parses response correctly', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      ret: 0,
      qrcode: 'qr_code_token_123',
      qrcode_img_content: 'https://ilinkai.weixin.qq.com/qr/123'
    })
  })
  const res = await getBotQrCode({ fetchImpl })
  assert.equal(res.ok, true)
  if (res.ok) {
    assert.equal(res.qrcode, 'qr_code_token_123')
    assert.equal(res.url, 'https://ilinkai.weixin.qq.com/qr/123')
  }
})

test('clawbot: getBotQrCode handles errors gracefully', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 500,
    json: async () => ({})
  })
  const res = await getBotQrCode({ fetchImpl })
  assert.equal(res.ok, false)
  if (!res.ok) {
    assert.equal(res.error, 'HTTP 500')
  }
})

test('clawbot: pollBotQrStatus parses wait, scaned and confirmed statuses', async () => {
  const fetchImplWait = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ret: 0, status: 'wait' })
  })
  const resWait = await pollBotQrStatus('qr1', { fetchImpl: fetchImplWait })
  assert.equal(resWait.ok, true)
  if (resWait.ok) assert.equal(resWait.status, 'wait')

  const fetchImplConfirmed = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      ret: 0,
      status: 'confirmed',
      bot_token: 'bot_token_abc',
      ilink_user_id: 'user_wechat_xyz'
    })
  })
  const resConfirmed = await pollBotQrStatus('qr1', { fetchImpl: fetchImplConfirmed })
  assert.equal(resConfirmed.ok, true)
  if (resConfirmed.ok) {
    assert.equal(resConfirmed.status, 'confirmed')
    assert.equal(resConfirmed.botToken, 'bot_token_abc')
    assert.equal(resConfirmed.userId, 'user_wechat_xyz')
  }
})

test('clawbot: notifyStart activates session via POST', async () => {
  let calledUrl = ''
  let calledMethod = ''
  const fetchImpl = async (url, init) => {
    calledUrl = String(url)
    calledMethod = init?.method || 'GET'
    return {
      ok: true,
      status: 200,
      json: async () => ({ ret: 0 })
    }
  }
  const ok = await notifyStart('token_1', { fetchImpl })
  assert.equal(ok, true)
  assert.ok(calledUrl.includes('/ilink/bot/msg/notifystart'))
  assert.equal(calledMethod, 'POST')
})

test('clawbot: getUpdates polls messages and returns msgs list', async () => {
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body)
    assert.equal(body.get_updates_buf, 'buf_1')
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ret: 0,
        get_updates_buf: 'buf_2',
        msgs: [
          {
            from_user_id: 'user_1',
            context_token: 'ctx_token_999'
          }
        ]
      })
    }
  }
  const res = await getUpdates('bot_tok', 'buf_1', { fetchImpl })
  assert.equal(res.ok, true)
  if (res.ok) {
    assert.equal(res.buf, 'buf_2')
    assert.equal(res.msgs.length, 1)
    assert.equal(res.msgs[0].context_token, 'ctx_token_999')
  }
})

test('clawbot: sendTextMessage posts formatted text payload', async () => {
  let outboundBody = null
  const fetchImpl = async (url, init) => {
    outboundBody = JSON.parse(init.body)
    return {
      ok: true,
      status: 200,
      text: async () => '{"ret":0,"message_id":7514407535056518664}'
    }
  }
  const res = await sendTextMessage('bot_tok', {
    contextToken: 'ctx_tok',
    toUserId: 'user_dest',
    text: 'Hello WeChat!'
  }, { fetchImpl })

  assert.equal(res.ok, true)
  assert.ok(outboundBody)
  assert.equal(outboundBody.msg.context_token, 'ctx_tok')
  assert.equal(outboundBody.msg.to_user_id, 'user_dest')
  assert.equal(outboundBody.msg.item_list[0].text_item.text, 'Hello WeChat!')
  // 线上键名是 `type`，不是 `item_type`。2026-10-10 受控实验：同一 context_token
  // 连发三条，只有带 `type:1` 的能到微信；只写 `item_type:1` 的那条服务端照样
  // 回 200 + message_id，但微信端静默丢弃。所以这条断言是「能不能送到」的闸门，
  // 不是格式洁癖。
  assert.equal(outboundBody.msg.item_list[0].type, 1)
  assert.equal('item_type' in outboundBody.msg.item_list[0], false,
    'item_type 不上线（服务端不校验、微信端忽略）；带上它只是噪声')
  // iLink answers an accepted sendmessage with a server-assigned message_id.
  assert.equal(res.messageId, '7514407535056518664')
})

test('clawbot: sendTextMessage surfaces business ret as failure', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ ret: -14, errmsg: 'session expired' })
  })
  const res = await sendTextMessage('bot_tok', {
    contextToken: 'ctx_tok',
    toUserId: 'user_dest',
    text: 'Hi'
  }, { fetchImpl })
  assert.equal(res.ok, false)
  if (!res.ok) assert.equal(res.error, 'session expired')
})

test('notifySend with clawbot: checks contextToken and sends notification', async () => {
  const logs = []
  let sent = false
  const fetchImpl = async (url, init) => {
    sent = true
    return {
      ok: true,
      status: 200,
      text: async () => '{"ret":0,"message_id":7514407535056518664}'
    }
  }

  // Without contextToken: logs warn and returns false
  const configNoCtx = {
    channel: 'clawbot',
    key: 'bot_key',
    enabled: true,
    clawbot: { botToken: 'bot_key', userId: 'uid', contextToken: '' }
  }
  const resNoCtx = await notifySend(configNoCtx, 'Title', 'Body', {
    fetchImpl,
    log: (lvl, msg) => logs.push({ lvl, msg })
  })
  assert.equal(resNoCtx, false)
  assert.equal(sent, false)
  assert.ok(logs.some(l => l.msg.includes('context_token missing')))

  // With contextToken: succeeds
  const configWithCtx = {
    channel: 'clawbot',
    key: 'bot_key',
    enabled: true,
    clawbot: { botToken: 'bot_key', userId: 'uid', contextToken: 'ctx_valid' }
  }
  const resWithCtx = await notifySend(configWithCtx, 'Title', 'Body', {
    fetchImpl,
    log: (lvl, msg) => logs.push({ lvl, msg })
  })
  assert.equal(resWithCtx, true)
  assert.equal(sent, true)
  // 本机实测：成功发送原先零日志，「日志无新行」被误读为没发出去，故成功侧也落一行。
  assert.ok(logs.some(l => l.lvl === 'info' && l.msg.includes('message_id=7514407535056518664')),
    `expected success line with message_id, got ${JSON.stringify(logs)}`)
})

test('settings store: preserves and sanitizes clawbot configuration', () => {
  const dir = makeTempDir('dsh-pocket-glide-clawbot-')
  try {
    const store = createSettingsStore(dir)
    store.save({
      notify: {
        channel: 'clawbot',
        key: 'secret_token_123456789',
        enabled: true,
        clawbot: {
          botToken: 'secret_token_123456789',
          userId: 'user_1',
          contextToken: 'ctx_1'
        }
      }
    })
    const doc = store.load()
    assert.equal(doc.notify.channel, 'clawbot')
    assert.equal(doc.notify.key, 'secret_token_123456789')
    assert.equal(doc.notify.clawbot.botToken, 'secret_token_123456789')
    assert.equal(doc.notify.clawbot.userId, 'user_1')
    assert.equal(doc.notify.clawbot.contextToken, 'ctx_1')

    // Preserves clawbot when saving other fields if clawbot is not mentioned
    store.save({
      notify: {
        channel: 'clawbot',
        enabled: false
      }
    })
    const doc2 = store.load()
    assert.equal(doc2.notify.enabled, false)
    assert.equal(doc2.notify.clawbot.contextToken, 'ctx_1')

    // 回归钉（2026-10-13 事故）：额度落盘每推一条就 save 一次 {clawbot:{quotaUsed}}，
    // 旧实现把 patch 未提名的 channel/enabled/key 落回默认 off/false/''——内存里配置
    // 仍是对的所以推送照常，重启读盘通道即死（微信双向全哑）。部分节保存必须保留
    // 盘上现值，只有提名的字段才允许改变。
    store.save({ notify: { enabled: true } })
    store.save({
      notify: {
        clawbot: {
          botToken: 'secret_token_123456789',
          userId: 'user_1',
          contextToken: 'ctx_1',
          quotaUsed: 7
        }
      }
    })
    const doc3 = store.load()
    assert.equal(doc3.notify.channel, 'clawbot', '部分节保存不抹 channel')
    assert.equal(doc3.notify.enabled, true, '部分节保存不抹 enabled')
    assert.equal(doc3.notify.key, 'secret_token_123456789', '部分节保存不抹 key')
    assert.equal(doc3.notify.clawbot.quotaUsed, 7, '要写的字段真的写进去了')
    assert.equal(doc3.notify.clawbot.contextToken, 'ctx_1')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('desktop endpoints: /desktop/notify/clawbot/qr and /status work end-to-end', async () => {
  const dir = makeTempDir('dsh-pocket-glide-bridge-clawbot-')
  const notifyFetchImpl = async (url) => {
    const u = String(url)
    if (u.includes('get_bot_qrcode')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ret: 0,
          qrcode: 'qr_test_abc',
          qrcode_img_content: 'https://ilinkai.weixin.qq.com/qr/test'
        })
      }
    }
    if (u.includes('get_qrcode_status')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ret: 0,
          status: 'confirmed',
          bot_token: 'bot_acquired_token',
          ilink_user_id: 'user_wx_888'
        })
      }
    }
    return { ok: true, status: 200, json: async () => ({ ret: 0 }) }
  }

  const t = await startBridge({
    bridgeOptions: {
      settingsStore: createSettingsStore(dir),
      notifyFetchImpl
    }
  })

  try {
    const desktop = await t.pairDesktop()
    const headers = { Cookie: desktop, Origin: t.base }

    // 1. Fetch QR code
    const qrRes = await httpFetch(`${t.base}/desktop/notify/clawbot/qr`, { headers })
    assert.equal(qrRes.status, 200)
    const qrJson = JSON.parse(await qrRes.text())
    assert.equal(qrJson.ok, true)
    assert.equal(qrJson.qrcode, 'qr_test_abc')
    assert.ok(qrJson.qrSvg.includes('<svg'))

    // 2. Poll status: should confirm and automatically save botToken
    const statusRes = await httpFetch(
      `${t.base}/desktop/notify/clawbot/status?qrcode=qr_test_abc`,
      { headers }
    )
    assert.equal(statusRes.status, 200)
    const statusJson = JSON.parse(await statusRes.text())
    assert.equal(statusJson.ok, true)
    assert.equal(statusJson.status, 'confirmed')
    assert.equal(statusJson.bound, true)

    // 3. Check notify readback view: key must be masked, bound must be true
    const notifyRes = await httpFetch(`${t.base}/desktop/notify`, { headers })
    assert.equal(notifyRes.status, 200)
    const notifyJson = JSON.parse(await notifyRes.text())
    assert.equal(notifyJson.channel, 'clawbot')
    assert.equal(notifyJson.clawbot.bound, true)
    assert.equal(notifyJson.clawbot.userIdMasked, maskKey('user_wx_888'))
    assert.equal(notifyJson.keyMasked.includes('bot_acquired_token'), false)

    // 4. Reset endpoint
    const resetRes = await httpFetch(`${t.base}/desktop/notify/clawbot/reset`, {
      method: 'POST',
      headers
    })
    assert.equal(resetRes.status, 200)
    const resetJson = JSON.parse(await resetRes.text())
    assert.equal(resetJson.channel, 'off')
    assert.equal(resetJson.clawbot.bound, false)
  } finally {
    await t.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// 额度计数（用户 2026-10-10 提的要求：推送上给个计数）。一条入站消息换 10 条出站——
// 本机 11:00 受控实验实测（就绪回执 + 9 条推送全成功，第 11 条起 ret=-2 prepare failed），
// 所以正文尾巴上的「第 N/10 条」就是用户唯一的可见刻度：看到 10 就知道该回一句了。
test('clawbot quota: 数字不上屏、最后一条捎话、计数落盘、别的通道一个字都不加', async () => {
  const dir = makeTempDir('dsh-pocket-glide-quota-note-')
  const t = await startBridge({
    bridgeOptions: {
      settingsStore: createSettingsStore(dir),
      notifyFetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ret: 0 }) })
    }
  })
  try {
    const clawbot = { channel: 'clawbot' }
    const store = t.bridge.options.settingsStore
    assert.equal(t.bridge.clawbotQuotaTail(clawbot), '', '第 9 条之前正文一个字不加（数字不再上屏）')
    let tail = ''
    for (let i = 0; i < CLAWBOT_QUOTA_LIMIT - 1; i++) tail = t.bridge.clawbotQuotaTail(clawbot)
    assert.equal(tail, '（额度用完，在微信回一句就续上）', '第 10 条＝额度内最后一条，捎话必须在通道死掉之前说')
    assert.equal(store.load()?.notify?.clawbot?.quotaUsed, CLAWBOT_QUOTA_LIMIT, '计数落盘：重启不再从 0 骗小')
    tail = t.bridge.clawbotQuotaTail(clawbot)
    assert.equal(tail, '', '超限后的推送本就被服务端拒（onQuota 挂起），不再文案')
    assert.equal(t.bridge.clawbotQuotaTail({ channel: 'bark' }), '', '其它渠道没有这份额度')
    assert.equal(t.bridge.clawbotQuotaTail({ channel: 'off' }), '')
    assert.equal(t.bridge.clawbotQuotaUsed, CLAWBOT_QUOTA_LIMIT + 1, '别的通道不能占计数')
    t.bridge.refillClawbotQuota()
    assert.equal(store.load()?.notify?.clawbot?.quotaUsed, 0, '入站续期把归零也写进盘')
    assert.equal(t.bridge.clawbotQuotaTail(clawbot), '', '续期后重新从无声计数开始')
    assert.equal(store.load()?.notify?.clawbot?.quotaUsed, 1, '预占的那条也落盘')
    t.bridge.rollbackClawbotQuota()
    assert.equal(store.load()?.notify?.clawbot?.quotaUsed, 0, '传输丢失回滚预占的那一条')
  } finally {
    await t.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('clawbot quota: 计数真的进了发给微信的那段文字，入站一条就归零', async () => {
  const dir = makeTempDir('dsh-pocket-glide-quota-wire-')
  const store = createSettingsStore(dir)
  store.save({
    notify: {
      channel: 'clawbot',
      key: 'bot_token_quota',
      enabled: true,
      // 存档里还没有令牌 ⇒ 这就是「刚扫完码」的首绑状态，才会发那封就绪回执。
      clawbot: { botToken: 'bot_token_quota', userId: 'user_quota', contextToken: '' }
    }
  })
  const sent = []
  let inbound = { context_token: 'ctx_fresh', from_user_id: 'user_quota' }
  const notifyFetchImpl = async (url, options) => {
    const u = String(url)
    if (u.includes('/sendmessage')) {
      const body = JSON.parse(options.body)
      sent.push({ text: body.msg.item_list[0].text_item.text, token: body.msg.context_token })
      return { ok: true, status: 200, json: async () => ({ ret: 0, message_id: 7514520117146685576 }) }
    }
    if (u.includes('/getupdates')) {
      const msg = inbound
      inbound = null
      return {
        ok: true,
        status: 200,
        json: async () => ({ ret: 0, msgs: msg ? [msg] : [], get_updates_buf: 'buf_1' })
      }
    }
    return { ok: true, status: 200, json: async () => ({ ret: 0 }) }
  }
  // 入站现在还会让桥去确保公网隧道在跑（2026-10-10 用户要的「在微信说一句就能拿到
  // 能打开的地址」）。隧道必须**打桩**：不打桩就会真的去 ensureCloudflared，那是下载
  // 54MB 的真二进制、还会写进本机共享缓存，把同批跑的 tunnel.test.js 全档带红
  // （实测：clawbot 之后跑 tunnel 必红 11 档，单独跑 tunnel 全绿）。
  // 这档测的是额度计数，不是隧道，所以给个假的实例就够。
  const t = await startBridge({
    bridgeOptions: {
      settingsStore: store,
      notifyFetchImpl,
      createCloudflareTunnel: async () => ({
        url: 'https://quota-test.trycloudflare.com',
        provider: 'cloudflare',
        stop: async () => {},
        process: { once: () => {} }
      })
    }
  })
  try {
    const desktop = await t.pairDesktop()
    const headers = { Cookie: desktop }
    const wait = (what) =>
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 6000
        const step = () => {
          if (what()) return resolve()
          if (Date.now() > deadline) return reject(new Error('quota watcher never caught up'))
          setTimeout(step, 30)
        }
        step()
      })

    // 第一条入站：watcher 回就绪回执。数字不再上屏（2026-10-12 用户拍板）——
    // 回执自己仍占一条额度，只是不再把「第 1/10」印出来。
    await wait(() => sent.length >= 1)
    assert.equal(sent[0].token, 'ctx_fresh', '回执用刚换到的新令牌')
    assert.ok(sent[0].text.includes('已就绪'), '就绪回执正文在')
    assert.ok(!sent[0].text.includes('/10 条'), '数字不再上屏')

    const push = () =>
      httpFetch(`${t.base}/desktop/notify/test`, { method: 'POST', headers }).then((r) => r.json())
    await push()
    await push()
    // 入站现在还会捎一条隧道地址（2026-10-10 用户要的「说一句就能拿到能打开的地址」）。
    // 隧道是异步拉起来的（cloudflared 冷启动要下载），它什么时候落到 sent[] 里不保证，
    // 所以这里按**测试推送**取，不按下标——按下标会被地址那条挤位。
    const pushAt = (n) => sent.filter((s) => s.text.includes('这是一条测试通知'))[n]
    assert.ok(!pushAt(0).text.includes('/10 条'), pushAt(0).text)
    assert.ok(!pushAt(1).text.includes('/10 条'), pushAt(1).text)
    assert.ok(pushAt(1).text.includes('这是一条测试通知'), '测试推送正文在')

    // 再来一条入站，令牌字符串与存档**相同**（isNew 为假、不进回执分支），
    // 计数照样必须归零——这正是「落盘时间不能当判据」那条铁律的代码侧版本。
    inbound = { context_token: 'ctx_fresh', from_user_id: 'user_quota' }
    await wait(() => t.bridge.clawbotQuotaUsed === 0)
    await push()
    // 按**测试推送**数，不按总条数：入站现在还会捎一条隧道地址（2026-10-10 用户要的
    // 「说一句就能拿到能打开的地址」），那是另一条线，拿总条数当替身会把它算进来。
    const pushes = sent.filter((s) => s.text.includes('这是一条测试通知'))
    assert.equal(pushes.length, 3)
    assert.ok(!pushes[2].text.includes('/10 条'), '同令牌重复入站也算续期：重新从无声计数开始')
  } finally {
    await t.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// 入站身份门控：iLink 的 bot 会收到任何能对它说话的微信用户的入站（群里更是人人可说），
// 而 watcher 原来把每条入站的 from_user_id 直接写成新绑定、再把公网隧道地址回给这个
// 新绑定的 userId ⇒ 谁先说一句谁接管远程入口。这条锁断言默认拒绝的方向：
// 非绑定者的入站整条丢弃（不续额度、不改绑定、不发回执、不拉隧道）。
test('clawbot inbound gate: 非绑定者的入站整条丢弃，绑定与额度都不动', async () => {
  const dir = makeTempDir('dsh-pocket-glide-inbound-gate-')
  const store = createSettingsStore(dir)
  store.save({
    notify: {
      channel: 'clawbot',
      key: 'bot_token_gate',
      enabled: true,
      // 已绑定（扫码时从 ilink_user_id 拿到的身份），令牌还没换过 ⇒ contextToken 为空。
      // 计数先摆到 7：「被丢弃的入站不续额度」要能看出来，归零了才是错的。
      clawbot: { botToken: 'bot_token_gate', userId: 'user_bound', contextToken: '', quotaUsed: 7 }
    }
  })
  const sent = []
  let inbound = { context_token: 'ctx_stranger', from_user_id: 'user_stranger' }
  let polls = 0
  const notifyFetchImpl = async (url, options) => {
    const u = String(url)
    if (u.includes('/sendmessage')) {
      const body = JSON.parse(options.body)
      sent.push({ text: body.msg.item_list[0].text_item.text, token: body.msg.context_token })
      return { ok: true, status: 200, json: async () => ({ ret: 0, message_id: 7514520117146685578 }) }
    }
    if (u.includes('/getupdates')) {
      polls += 1
      const msg = inbound
      inbound = null
      return {
        ok: true,
        status: 200,
        json: async () => ({ ret: 0, msgs: msg ? [msg] : [], get_updates_buf: 'buf_gate' })
      }
    }
    return { ok: true, status: 200, json: async () => ({ ret: 0 }) }
  }
  // 隧道必须打桩（理由同上档）：真去 ensureCloudflared 会下载真二进制、污染共享缓存。
  const t = await startBridge({
    bridgeOptions: {
      settingsStore: store,
      notifyFetchImpl,
      createCloudflareTunnel: async () => ({
        url: 'https://gate-test.trycloudflare.com',
        provider: 'cloudflare',
        stop: async () => {},
        process: { once: () => {} }
      })
    }
  })
  try {
    const wait = (what, why) =>
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 6000
        const step = () => {
          if (what()) return resolve()
          if (Date.now() > deadline) return reject(new Error(`watcher never caught up: ${why}`))
          setTimeout(step, 30)
        }
        step()
      })
    await wait(() => polls >= 2, 'stranger inbound consumed')

    // 丢弃的三条后果，逐条断：这一档测的就是「什么都没发生」。
    assert.equal(sent.length, 0, '非绑定者拿不到任何回话（回执与隧道地址都不发）')
    assert.ok(
      t.logs.some((l) => l.message.includes('clawbot inbound dropped')),
      '丢弃要留一行 warn，否则现场看不出「为什么发了没反应」'
    )
    const afterStranger = store.load()?.notify?.clawbot || {}
    assert.equal(afterStranger.userId, 'user_bound', '绑定者不因外人的一句入站被改写')
    assert.equal(afterStranger.contextToken, '', '外人的令牌也不进存档')
    assert.equal(afterStranger.quotaUsed, 7, '被丢弃的入站不续额度')

    // 正证：绑定者本人说一句，同一套逻辑必须照常工作——否则这道卡就是把通道关死了。
    // contextToken 从空变成有值 ⇒ 走首绑分支，发那封就绪回执。
    inbound = { context_token: 'ctx_ok', from_user_id: 'user_bound' }
    await wait(() => sent.length >= 1, 'bound user inbound accepted')
    assert.ok(sent[0].text.includes('已就绪'), '本人入站照常发就绪回执')
    assert.equal(sent[0].token, 'ctx_ok', '回执用新换到的令牌')
    const afterBound = store.load()?.notify?.clawbot || {}
    assert.equal(afterBound.userId, 'user_bound')
    assert.equal(afterBound.contextToken, 'ctx_ok', '本人的令牌正常落盘')
    // 归零之后紧接着发那封就绪回执，回执自己占一条额度 ⇒ 落盘是 1 不是 0。
    // 关键是它从 7 变成了 1：续期确实发生了（被丢弃的那条没有这个效果）。
    assert.equal(afterBound.quotaUsed, 1, '本人的入站照常续额度：7 → 归零 → 回执占回 1 条')
  } finally {
    await t.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// 门地址回话与推送吃的是**同一条服务器额度**（一条入站换 10 条出站，服务器数所有出站）。
// 2026-10-13 前它不计数：一次隧道换址交接就让账本比服务器落后一条，此后「第 10 条捎话」
// 永远差一条——额度耗尽的那条被服务端静默拒收，用户只看到消息停了、没有任何解释。
// 直呼 ensureTunnelForInbound（不经入站 watcher）：入站会先续期归零，只有直呼才能摆出
// 「交接恰好是第 10 条」的位形；tunnel 打桩理由见上一档测试。
test('clawbot quota: 门地址回话占同一条额度——计数、捎话、拒收挂起、丢失回滚', async () => {
  const dir = makeTempDir('dsh-pocket-glide-quota-door-')
  const store = createSettingsStore(dir)
  store.save({
    notify: {
      channel: 'clawbot',
      key: 'bot_token_door',
      enabled: true,
      // 令牌已在档 ⇒ 不进就绪回执分支，这条线上只有门地址回话一条出站。
      clawbot: { botToken: 'bot_token_door', userId: 'user_door', contextToken: 'ctx_door' }
    }
  })
  const sent = []
  let mode = 'ok'
  const notifyFetchImpl = async (url, options) => {
    if (String(url).includes('/sendmessage')) {
      const body = JSON.parse(options.body)
      sent.push(body.msg.item_list[0].text_item.text)
      // sendTextMessage 从 res.text() 里拿 message_id/ret（64 位整数不走 JSON.parse），
      // 假响应必须带 text()——只带 json() 会在解析处抛 TypeError，被当成传输丢失。
      if (mode === 'refuse') {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ ret: -2, errmsg: 'prepare failed: no quota' })
        }
      }
      if (mode === 'lost') {
        return { ok: false, status: 503 }
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ret: 0, message_id: '7514520117146685577' })
      }
    }
    return { ok: true, status: 200, json: async () => ({ ret: 0 }) }
  }
  const t = await startBridge({
    bridgeOptions: {
      settingsStore: store,
      notifyFetchImpl,
      createCloudflareTunnel: async () => ({
        url: 'https://door-test.trycloudflare.com',
        provider: 'cloudflare',
        stop: async () => {},
        process: { once: () => {} }
      })
    }
  })
  try {
    const baseUrl = t.bridge.options.clawbotBaseUrl
    const ensure = () => t.bridge.ensureTunnelForInbound(notifyFetchImpl, baseUrl, undefined)

    // 账本已记 9 条 ⇒ 这次交接就是本轮第 10 条，捎话必须搭这条车。
    t.bridge.clawbotQuotaUsed = 9
    await ensure()
    assert.equal(sent.length, 1, '地址与上次不同（首次）＝必须回话')
    assert.ok(sent[0].includes('Pocket 已打开'), sent[0])
    assert.ok(sent[0].includes('额度用完'), '第 10 条的交接回话必须捎上额度用完（2026-10-13 漏捎回归钉）')
    assert.equal(t.bridge.clawbotQuotaUsed, 10, '交接占的额度进了账本')

    // 服务端拒收（prepare failed）＝额度态本身：不回滚、挂起后续通知。
    mode = 'refuse'
    t.bridge.clawbotDoorUrl = ''
    t.bridge.clawbotQuotaUsed = 3
    await ensure()
    assert.equal(sent.length, 2)
    assert.equal(t.bridge.clawbotQuotaSpent, true, '拒收＝本轮额度已尽，挂起')
    assert.equal(t.bridge.clawbotQuotaUsed, 4, '拒收不回滚计数')

    // 传输丢失（HTTP 503，服务端没收到）＝「没发出去的不算」：回滚预占。
    mode = 'lost'
    t.bridge.clawbotDoorUrl = ''
    t.bridge.clawbotQuotaSpent = false
    t.bridge.clawbotQuotaUsed = 5
    await ensure()
    assert.equal(sent.length, 3)
    assert.equal(t.bridge.clawbotQuotaUsed, 5, '传输丢失回滚预占的那一条')
    assert.equal(store.load()?.notify?.clawbot?.quotaUsed, 5, '回滚同步落盘')
  } finally {
    await t.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
