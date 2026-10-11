// 推送脚本必须跟着诊断开关走：开着就补 ?probe=1，关着发裸地址。
//
// 为什么要有这条：面板上的诊断开关只管住了桥自己推地址的两条路（微信回话、配对页），
// 而 tools/dsh-push-notice.mjs 是第三条路——它推的链接以前全靠人记得手打 ?probe=1，
// 开关关着照样发得出带诊断的链接。于是开关只管两条半路，「关了就干净」这个预期不成立。
//
// 复跑判据是行为：同一个函数，开/关两种取值下同一段文案的差别。
// house pattern 见 question-no-gesture-no-submit.test.js：把真实函数文本抽进沙箱跑。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../tools/dsh-push-notice.mjs', import.meta.url), 'utf8')

function slice(startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle)
  assert.notEqual(start, -1, `${startNeedle} must exist in the push script`)
  const end = source.indexOf(endNeedle, start)
  assert.notEqual(end, -1, `${endNeedle} must follow ${startNeedle}`)
  return source.slice(start, end)
}

const HELPER = slice('function withProbeSuffix(text, probe) {', 'async function main() {')
const withProbeSuffix = new Function(`${HELPER};return withProbeSuffix`)()

const LINK = 'https://example.trycloudflare.com'

test('probe 关着：原文一字不改', () => {
  const text = `地址 ${LINK} 进页面后翻一下`
  assert.equal(withProbeSuffix(text, false), text)
  assert.equal(withProbeSuffix(text, undefined), text)
})

test('probe 开着：裸地址补 ?probe=1', () => {
  assert.equal(withProbeSuffix(`地址 ${LINK}`, true), `地址 ${LINK}/?probe=1`)
})

test('probe 开着：地址后面紧跟中文标点时，标点留在外面', () => {
  // 这条是本文件最容易回归的一条：URL 字符集若不排除中文标点，问号会插到逗号后面，链接当场失效。
  assert.equal(withProbeSuffix(`${LINK}，进页面后翻一下`, true), `${LINK}/?probe=1，进页面后翻一下`)
})

test('probe 开着：地址已带查询串用 & 连接', () => {
  assert.equal(withProbeSuffix(`${LINK}/?a=b`, true), `${LINK}/?a=b&probe=1`)
})

test('probe 开着：已经带 probe 的不重复加（幂等）', () => {
  assert.equal(withProbeSuffix(`${LINK}/?probe=1`, true), `${LINK}/?probe=1`)
  assert.equal(withProbeSuffix(`${LINK}/?a=b&probe=1`, true), `${LINK}/?a=b&probe=1`)
  // 重复调用同一个函数也不该变形
  const once = withProbeSuffix(`${LINK}`, true)
  assert.equal(withProbeSuffix(once, true), once)
})

test('probe 开着：一段文案里的多个地址都补', () => {
  assert.equal(
    withProbeSuffix(`先试 ${LINK} 再试 http://127.0.0.1:43127`, true),
    `先试 ${LINK}/?probe=1 再试 http://127.0.0.1:43127/?probe=1`,
  )
})

test('推送脚本确实读的是设置档里的 diagnostics.probe，而不是别处', () => {
  // 防的是「helper 对了、但没人按开关调用它」——那等于没接上。
  assert.match(source, /const probe = doc\.diagnostics\?\.probe === true/)
  assert.match(source, /notifySend\(notify, withProbeSuffix\(title, probe\), withProbeSuffix\(body, probe\)/)
})