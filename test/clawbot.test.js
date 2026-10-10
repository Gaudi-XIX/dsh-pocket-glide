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
  const dir = makeTempDir('dsh-pocket-clawbot-')
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
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('desktop endpoints: /desktop/notify/clawbot/qr and /status work end-to-end', async () => {
  const dir = makeTempDir('dsh-pocket-bridge-clawbot-')
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
test('clawbot quota: 计数预占、第 10 条之后改说已超、别的通道一个字都不加', async () => {
  const dir = makeTempDir('dsh-pocket-quota-note-')
  const t = await startBridge({
    bridgeOptions: {
      settingsStore: createSettingsStore(dir),
      notifyFetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ret: 0 }) })
    }
  })
  try {
    const clawbot = { channel: 'clawbot' }
    assert.equal(t.bridge.clawbotQuotaTail(clawbot), '（第 1/10 条）')
    let tail = ''
    for (let i = 0; i < CLAWBOT_QUOTA_LIMIT - 1; i++) tail = t.bridge.clawbotQuotaTail(clawbot)
    assert.equal(tail, `（第 ${CLAWBOT_QUOTA_LIMIT}/${CLAWBOT_QUOTA_LIMIT} 条）`, '第 10 条仍是序号')
    tail = t.bridge.clawbotQuotaTail(clawbot)
    assert.ok(tail.includes('已超') && tail.includes('在微信回一句'), '超出的说法要给出下一步动作')
    assert.equal(t.bridge.clawbotQuotaTail({ channel: 'bark' }), '', '其它渠道没有这份额度')
    assert.equal(t.bridge.clawbotQuotaTail({ channel: 'off' }), '')
    assert.equal(t.bridge.clawbotQuotaUsed, CLAWBOT_QUOTA_LIMIT + 1, '别的通道不能占计数')
    t.bridge.refillClawbotQuota()
    assert.equal(t.bridge.clawbotQuotaTail(clawbot), '（第 1/10 条）', '续期后从头数')
  } finally {
    await t.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('clawbot quota: 计数真的进了发给微信的那段文字，入站一条就归零', async () => {
  const dir = makeTempDir('dsh-pocket-quota-wire-')
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
  const t = await startBridge({ bridgeOptions: { settingsStore: store, notifyFetchImpl } })
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

    // 第一条入站：watcher 回就绪回执，回执自己就是第 1 条。
    await wait(() => sent.length >= 1)
    assert.equal(sent[0].token, 'ctx_fresh', '回执用刚换到的新令牌')
    assert.ok(sent[0].text.includes('（第 1/10 条）'), '就绪回执也带计数——它确实吃掉一条额度')

    const push = () =>
      httpFetch(`${t.base}/desktop/notify/test`, { method: 'POST', headers }).then((r) => r.json())
    await push()
    await push()
    assert.ok(sent[1].text.includes('（第 2/10 条）'), sent[1].text)
    assert.ok(sent[2].text.includes('（第 3/10 条）'), sent[2].text)
    assert.ok(sent[2].text.includes('这是一条测试通知'), '计数是尾巴，不是替换正文')

    // 再来一条入站，令牌字符串与存档**相同**（isNew 为假、不进回执分支），
    // 计数照样必须归零——这正是「落盘时间不能当判据」那条铁律的代码侧版本。
    inbound = { context_token: 'ctx_fresh', from_user_id: 'user_quota' }
    await wait(() => t.bridge.clawbotQuotaUsed === 0)
    await push()
    assert.equal(sent.length, 4)
    assert.ok(sent[3].text.includes('（第 1/10 条）'), '同令牌重复入站也算续期：重新从第 1 条数')
  } finally {
    await t.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
