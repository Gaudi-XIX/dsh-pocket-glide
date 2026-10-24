// P2-2 判定器（卡 2026-10-24-pocket-mobile-interaction / 判定器任务）。
//
// `cvVerdict` **只活在这个文件里**：它是离线判据，不进壳（壳字节 0）。入参是
// `probeMark` 写出的原始行：
//   tag@perf|top|scrollHeight|clientHeight|innerHeight|vvHeight|vvOffset
// 出参 {verdict:'pass'|'reject', reason, swings, balloon}：
//   · 同一 250ms 窗内相邻 scrollHeight 变化 >15% ⇒ reject/balloon（CV 估算气球）
//   · scrollTop 先涨后跌且回撤 ≥200px      ⇒ reject/swing  （浏览器滚动锚定拽回）
//   · 其余                                  ⇒ pass
// 夹具是 10-15 的真机读数（design §2.1 / CHANGELOG）：scrollHeight 1828→4711→2090、
// scrollTop 0→3980→1359，三样本间隔 ≤90ms。判定器必须给同一批数据定罪——这是
// 「不是盲目再挂一遍 CV」的硬证据；判 pass 就等于它没有判据价值。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mobilePageAssets } from '../lib/pages.js'

const WINDOW_MS = 250
const BALLOON_RATIO = 0.15
const SWING_PX = 200

function parseSample(line) {
  if (typeof line !== 'string') return null
  const parts = line.split('|')
  if (parts.length < 7) return null
  const at = String(parts[0]).split('@')[1]
  const perf = Number(at)
  const top = Number(parts[1])
  const scrollHeight = Number(parts[2])
  if (!Number.isFinite(perf) || !Number.isFinite(top) || !Number.isFinite(scrollHeight)) return null
  return { perf, top, scrollHeight }
}

function cvVerdict(samples) {
  const rows = (Array.isArray(samples) ? samples : []).map(parseSample).filter(Boolean)
  const out = { verdict: 'pass', reason: null, swings: 0, balloon: 0 }
  for (let i = 1; i < rows.length; i += 1) {
    const prev = rows[i - 1]
    const cur = rows[i]
    const dt = cur.perf - prev.perf
    if (dt < 0 || dt > WINDOW_MS) continue
    const base = Math.min(prev.scrollHeight, cur.scrollHeight)
    const step = Math.abs(cur.scrollHeight - prev.scrollHeight)
    if (base > 0 && step / base > BALLOON_RATIO) out.balloon += 1
  }
  let peak = null
  for (const row of rows) {
    if (peak !== null && peak - row.top >= SWING_PX) out.swings += 1
    if (peak === null || row.top > peak) peak = row.top
  }
  if (out.balloon > 0) Object.assign(out, { verdict: 'reject', reason: 'balloon' })
  else if (out.swings > 0) Object.assign(out, { verdict: 'reject', reason: 'swing' })
  return out
}

const sample = (perf, top, scrollHeight) => `cv@${perf}|${top}|${scrollHeight}|800|844|844|0`

test('cvVerdict rejects the real 2026-10-15 readings (balloon + swing)', () => {
  // scrollHeight 气球：1828→4711→2090，间隔 ≤90ms
  const balloon = [sample(0, 0, 1828), sample(60, 0, 4711), sample(90, 0, 2090)]
  const verdict = cvVerdict(balloon)
  assert.equal(verdict.verdict, 'reject', '10-15 实录必须判 reject')
  assert.equal(verdict.reason, 'balloon')
  assert.ok(verdict.balloon >= 1, '至少要抓到一次 >15% 的相邻跳变')

  // scrollTop 先涨后跌：0→3980→1359（高度不变，单靠 swing 也必须定罪）
  const swing = [sample(0, 0, 2090), sample(60, 3980, 2090), sample(90, 1359, 2090)]
  const swings = cvVerdict(swing)
  assert.equal(swings.verdict, 'reject', '0→3980→1359 必须判 reject')
  assert.equal(swings.reason, 'swing')
  assert.ok(swings.swings >= 1)
})

test('cvVerdict passes a smooth sequence and never invents a verdict from nothing', () => {
  const smooth = [sample(0, 0, 4000), sample(120, 40, 4010), sample(240, 80, 3995), sample(360, 120, 4005)]
  assert.deepEqual(cvVerdict(smooth), { verdict: 'pass', reason: null, swings: 0, balloon: 0 })
  assert.equal(cvVerdict([]).verdict, 'pass', '空数组不能误伤')
  assert.equal(cvVerdict(['jk@120|40', 'cv@oops']).verdict, 'pass', '残缺行/异类行跳过')
  // 相邻样本间隔 >250ms 不算同一个窗：慢慢长高不是气球
  const slow = [sample(0, 0, 2000), sample(900, 0, 4000)]
  assert.equal(cvVerdict(slow).verdict, 'pass')
})

test('the judge ships in the test only — neither the shell JS nor its CSS carries it', () => {
  for (const locale of ['zh', 'en']) {
    const assets = mobilePageAssets({ locale })
    assert.doesNotMatch(assets.js, /cvVerdict/, '判定器不进壳（0 壳字节）')
    assert.doesNotMatch(assets.css, /cvVerdict/)
  }
})
