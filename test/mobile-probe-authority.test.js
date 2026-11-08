// 诊断开关的权威归位（V3 / V10 / V11 / V12）与单份注入哨兵（V4）。
//
// 这一组钉的是 2026-11-08/09 的两条真机故障，不钉实现细节：
//  ① 开关状态优先：`diagnostics.probe=false` 时，即便本机还留着 6 小时凭据、
//     哪怕 URL 上仍带 `?probe=1`，也必须 probeOn=false 且把凭据清掉——旧实现在
//     凭据期内无条件 PROBE_ON=true 并每次续命，拨回 false 对已中招设备等于没拨。
//  ② 开关为 true 时功能照旧：不带任何 URL 参数也进采集，并续一份 6 小时凭据。
//  ③ 没有开关值（静态资产页、PIN 页、reconnect 页）保留老规则：`?probe=1` 或凭据期内
//     即开——SW 会把 URL 改写成 `/?revalidate=1`，只看 location.search 会失明，这条不能
//     一起删掉。2026-11-09（M2）：权威值只能从 `window.__P` 读。早先写裸 `__P`，在上述
//     页面里抛 ReferenceError 被同一行 catch 吞掉，探针恒关、凭据也不清；`new Function`
//     把 `__P` 当形参的旧测试形状恰好把这条掩盖了，所以这里一律用真 `window` 跑。
//  ④ 单份注入：文档里只多一个权威值、不多一个 <script>；应用脚本第一条语句立哨兵，
//     bootstrap 见到哨兵就不再补第二份（首份中途抛错也不补 ⇒ 不会重复声明 agentRunning）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mobilePageAssets, renderMobilePage, renderPairingPinPage, renderMobileReconnectPage } from '../lib/pages.js'

const ZH = mobilePageAssets({ locale: 'zh' })
const JS = ZH.js
const B5 = (() => {
  const m = JS.match(/try\{const a=window\.__P[^\n]*?\}catch\{\}/)
  assert.ok(m, '开关判定那行必须还在，且读的是 window.__P（V9：诊断链不许删）')
  return m[0]
})()

// 照着真脚本的形状跑那一行：PROBE_ON 由 `var` 声明在同一个作用域里，`window` 是真对象
// （没有 __P 就是没有这个属性，不是"形参传了 undefined"）。localStorage 用真 Map 记账。
function arm({ probe, search = '', credential = null }) {
  const store = new Map()
  if (credential !== null) store.set('pocketProbe', String(credential))
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)) },
    removeItem: (k) => { store.delete(k) },
  }
  const win = {}
  if (probe !== undefined) win.__P = probe
  const body = [`var PROBE_ON=false;`, B5, 'return { on: PROBE_ON, cred: localStorage.getItem("pocketProbe") }'].join('\n')
  const read = new Function('window', 'localStorage', 'location', body)(win, localStorage, { search })
  return { ...read, store }
}

const sixHourCredential = () => String(Date.now() + 216e5)

test('V3/V12 开关关是权威：凭据期内、URL 带 ?probe=1 也进不了采集，且凭据被清掉', () => {
  const r = arm({ probe: 0, search: '?probe=1', credential: sixHourCredential() })
  assert.equal(r.on, false, '开关为 false 时必须 probeOn=false')
  assert.equal(r.cred, null, '被关掉之后不许再留 6 小时凭据（否则下次重进又被它顶回开）')
})

test('V11 开关关：干净设备重进也不 armed，不留凭据', () => {
  const r = arm({ probe: 0 })
  assert.equal(r.on, false)
  assert.equal(r.cred, null)
})

test('V10 开关开：不带任何 URL 参数也进采集，并续 6 小时凭据', () => {
  const r = arm({ probe: 1 })
  assert.equal(r.on, true, '开关为 true 时凭空进页也要 armed（探针要有 on 可自证）')
  assert.ok(Number(r.cred) > Date.now() + 215e5, '凭据续到 6 小时期外')
})

test('V3 开关开也不受旧凭据影响：过期的凭据照旧被换新', () => {
  const r = arm({ probe: 1, credential: String(Date.now() - 1000) })
  assert.equal(r.on, true)
  assert.ok(Number(r.cred) > Date.now() + 215e5, '过期凭据被一次续命覆盖')
})

