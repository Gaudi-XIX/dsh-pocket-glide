// W5 卡 F-02 补证（change 2026-10-24-pocket-mobile-interaction）。
//
// 钉的是安卓键盘抬升量 `--kb` 那条死区判据的三个器官：
//   KB_DEAD_PX / kbLastPx / applyKeyboardLift()
// 以及伴生的 applyViewportHeight()（iOS 的 --app-height）与 scheduleViewport()（接线）。
//
// 做法沿用本仓既有两套范式（test/pocket-cv-gate.test.js、test/pages-scroll-anchors.test.js）：
// 从 mobilePageAssets() 出货的 js 里按名抽出函数与常量，塞进 new Function 沙箱跑「真函数」，
// 不 mock 掉被测函数本身、不引 jsdom、不引任何新依赖。为什么值得单测：这条判据最坏的失败是
// **静默失效**——死区没了或方向反了，页面照样能跑，只有真机上键盘一抖就整叠输入区上下跳，
// 而那时已经离「谁能看出是哪一行代码的问题」很远了。
//
// ⚠ 现状与卡片措辞有两处不一致，本文件钉的是**代码现状**（不为了对齐措辞去改源码，也不放宽断言）：
//   ① 卡片写判据是 `Math.abs(... - kbLastPx) > KB_DEAD_PX`（差值 ≤4 不改写）；出货实际是
//      `< KB_DEAD_PX` 的早退门 ⇒ 差值 0..3 被抑制、**恰为 4 仍会改写**（有效死区 3px）。
//      两个算子在差值 4 处分叉，T6 把这条分叉也钉住。
//   ② 卡片写「iOS 分支不写 --kb」；实际 iOS 分支把 `--kb` 钉成 `'0px'` 后立即 return
//      ——不写「抬升量」、也不读 visualViewport，抬升由 `--app-height` 承担。T4 按实际语义断言。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mobilePageAssets } from '../lib/pages.js'

const js = mobilePageAssets({ locale: 'zh' }).js

// 本仓 house helper（与 pocket-cv-gate / pages-scroll-anchors 同式）：按名抽出一整个函数体。
function extract(source, name) {
  const start = source.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `${name} must exist in the rendered asset`)
  let depth = 0
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(`unbalanced braces after ${name}`)
}

// 死区早退门的规范形（出货的严格写法，逐字符钉死运算符方向与两侧操作数）。
const DEAD_ZONE_GUARD = /if\(px&&Math\.abs\(px-kbLastPx\)<KB_DEAD_PX\)return/
// 同一判据的「阈值必须是具名常量」形——把 4 内联成字面量就不该再匹配。
const NAMED_THRESHOLD = /<KB_DEAD_PX\)return/

function viewportStub(sink) {
  return {
    documentElement: { style: { setProperty(name, value) { sink.writes.push([name, value]) } } },
  }
}

// applyKeyboardLift 的沙箱：innerHeight 固定 800，lift(px) 造出「键盘抬起 px 像素」的
// visualViewport，于是被测函数算出的 px 恰好等于入参（offsetTop 走 offsets() 单独验）。
function liftSandbox({ source = js, apple = false, baseline = 0, forbidViewportRead = false } = {}) {
  const decl = source.match(/const KB_DEAD_PX=\d+/)
  assert.ok(decl, 'KB_DEAD_PX must be a numeric literal const in the shipped js')
  const sink = { writes: [], marks: [] }
  const document = viewportStub(sink)
  // forbidViewportRead: 用一个「一读就炸」的 getter 证明 iOS 分支根本没摸 visualViewport。
  const window = forbidViewportRead
    ? { get visualViewport() { throw new Error('applyKeyboardLift must not read visualViewport on iOS') } }
    : { visualViewport: null }
  const api = new Function('document', 'window', 'innerHeight', 'sink', `
    let kbLastPx=${baseline};
    ${decl[0]}
    const appleTouchDevice=${apple};
    function probeMark(tag){ sink.marks.push(tag) }
    ${extract(source, 'applyKeyboardLift')}
    return { applyKeyboardLift, get kbLastPx(){ return kbLastPx } }
  `)(document, window, 800, sink)
  return Object.assign(api, {
    sink,
    document,
    window,
    lift(px) { window.visualViewport = { height: 800 - px, offsetTop: 0 } },
    offsets(height, offsetTop) { window.visualViewport = { height, offsetTop } },
    values() { return sink.writes.map(([, value]) => value) },
  })
}

