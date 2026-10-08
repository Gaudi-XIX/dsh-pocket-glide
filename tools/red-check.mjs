// Red-form proof for the strengthened recall assertion (Task 7) — canonical version in
// dsh-pocket/tools/ (fixed from tmp/20261006-pocket-apply/). Red-form verifier template:
// (1) extractFunction pulls the REAL function out of lib/pages.js by brace balancing (async
//     prefix preserved — goal-queue-dock.test.js precedent); (2) a new Function sandbox injects
//     fake containers/document/rpc/showToast around the extracted functions; (3) a regression
//     simulation (fetchProjectionsNow stubbed to a no-op) replays the old defect — the stale
//     repaint must trip the NEW doesNotMatch(/data-id="m1"/) assertion where the OLD /m2|m1/
//     assertion stayed green. Reuse this shape when strengthening any rendered-HTML assertion:
//     prove the new assertion actually catches the regression it claims to catch.
// simulate "the refresh re-render regressed" by stubbing fetchProjectionsNow
// as a no-op — the finally-repaint then paints the stale pre-action rows, and
// the new doesNotMatch(/data-id="m1"/) pin must be the thing that catches it.
import assert from 'node:assert/strict';

const { mobilePageAssets } = await import(new URL('../lib/pages.js', import.meta.url));

const { js } = mobilePageAssets({ locale: 'zh' });

// extractFunction keeps the async prefix (goal-queue-dock.test.js precedent).
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    const c = source[i];
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) {
        const slice = source.slice(start, i + 1);
        const before = source.slice(Math.max(0, start - 6), start);
        return before.endsWith('async ') ? 'async ' + slice : slice;
      }
    }
  }
  throw new Error('unbalanced');
}

const REAL_QUEUE = { values: { inbox: { 'next-turn': [
  { id: 'm1', content: [{ type: 'text', text: '先跑测试' }] },
  { id: 'm2', content: [{ type: 'text', text: '' }, { type: 'image' }] },
] } } };

const fake = () => ({ innerHTML: '', hidden: true, offsetHeight: 120, querySelector: () => null });
const containers = { goalBar: fake(), queueDock: fake() };
const classState = {}, cssVars = {};
const document = { body: { classList: { toggle(n, on) { classState[n] = on; } }, style: { setProperty(k, v) { cssVars[k] = v; } } } };
const make = new Function('containers', 'document', 'rpc', 'showToast', `
  const L={queueRemoveFailed:'撤回失败',queueCount:'排队消息 {n} 条',queueImage:'图片',queueFile:'文件',queueUnrenderable:'[图片/文件]',queueEdit:'编辑',queueSave:'保存',queueCancel:'取消',queueRemove:'撤回',queueSteer:'立刻发送'}
  let currentGoal=null,queuedTurn=[],queueBusy=false,queueEditing=null,queueEditText='',activeSession='s1'
  const $=(id)=>containers[id]
  function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
  ${extractFunction(js, 'queuedRowsOf')}
  ${extractFunction(js, 'updateQueue')}
  ${extractFunction(js, 'renderQueueDock')}
  ${extractFunction(js, 'syncQueueHeight')}
  // REGRESSION SIMULATION: the refresh path no longer re-renders.
  async function fetchProjectionsNow(){}
  ${extractFunction(js, 'queueAction')}
  return { queueAction, seed(v){updateQueue(v)}, get html(){return containers.queueDock.innerHTML} }
`);
const box = make(containers, document, async () => REAL_QUEUE, () => {});
box.seed(REAL_QUEUE)
await box.queueAction('m1', { kind: 'remove' }, '撤回失败');

// The old assertion /m2|m1/ would pass here (stale m2 present = 假绿).
assert.match(box.html, /data-id="m1"/, 'stale paint still carries m1');
assert.match(box.html, /data-id="m2"/, 'stale paint still carries m2');
console.log('RED FORM CONFIRMED: re-render regressed -> stale html (m1 present);',
  'new doesNotMatch(/data-id="m1"/) fires where the old /m2|m1/ stayed green');