test('M2 没有开关值（静态资产页 / PIN 页 / reconnect 页）保留老规则：?probe=1 仍能开并种凭据', () => {
  const r = arm({ probe: undefined, search: '?probe=1' })
  assert.equal(r.on, true, '没有权威值时必须走老规则——裸 __P 会抛 ReferenceError 被 catch 吞掉，就成了恒关')
  assert.ok(Number(r.cred) > Date.now() + 215e5, '命中即续 6 小时')
})

test('M2 没有开关值：凭据期内重进仍 armed，过期则清掉且不入采集', () => {
  const live = arm({ probe: undefined, credential: sixHourCredential() })
  assert.equal(live.on, true, '期内重进不该白丢时间线')
  const dead = arm({ probe: undefined, credential: String(Date.now() - 1000) })
  assert.equal(dead.on, false)
  assert.equal(dead.cred, null, '过期凭据自己删掉，不留残余')
})

test('M2 静态资产本身不带权威值：/app.js 里没有 var __P，判定靠 window.__P', () => {
  assert.ok(!JS.includes('var __P='), '静态资产是共用的，不该给某一台机器的开关值')
  assert.ok(!/try\{const a=__P\b/.test(JS), '裸 __P 在未声明作用域里抛 ReferenceError，必须是 window.__P')
})

test('M2 PIN / reconnect 文档没有探针链，也没有裸 __P 引用', () => {
  for (const [name, html] of [
    ['PIN', renderPairingPinPage('zh')],
    ['reconnect', renderMobileReconnectPage('zh')],
  ]) {
    assert.ok(!/try\{const a=__P\b/.test(html), `${name} 页不许出现裸 __P 引用`)
    assert.ok(!html.includes('var __P='), `${name} 页不带开关权威值（它没有探针链可压）`)
  }
})

test('V4 权威值折进 head 已有的脚本，文档不多出 <script> 标签', () => {
  const base = {
    locale: 'zh', boot: null, icon: '/app-icon?ui=1',
    assets: { cssUrl: '/app.css?h=deadbeef', jsUrl: '/app.js?l=zh&h=deadbeef' },
    nonce: '0123456789abcdef', bootState: 'handoff',
  }
  const plain = renderMobilePage({ ...base })
  const off = renderMobilePage({ ...base, probeEnabled: false })
  const on = renderMobilePage({ ...base, probeEnabled: true })
  const count = (html) => (html.match(/<script/g) || []).length
  assert.equal(count(off), count(plain), '写开关不许再加一份 <script> 包装（薄文档 21,000 B 上限）')
  assert.equal(count(on), count(plain))
  assert.match(off, /<script([^>]*)>var __P=0;\(function\(\)\{/, 'head 第一个脚本先立权威值')
  assert.match(on, /<script([^>]*)>var __P=1;\(function\(\)\{/)
  assert.ok(!plain.includes('var __P='), '不传开关值时文档与旧版逐字一致（资产渲染路径）')
})

test('V4 单份注入：应用脚本第一条语句立哨兵，bootstrap 见哨兵即不再补一份', () => {
  assert.ok(JS.trimStart().startsWith('var __S=1;'), `应用脚本必须先立哨兵（现开头 ${JSON.stringify(JS.slice(0, 24))}）`)
  assert.ok(!JS.includes('window.__S'), '哨兵用 var 而不是 window 属性，别的测试把整段脚本 new Function 跑起来时不会碰 window')
  const html = renderMobilePage({
    locale: 'zh', boot: null, icon: '/app-icon?ui=1',
    assets: { cssUrl: '/app.css?h=deadbeef', jsUrl: '/app.js?l=zh&h=deadbeef' },
    nonce: '0123456789abcdef', bootState: 'handoff',
  })
  assert.match(html, /if\(window\.__pocketAppReady!==true&&!window\.__S\)\{/, 'bootstrap 的双份注入闸')
  assert.ok(!html.includes('__pocketAppStarted'), '旧哨兵已退役，别留两套闸')
})