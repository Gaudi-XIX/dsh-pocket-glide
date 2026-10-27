// 审计 P0-1（bundle E 第六节）：桥把真宿主的 state 应答裁剪成手机视图，但所有替身测试喂的都是
// 测试自造的对象 —— 真宿主改字段名/改形状时，`rows()` 会静默回空数组、`working` 会恒 false
// （2026-10-27 那轮 working 恒 false 就是这条：从 Bot 记录上取，而 live 只在 work.bots 里）。
//
// 本文件把两件事钉在一起：
//   ① 「桥消费的每个键」↔「ds-bot 真源里的字面量」（读真源，不读替身）；
//   ② 一份按真源形状构造的 state 应答喂给真的 botTeamView，断言手机视图取到了活态。
// ds-bot 是第三方装载包，位置随机器变：探不到源码就 skip（本机契约只能在本机校验）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { isRecord } from '../lib/projections.js'

const BRIDGE_SOURCE = readFileSync(new URL('../lib/bridge.js', import.meta.url), 'utf8')

function dsBotRoot() {
  const candidates = [
    process.env.DSH_BOT_SRC,
    process.env.DSH_HOME && join(process.env.DSH_HOME, 'profiles', 'desktop', 'node_modules', 'ds-bot'),
    'F:/AgentData/dsh/data/profiles/desktop/node_modules/ds-bot',
  ].filter(Boolean)
  return candidates.find((dir) => existsSync(join(dir, 'src', 'host', 'channel.js')))
}

const DS_BOT = dsBotRoot()
const hostSource = (rel) => readFileSync(join(DS_BOT, 'src', 'host', rel), 'utf8')

// The real function out of lib/bridge.js — a renamed key or a dropped branch can never
// leave these assertions green by accident (same splice discipline as
// test/device-panel-exec.test.js).
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `${name} must exist in lib/bridge.js`)
  let depth = 0
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  assert.fail(`unbalanced braces after ${name}`)
}

const botTeamView = vm.runInNewContext(`(${extractFunction(BRIDGE_SOURCE, 'botTeamView')})`, { isRecord })
// Objects built inside that context carry another realm's prototypes, so deepStrictEqual
// would fail on identity alone. The phone only ever sees JSON, so compare JSON.
const plain = (value) => JSON.parse(JSON.stringify(value))

// A state answer laid out exactly like channel.js view() + live(): arrays for bots and
// rooms, a Record for questions, live work under `work`. Field names are the ones the
// contract test below pins to the ds-bot source.
const stateAnswer = () => ({
  revision: 7,
  mainBotIds: ['b1'],
  bots: [{ id: 'b1', name: 'Ops', role: 'editor', model: 'deepseek/x', sessionId: 's1', parts: ['s0'] }],
  rooms: [{ id: 'r1', name: 'Review', preview: 'Ops：看这里', members: [{ id: 'b1', name: 'Ops' }] }],
  questions: { s1: { callId: 'c1' } },
  work: {
    bots: { b1: { since: 1, tool: 'bash', target: 'bridge.js' } },
    rooms: { r1: [{ botId: 'b1', since: 2, tool: 'grep', speaking: true }] },
    approvals: [
      {
        id: 'a1',
        sessionId: 's1',
        botId: 'b1',
        roomId: 'r1',
        tool: 'bash',
        reason: 'needs to write',
        detail: { text: 'rm -rf build', code: 'x' },
        at: 5,
        answerable: true,
      },
    ],
  },
})

