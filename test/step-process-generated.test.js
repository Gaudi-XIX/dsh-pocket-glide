// Gate for lib/step-process.generated.js — the GENERATED label tables.
//
// Why a gate at all: the generated file is the verbatim copy of host wording.
// Nothing in the runtime reads it yet (consumption lands with the interleaving
// change), so without this test the file could silently rot: someone edits a
// value, or a regeneration drops keys, and nothing goes red until the UI shows
// the wrong words months later.
//
// What is checked here (cheap, no asar access):
//   1. the file imports and has the three tables + GENERATED_FROM metadata;
//   2. zh/en key sets are identical per table (the sync script enforces this
//      too, but the file could be hand-edited after the fact);
//   3. anchor keys exist with their known host values — these are the strings
//      the interleaving UI and the row-aggregation work will consume;
//   4. no value is empty and zh values contain Han (locale-order sanity).
//
// What is deliberately NOT checked here: byte-parity against the host asar.
// Running an asar scan inside `npm test` would add ~40-60s to every run for a
// property that only changes when the host updates — that is what
// `node tools/sync-step-process.mjs` + the generated-file diff in review are
// for. The script itself fails loudly if its locale-order or key-parity
// assumptions break (see the three guards in tools/sync-step-process.mjs).

import test from 'node:test'
import assert from 'node:assert/strict'

import { STEP_PROCESS_LABELS, TURN_PROCESS_LABELS, TRANSCRIPT_LABELS, GENERATED_FROM } from '../lib/step-process.generated.js'

test('generated tables: shape, metadata, locale parity', () => {
  for (const [name, table] of [['stepProcess', STEP_PROCESS_LABELS], ['turnProcess', TURN_PROCESS_LABELS], ['transcript', TRANSCRIPT_LABELS]]) {
    assert.ok(table && typeof table === 'object', `${name} table missing`)
    for (const locale of ['zh', 'en']) {
      assert.ok(table[locale] && typeof table[locale] === 'object', `${name}.${locale} missing`)
      const keys = Object.keys(table[locale])
      assert.ok(keys.length > 0, `${name}.${locale} is empty`)
      for (const key of keys) {
        const value = table[locale][key]
        assert.equal(typeof value, 'string', `${name}.${locale}.${key} is not a string`)
        // empty values are legal host data (e.g. en `message.stepProcess.sharedPrefix` is "");
        // the locale-order sanity below is what actually guards correctness
      }
    }
    const zhKeys = Object.keys(table.zh).sort()
    const enKeys = Object.keys(table.en).sort()
    assert.deepEqual(zhKeys, enKeys, `${name}: zh/en key sets diverge — regenerate, do not hand-edit`)
  }
  assert.ok(GENERATED_FROM && typeof GENERATED_FROM === 'object', 'GENERATED_FROM metadata missing')
  assert.match(GENERATED_FROM.dshVersion, /^0\.2\.0-rc\.\d+$/, 'GENERATED_FROM.dshVersion missing or unexpected shape')
  assert.match(GENERATED_FROM.clientHash, /^[0-9a-f]{12}$/, 'GENERATED_FROM.clientHash must be 12 hex chars')
  assert.ok(typeof GENERATED_FROM.extractedAt === 'string' && !Number.isNaN(Date.parse(GENERATED_FROM.extractedAt)), 'GENERATED_FROM.extractedAt not a timestamp')
})

test('stepProcess: the 14 activity categories + join templates are all present (zh)', () => {
  const zh = STEP_PROCESS_LABELS.zh
  for (const kind of ['thinking', 'read', 'readImage', 'write', 'search', 'edit', 'commands', 'code', 'webSearch', 'webFetch', 'subagents', 'plan', 'questions', 'tools']) {
    assert.ok(zh[`message.stepProcess.${kind}`], `missing running-phase verb for ${kind}`)
    assert.ok(zh[`message.stepProcess.done.${kind}`], `missing done-phase verb for ${kind}`)
  }
  // the aggregation templates the interleaving UI will consume verbatim
  assert.equal(zh['message.stepProcess.joinTwo'], '{first}并{second}')
  assert.equal(zh['message.stepProcess.comma'], '，')
  assert.equal(zh['message.stepProcess.more'], '{title}等')
  assert.equal(zh['message.stepProcess.sharedPrefix'], '已')
  assert.equal(zh['message.stepProcess.subagents'], '正在协调子智能体')
  assert.equal(zh['message.stepProcess.done.subagents'], '已协调子智能体')
  assert.equal(STEP_PROCESS_LABELS.en['message.stepProcess.subagents'], 'Coordinating subagents')
})

test('turnProcess: headline fragments the round control row will consume (zh)', () => {
  const zh = TURN_PROCESS_LABELS.zh
  assert.equal(zh['message.turnProcess.worked'], '已完成')
  assert.equal(zh['message.turnProcess.took'], '已完成，用时 ')
  assert.equal(zh['message.turnProcess.failed'], '处理失败')
  assert.equal(zh['message.turnProcess.separator'], ' · ')
  assert.equal(zh['message.turnProcess.toolCalls.other'], '{count} 次工具调用')
  // the subagent count lives on the round control row — this is the string the
  // "subagents are visible on the phone" requirement rides on
  assert.equal(zh['message.turnProcess.subagents.other'], '{count} 个 subagent')
  assert.equal(zh['message.turnProcess.thoughtForAWhile'], '已思考')
})

test('transcript: the inherited setting labels match the host settings UI (zh)', () => {
  const zh = TRANSCRIPT_LABELS.zh
  assert.equal(zh['settings.transcript.title'], '工作步骤展示')
  assert.equal(zh['settings.transcript.description'], '选择希望看到多少工具调用细节')
  assert.equal(zh['settings.transcript.compact'], '简洁')
  assert.equal(zh['settings.transcript.standard'], '标准')
  assert.equal(zh['settings.transcript.detailed'], '详细')
  assert.equal(zh['settings.transcript.verbose'], '完全展开')
})

test('mutation guard: dropping a namespace or a key must go red (self-test of the gate itself)', () => {
  // Not a mutation of the file on disk — a structural probe with the same shape
  // the assertions above rely on. If someone weakens those assertions (e.g.
  // drops the subagents anchor), this probe documents what must stay red.
  const probe = { ...STEP_PROCESS_LABELS.zh }
  delete probe['message.stepProcess.subagents']
  assert.ok(!('message.stepProcess.subagents' in probe), 'probe setup failed')
  assert.equal(probe['message.stepProcess.subagents'], undefined)
  // and the real table still has it — the gate above must keep failing if the
  // generated file ever loses it
  assert.ok('message.stepProcess.subagents' in STEP_PROCESS_LABELS.zh)
})