// ---------------------------------------------------------------- T1 常量与判据

test('KB_DEAD_PX ships as 4 and the keyboard gate is bound to kbLastPx — the shipped criterion, not a bare px&&', () => {
  assert.equal(Number(js.match(/const KB_DEAD_PX=(\d+)/)[1]), 4,
    'KB_DEAD_PX 出货值是 4（改这个数就是改死区宽度，必须显式）')
  // 基准变量与三个兄弟状态量同一条声明：kbLastPx 是「上一次写入的 --kb」的记忆体。
  assert.match(js, /let viewportRaf=0,lastAppHeight=0,viewportFillTimer=null,kbLastPx=0/,
    'kbLastPx 必须与 viewportRaf/lastAppHeight 同批初始化（缺它＝每次视口变化都无条件改写）')

  const body = extract(js, 'applyKeyboardLift')
  assert.match(body, DEAD_ZONE_GUARD,
    '判据必须同时含 px 门、kbLastPx 差值、裸常量 KB_DEAD_PX——任何一项被拿掉死区就没了')
  // 「不是裸的 px &&」：差值比较只此一处，且操作数就是 px 与 kbLastPx。
  assert.equal((body.match(/Math\.abs\(/g) || []).length, 1, '全文只有一处绝对值比较，不多不少')
  assert.match(body, /Math\.abs\(px-kbLastPx\)/, '比较的是「本次抬升量 − 上次写入量」')
  assert.doesNotMatch(body, /if\(px\)/, '没有裸 px 门（那样键盘一露头就每次 resize 都写一遍）')
  // 抬升量的算式本身：layout 视口不再被压缩，故由差值算出，且 offsetTop 要减掉
  // （浏览器自己 pan 过视口时不能重复抬一次）。
  assert.match(body, /const px=vv\?Math\.max\(0,Math\.round\(innerHeight-vv\.height-vv\.offsetTop\)\):0/,
    'px = max(0, round(innerHeight − vv.height − vv.offsetTop))')
})

test('dead zone behaviour: jitter of at most 3px inside the last written lift never rewrites --kb, 4px does, and a full hide always republishes 0px', () => {
  // 这张卡要防的形态：键盘跟手期间 visualViewport 的 height 在几像素量级上抖动，
  // 每次都改写 --kb 就等于让整叠输入区跟着抖（抖动幅度的真机读数不在本测试的取证范围）。
  const kb = liftSandbox()
  kb.lift(0)
  kb.applyKeyboardLift()
  assert.deepEqual(kb.values(), ['0px'], '初始无键盘：写一次 0px')
  assert.equal(kb.kbLastPx, 0)

  for (const px of [1, 2, 3]) {
    kb.lift(px)
    kb.applyKeyboardLift()
    assert.deepEqual(kb.values(), ['0px'], `抬升 ${px}px 与基准差 ${px}px < 4：不得改写 --kb`)
    assert.equal(kb.sink.marks.length, 1, `抬升 ${px}px 被抑制时也不打 kb 埋点（埋点跟写入走）`)
  }

  // 差值恰为 4：出货是 `< KB_DEAD_PX` 的早退门，因此**会**改写。
  // 卡片措辞「差值 ≤4 不改写」比代码严 1px——此断言钉现状，若将来改成 `>`/`<=` 这里先红。
  kb.lift(4)
  kb.applyKeyboardLift()
  assert.deepEqual(kb.values(), ['0px', '4px'], '差值恰为 4px：早退门不成立，改写 4px')
  assert.equal(kb.kbLastPx, 4, '写入后基准跟到 4')

  // 换了基准之后，抖动窗口整体跟着移动（不是永远对着 0 比）。
  for (const px of [6, 7]) {
    kb.lift(px)
    kb.applyKeyboardLift()
  }
  assert.deepEqual(kb.values(), ['0px', '4px'], '基准 4 附近的 6/7px 抖动同样被抑制')
  kb.lift(8)
  kb.applyKeyboardLift()
  assert.deepEqual(kb.values(), ['0px', '4px', '8px'], '相对基准 4 差 4px：改写')

  // px===0 的门必须保底：键盘收起时要无条件把 --kb 归零，否则输入区悬在半空。
  // 挑一个「差值 < 4」的基准，专门证明救它的是 `px&&` 而不是绝对值比较。
  const collapse = liftSandbox({ baseline: 2 })
  collapse.lift(0)
  collapse.applyKeyboardLift()
  assert.deepEqual(collapse.values(), ['0px'], '基准 2、本次 0（差 2px < 4）：px&& 短路仍然写 0px')
  assert.ok(collapse.sink.marks.includes('kb'), '归零这次也要打 kb 埋点')

  // 浏览器自己 pan 过时 offsetTop 已吃掉一部分：不能重复抬。
  const panned = liftSandbox()
  panned.offsets(700, 40) // 800-700-40 = 60
  panned.applyKeyboardLift()
  assert.deepEqual(panned.values(), ['60px'], 'offsetTop 被减掉（浏览器 pan 过的部分不重复抬）')
  const clamped = liftSandbox()
  clamped.offsets(700, 120) // 800-700-120 = -20 → 0
  clamped.applyKeyboardLift()
  assert.deepEqual(clamped.values(), ['0px'], '算出来是负数时钳到 0（不写 -20px）')
})

// ------------------------------------------------------- T3 基准只在写入路径上更新

test('kbLastPx re-bases only on the write path, so a suppressed call cannot latch the dead zone shut', () => {
  const body = extract(js, 'applyKeyboardLift')
  const guardAt = body.indexOf('<KB_DEAD_PX)return')
  const rebaseAt = body.indexOf('kbLastPx=px')
  assert.ok(guardAt > -1 && rebaseAt > -1, '早退门与基准赋值都必须存在')
  assert.ok(rebaseAt > guardAt, '基准赋值必须在早退门之后——挪到门之前，差值恒为 0，--kb 从此再也写不进去（永久闭锁）')
  // 基准与出货量同一条语句链：记的就是「这次写进去的值」，不可能记成别的。
  assert.match(body, /kbLastPx=px;probeMark\('kb'\);st\.setProperty\('--kb',px\+'px'\)/,
    'kbLastPx=px 与 setProperty(--kb, px) 紧邻：基准与出货量不允许各说各话')

  // 行为侧：被抑制的调用不许动基准，否则下一次真抬升就测不出来。
  const kb = liftSandbox()
  kb.lift(3)
  kb.applyKeyboardLift()
  assert.deepEqual(kb.values(), [], '3px 被抑制')
  assert.equal(kb.kbLastPx, 0, '被抑制的调用不改基准（否则基准会被抖动悄悄拖走）')

  kb.lift(4)
  kb.applyKeyboardLift()
  assert.deepEqual(kb.values(), ['4px'], '基准仍是 0，故 4px 这次比较成立并写入')
  assert.equal(kb.kbLastPx, 4)

  kb.lift(6)
  kb.applyKeyboardLift()
  assert.equal(kb.kbLastPx, 4, '抑制后基准仍是上次写入的 4（不是本次估算的 6）')
})

// ------------------------------------------------------------- T4 iOS 分支

test('iOS pins --kb to 0px and returns before touching visualViewport; the lift there rides on --app-height instead', () => {
  // 出货实况：`if(appleTouchDevice){st.setProperty('--kb','0px');return}`。
  // 卡片的措辞是「iOS 分支不写 --kb」；实际是**不写抬升量**——零值仍被显式钉一次。
  // 本测试只钉行为，不为这行代码的动机背书：无论作者当初怎么想，iOS 上落地的就是 --kb=0px。
  const ios = liftSandbox({ apple: true, forbidViewportRead: true })
  ios.applyKeyboardLift() // visualViewport 的 getter 会抛，能跑完就证明没读
  assert.deepEqual(ios.sink.writes, [['--kb', '0px']], 'iOS 分支只钉一次 --kb=0px，且钉的是零值')
  assert.equal(ios.sink.marks.length, 0, 'iOS 分支在打点之前就 return 了')
  assert.equal(ios.kbLastPx, 0, 'iOS 分支不碰安卓的基准')
  // 早退分支的整段函数体里不许出现 kbLastPx：iOS 侧既不读也不写这个安卓基准。
  const appleBranch = extract(js, 'applyKeyboardLift').match(/\{st\.setProperty\('--kb','0px'\);return\}/)
  assert.ok(appleBranch, 'iOS 分支的形体（钉零值后立即 return）')
  assert.doesNotMatch(appleBranch[0], /kbLastPx/, '早退发生在基准赋值之前（分支体里没有 kbLastPx）')

  // 安卓那条路不许走 --app-height（布局视口不再被压缩，改它会把整页高度改坏）。
  const androidSink = { writes: [] }
  const androidHeight = new Function('document', 'window', 'sink', `
    let viewportRaf=1,lastAppHeight=0;
    const appleTouchDevice=false;
    ${extract(js, 'applyViewportHeight')}
    return { applyViewportHeight }
  `)(viewportStub(androidSink), { visualViewport: { height: 700 }, innerHeight: 800 }, androidSink)
  androidHeight.applyViewportHeight()
  assert.deepEqual(androidSink.writes, [], '安卓：applyViewportHeight 进门就 return，一个字都不写')

  // iOS 的抬升：--app-height 来自 visualViewport.height，且同高不重写。
  const sink = { writes: [] }
  const window = { visualViewport: { height: 740 }, innerHeight: 800 }
  const height = new Function('document', 'window', 'sink', `
    let viewportRaf=1,lastAppHeight=0;
    const appleTouchDevice=true;
    ${extract(js, 'applyViewportHeight')}
    return { applyViewportHeight, get viewportRaf(){ return viewportRaf } }
  `)(viewportStub(sink), window, sink)
  height.applyViewportHeight()
  assert.deepEqual(sink.writes, [['--app-height', '740px']], 'iOS：--app-height = visualViewport.height')
  assert.equal(height.viewportRaf, 0, '进函数即清 rAF 闸（一次视口变化只排一帧）')
  height.applyViewportHeight()
  assert.deepEqual(sink.writes, [['--app-height', '740px']], '同高不重写（lastAppHeight 去重）')
  window.visualViewport = { height: 700 }
  height.applyViewportHeight()
  assert.deepEqual(sink.writes, [['--app-height', '740px'], ['--app-height', '700px']], '换高才写第二次')
  assert.ok(sink.writes.every(([name]) => name !== '--kb'), 'applyViewportHeight 全程不碰 --kb')
})

// ------------------------------------------------------ T5 接线（scheduleViewport）

test('scheduleViewport: the lift runs on every viewport change, Android debounces the fill without a frame, iOS takes exactly one rAF for --app-height', () => {
  // 为什么值得钉：键盘事件的三条路（visualViewport.resize / window.resize / 首屏）都汇到
  // 这一个入口。抬升若被 rAF 挡住一拍，安卓的输入区就会「先跳一下再回来」；
  // 反过来 iOS 若在事件里同步改 --app-height，一帧内多次改高会抖。
  function scheduleSandbox({ apple }) {
    const sink = { lifts: 0, fills: 0, frames: [], writes: [] }
    const window = { visualViewport: { height: 700, offsetTop: 0 }, innerHeight: 800 }
    const api = new Function('document', 'window', 'requestAnimationFrame', 'sink', `
      let viewportRaf=0,lastAppHeight=0,viewportFillTimer=null,kbLastPx=0;
      const appleTouchDevice=${apple};
      function applyKeyboardLift(){ sink.lifts++ }
      function scheduleViewportFill(){ sink.fills++ }
      ${extract(js, 'applyViewportHeight')}
      ${extract(js, 'scheduleViewport')}
      return { scheduleViewport, get viewportRaf(){ return viewportRaf } }
    `)(viewportStub(sink), window, (cb) => { sink.frames.push(cb); return sink.frames.length }, sink)
    return Object.assign(api, { sink, window })
  }

  const android = scheduleSandbox({ apple: false })
  android.scheduleViewport()
  assert.equal(android.sink.lifts, 1, '安卓：每次视口变化都先跑抬升（不等帧）')
  assert.equal(android.sink.frames.length, 0, '安卓不排 rAF（那条路只服务 --app-height）')
  assert.equal(android.sink.fills, 1, '安卓只防抖补屏')
  assert.equal(android.sink.writes.length, 0, '安卓这条路上不写 --app-height')
  android.scheduleViewport()
  assert.equal(android.sink.lifts, 2, '第二次事件仍然要重算抬升')

  const ios = scheduleSandbox({ apple: true })
  ios.scheduleViewport()
  assert.equal(ios.sink.lifts, 1, 'iOS：抬升同样在事件里先跑')
  assert.equal(ios.sink.frames.length, 1, 'iOS：--app-height 排一帧')
  assert.equal(ios.sink.fills, 0, '补屏要等帧内跑完 --app-height 之后再排')
  assert.equal(ios.viewportRaf, 1, '闸已占上')
  ios.scheduleViewport()
  assert.equal(ios.sink.frames.length, 1, '帧内再来的事件不重复排帧（闸）')
  assert.equal(ios.sink.lifts, 2, '但抬升照跑——闸只挡 --app-height，不挡键盘抬升')
  ios.sink.frames[0]()
  assert.equal(ios.sink.writes.length, 1, '帧回调写了 --app-height')
  assert.equal(ios.sink.fills, 1, '补屏也在帧内排上')
  assert.equal(ios.viewportRaf, 0, 'applyViewportHeight 清闸（下一帧还能排）')
  ios.scheduleViewport()
  assert.equal(ios.sink.frames.length, 2, '清闸后再来的事件重新排帧')

  // 接线本体：两个 resize 源 + 首屏各跑一次。漏掉 window.resize 就收不到旋转/分屏。
  assert.match(js,
    /window\.visualViewport\?\.addEventListener\('resize',scheduleViewport\);window\.addEventListener\('resize',scheduleViewport\);applyViewportHeight\(\);applyKeyboardLift\(\);/,
    '两个 resize 源都挂到同一入口，且首屏主动跑一次初始几何')
})

// ------------------------------------------------------- T6 反向验证（不改源文件）

test('reverse validation: zeroing KB_DEAD_PX opens the dead zone, inverting the operator turns it inside out, and inlining the threshold breaks the named-constant pin', () => {
  // 全部在字符串副本上跑：源文件一个字节都不动（红线），但同一批断言在副本上必须变红。
  const zeroed = js.replace(/const KB_DEAD_PX=\d+/, 'const KB_DEAD_PX=0')
  assert.notEqual(zeroed, js, '副本确实被改过（否则下面的「变红」不算数）')
  const opened = liftSandbox({ source: zeroed })
  for (const px of [1, 2, 3]) {
    opened.lift(px)
    opened.applyKeyboardLift()
  }
  assert.deepEqual(opened.values(), ['1px', '2px', '3px'],
    'KB_DEAD_PX=0 ⇒ 差值 <0 永不成立，死区消失、每一抖都改写（T2 的抑制断言在这里必须红）')
  // 真对照组：同一串几何量喂给真源码，必须一笔都不写。
  const realControl = liftSandbox()
  for (const px of [1, 2, 3]) {
    realControl.lift(px)
    realControl.applyKeyboardLift()
  }
  assert.deepEqual(realControl.values(), [], '对照组：真源码在同样的 1/2/3px 抖动下一笔都不写')

  // 方向反了会「内外颠倒」：抖动照写、大位移反而被挡——这正是卡片点名的假修法。
  // 每个副本各起一个新沙箱、基准都从 0 起算：不靠链式基准，才看得出方向本身反了。
  const inverted = js.replace(/Math\.abs\(px-kbLastPx\)<KB_DEAD_PX\)return/,
    'Math.abs(px-kbLastPx)>KB_DEAD_PX)return')
  assert.notEqual(inverted, js)
  const flippedJitter = liftSandbox({ source: inverted })
  flippedJitter.lift(2)
  flippedJitter.applyKeyboardLift()
  assert.deepEqual(flippedJitter.values(), ['2px'], '反向门：2px 抖动被放行（该挡的挡不住）')
  const flippedJump = liftSandbox({ source: inverted })
  flippedJump.lift(10)
  flippedJump.applyKeyboardLift()
  assert.deepEqual(flippedJump.values(), [], '反向门：10px 真抬升被吞掉（该写的写不进）')
  // 对照组：同一组几何量喂给真源码，结论正好相反。
  const realJitter = liftSandbox()
  realJitter.lift(2)
  realJitter.applyKeyboardLift()
  assert.deepEqual(realJitter.values(), [], '真源码：2px 抖动被挡')
  const realJump = liftSandbox()
  realJump.lift(10)
  realJump.applyKeyboardLift()
  assert.deepEqual(realJump.values(), ['10px'], '真源码：10px 真抬升写得进去')

  // 阈值内联成字面量 = 判据与常量脱钩，改 KB_DEAD_PX 不再有任何效果。
  const inlined = js.replace(/Math\.abs\(px-kbLastPx\)<KB_DEAD_PX\)return/,
    'Math.abs(px-kbLastPx)<4)return')
  assert.match(js, NAMED_THRESHOLD, '真源码的阈值是具名常量')
  assert.doesNotMatch(inlined, NAMED_THRESHOLD, '内联成 4 之后同一个正则不匹配（改常量不再能调死区）')
  assert.doesNotMatch(extract(inlined, 'applyKeyboardLift'), DEAD_ZONE_GUARD,
    '内联副本也跑不过规范形判据——即「常量级 + 文本级」两层钉子是活的，不是恒真')
})