test('the Bot page view keeps reading the fields ds-bot actually sends', (t) => {
  if (!DS_BOT) return t.skip('ds-bot source is not installed beside this host')
  const channel = hostSource('channel.js')
  const turns = hostSource('turns.js')
  const approvals = hostSource('approvals.js')
  const parts = hostSource('parts.js')
  const store = hostSource('store.js')

  // view().bots must stay an ARRAY: botTeamView's rows() only maps arrays, so a Record
  // here would answer [] and the phone would list no Bots at all.
  assert.match(channel, /bots: Object\.values\(state\.bots\)\.map\(/,
    'bots must be an array — a Record would make the phone list no Bots')
  // ...and every row must carry a string sessionId, which is botTeamView's filter.
  assert.match(channel, /sessionId: rt\.chatOf\(bot\.id\)/,
    'bots[].sessionId is the key the phone opens the chat by')
  assert.match(store, /const chatOf = botId => botOf\(botId\)\?\.sessionId \?\? botId/,
    'chatOf must keep its string fallback — a Bot without its own chat part would vanish from the list')
  assert.match(channel, /mainBotIds: state\.mainBotIds/, 'mainBotIds is what marks a Bot as Main')

  // questions is a Record keyed by session id; only its count crosses the tunnel.
  assert.match(channel, /questions: state\.questions/, 'questions must stay the Record the bridge counts')
  assert.match(store, /questions: \{\}/, 'the store must still initialise questions as a Record')

  // The live half: work.bots[botId] / work.rooms[roomId] / work.approvals.
  assert.match(channel, /work: \{ bots: rt\.workView\(\), rooms: rt\.roomWorkView\(\), approvals: rt\.approvalsView\(\)/,
    'live().work must keep the three keys the bridge trims')
  // working comes from work.bots[botId].tool — doingOf must still put `tool` there.
  assert.match(turns, /return \{ tool: call\.name,/, 'doingOf must keep emitting tool: the phone draws the tool name')
  assert.match(turns, /bots\[botId\] = \{ since: entry\.since, \.\.\.doingOf\(entry\)/,
    'workView must stay keyed by botId')
  // work.rooms[roomId] must stay an ARRAY of members: the bridge tests it with Array.isArray
  // and marks the group as running when it is non-empty.
  assert.match(turns, /rooms\[roomId\] = \[\.\.\.\(rooms\[roomId\] \?\? \[\]\), \{ botId, \.\.\.work/,
    'roomWorkView must stay an array per room')

  // approvals: the bridge reads exactly id/sessionId/botId/roomId/tool/reason/detail/at/answerable.
  assert.match(approvals, /id,\s*\n\s*sessionId,\s*\n\s*botId,/, 'approval entries must keep id/sessionId/botId')
  assert.match(approvals, /detail: rt\.callDetail\?\.\(sessionId, request\.callId\)/, 'approval detail is the text the phone shows')
  assert.match(approvals, /at: Date\.now\(\)/, 'approval at is the age the phone prints')
  assert.match(approvals, /answerable: answer !== undefined/, 'answerable decides whether the phone may answer at all')

  // bot.earlier cursor: {part, beforeSeq} — a malformed cursor silently restarts the feed.
  assert.match(parts, /Number\.isInteger\(cursor\?\.part\)/, 'earlierPage reads cursor.part')
  assert.match(parts, /Number\.isInteger\(cursor\?\.beforeSeq\)/, 'earlierPage reads cursor.beforeSeq')
})

test('botTeamView turns a ds-bot shaped state answer into the phone view', () => {
  const view = botTeamView(stateAnswer())
  assert.equal(view.mainBotIds.length, 1)
  assert.deepEqual(plain(view.bots[0]), {
    id: 'b1',
    name: 'Ops',
    role: 'editor',
    model: 'deepseek/x',
    sessionId: 's1',
    waiting: false,
    working: { tool: 'bash' },
  })
  assert.deepEqual(plain(view.rooms[0]), {
    id: 'r1',
    name: 'Review',
    preview: 'Ops：看这里',
    running: true,
    members: [{ id: 'b1', name: 'Ops' }],
  })
  assert.deepEqual(plain(view.questions), { count: 1 })
  assert.deepEqual(plain(view.work.approvals[0]), {
    id: 'a1',
    sessionId: 's1',
    botId: 'b1',
    roomId: 'r1',
    tool: 'bash',
    reason: 'needs to write',
    detail: { text: 'rm -rf build', code: 'x' },
    at: 5,
    answerable: true,
  })
})

test('a working flag on the Bot record itself is not what the phone reads', () => {
  // The 2026-10-27 defect: work looked like it could be read off the Bot record, and it
  // answered false for ever. work.bots is the only live source (bundle E P0-1).
  const view = botTeamView({
    mainBotIds: [],
    bots: [{ id: 'b1', name: 'Ops', sessionId: 's1', working: true }],
    rooms: [],
    questions: {},
    work: { bots: {}, rooms: {}, approvals: [] },
  })
  assert.equal(view.bots[0].working, false, 'work.bots is the only live source of working')
})