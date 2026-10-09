'use strict';

/**
 * 路由测试（契约 §12）。纯注入式目录数据，不连 DB。
 * 覆盖：classifyTask / fitScore / 过滤（模态/凭证/熔断/上下文）/ 每任务预算门 / 打分 / 副作用判断。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyTask, fitScore, autoSelect, hasIrreversibleSideEffect, scoreCandidate,
} = require('../src/core/routing/router');

// ---- 注入式候选目录 ----
const mk = (over) => ({
  id: 'mdl_x', provider: 'p', slug: 'x', displayName: 'X',
  capabilities: {
    supportsVision: false, supportsTools: false, supportsThinking: false,
    supportsStructuredOutput: false, contextWindow: 128000,
  },
  pricing: { inputMicroPerMtok: 1_000_000, outputMicroPerMtok: 1_000_000 },
  providerEnabled: true, circuitOpen: false,
  ...over,
});

test('classifyTask：图片→vision，代码/报错→coding，为什么/分析→reasoning，否则 chat', () => {
  assert.equal(classifyTask('随便聊聊', false), 'chat');
  assert.equal(classifyTask('', true), 'vision');
  assert.equal(classifyTask('帮我看看这张图', true), 'vision');

  assert.equal(classifyTask('写一个排序算法的 python 函数'), 'coding');
  assert.equal(classifyTask('这段代码报 error 了，traceback 如下'), 'coding');
  assert.equal(classifyTask('SELECT * FROM t WHERE bug'), 'coding');
  assert.equal(classifyTask('```js const x = 1```'), 'coding');

  assert.equal(classifyTask('为什么天空是蓝色的'), 'reasoning');
  assert.equal(classifyTask('分析一下这两个方案的对比'), 'reasoning');
  assert.equal(classifyTask('这个数学题怎么推导'), 'reasoning');
  assert.equal(classifyTask('是否值得换工作'), 'reasoning');
});

test('fitScore：vision +60 否则 -999；coding struct+18/tools+14；reasoning think+40 否则+8；chat +6', () => {
  assert.equal(fitScore({ supportsVision: true }, 'vision'), 60);
  assert.equal(fitScore({ supportsVision: false }, 'vision'), -999);

  assert.equal(fitScore({ supportsStructuredOutput: true, supportsTools: true }, 'coding'), 32);
  assert.equal(fitScore({ supportsStructuredOutput: true, supportsTools: false }, 'coding'), 18);
  assert.equal(fitScore({ supportsStructuredOutput: false, supportsTools: true }, 'coding'), 14);

  assert.equal(fitScore({ supportsThinking: true }, 'reasoning'), 40);
  assert.equal(fitScore({ supportsThinking: false }, 'reasoning'), 8);

  assert.equal(fitScore({}, 'chat'), 6);
});

test('hasIrreversibleSideEffect：含 tool_result 即视为工具已执行', () => {
  assert.equal(hasIrreversibleSideEffect([{ type: 'text', text: 'hi' }]), false);
  assert.equal(hasIrreversibleSideEffect([{ type: 'tool_call', toolCallId: 'c1', name: 'x', args: {} }]), false);
  assert.equal(
    hasIrreversibleSideEffect([
      { type: 'tool_call', toolCallId: 'c1', name: 'x', args: {} },
      { type: 'tool_result', toolCallId: 'c1', content: 'done' },
    ]),
    true
  );
  assert.equal(hasIrreversibleSideEffect([]), false);
  assert.equal(hasIrreversibleSideEffect(null), false);
});

test('autoSelect：vision 任务淘汰无视觉能力模型，并按凭证过滤', () => {
  const models = [
    mk({ id: 'v', provider: 'v', slug: 'vision', capabilities: { supportsVision: true, contextWindow: 128000 } }),
    mk({ id: 't', provider: 't', slug: 'text', capabilities: { supportsVision: false, contextWindow: 128000 } }),
  ];
  const res = autoSelect({
    task: 'vision', contextNeed: 1000,
    credentials: new Set(['v', 't']), models,
    dailyBudget: 1_000_000, maxOutTokens: 1000,
  });
  assert.equal(res.model.slug, 'vision');
  const droppedText = res.dropped.find((d) => d.m.id === 't');
  assert.equal(droppedText.why, 'no_vision');
});

test('autoSelect：无凭证（非 demo）、provider 停用、熔断均过滤', () => {
  const models = [
    mk({ id: 'ok', provider: 'ok', slug: 'ok' }),
    mk({ id: 'nock', provider: 'nock', slug: 'nock' }),          // 无凭证
    mk({ id: 'dis', provider: 'dis', slug: 'dis', providerEnabled: false }),
    mk({ id: 'open', provider: 'open', slug: 'open', circuitOpen: true }),
  ];
  const res = autoSelect({
    task: 'chat', contextNeed: 1000,
    credentials: new Set(['ok']), models,
    dailyBudget: 1_000_000, maxOutTokens: 1000,
  });
  assert.equal(res.model.slug, 'ok');
  const why = Object.fromEntries(res.dropped.map((d) => [d.m.id, d.why]));
  assert.equal(why.nock, 'no_credential');
  assert.equal(why.dis, 'provider_disabled');
  assert.equal(why.open, 'circuit_open');
});

test('autoSelect：上下文窗口不足淘汰；demo 模式无需凭证', () => {
  const models = [
    mk({ id: 'big', provider: 'a', slug: 'big', capabilities: { contextWindow: 128000 } }),
    mk({ id: 'small', provider: 'b', slug: 'small', capabilities: { contextWindow: 8192 } }),
  ];
  const res = autoSelect({
    task: 'chat', contextNeed: 50000,
    credentials: new Set(), models,      // 空凭证
    dailyBudget: 1_000_000, maxOutTokens: 1000,
    demoMode: true,                       // demo 模式允许无凭证
  });
  assert.equal(res.model.slug, 'big');
  const small = res.dropped.find((d) => d.m.id === 'small');
  assert.equal(small.why, 'context_too_small');
});

test('autoSelect：每任务预算门（daily*0.2）淘汰超估费模型', () => {
  const models = [
    mk({ id: 'cheap', provider: 'c', slug: 'cheap',
         pricing: { inputMicroPerMtok: 100_000, outputMicroPerMtok: 100_000 } }),
    mk({ id: 'pricey', provider: 'p', slug: 'pricey',
         pricing: { inputMicroPerMtok: 100_000_000, outputMicroPerMtok: 100_000_000 } }),
  ];
  // daily=1_000_000 → perTask=200_000；contextNeed=10000, maxOut=1000
  // pricey 预估 = floor((10000*1e8 + 1000*1e8)/1e6) = floor(1.01e12/1e6)=1_010_000 > 200_000 淘汰
  const res = autoSelect({
    task: 'chat', contextNeed: 10000,
    credentials: new Set(['c', 'p']), models,
    dailyBudget: 1_000_000, maxOutTokens: 1000,
  });
  assert.equal(res.model.slug, 'cheap');
  const pricey = res.dropped.find((d) => d.m.id === 'pricey');
  assert.equal(pricey.why, 'over_task_budget');
});

test('autoSelect：coding 任务 struct+tools 模型胜出', () => {
  const models = [
    mk({ id: 'coder', provider: 'c', slug: 'coder',
         capabilities: { supportsStructuredOutput: true, supportsTools: true, contextWindow: 65536 },
         pricing: { inputMicroPerMtok: 800_000, outputMicroPerMtok: 8_000_000 } }),
    mk({ id: 'thinker', provider: 't', slug: 'thinker',
         capabilities: { supportsTools: true, supportsStructuredOutput: false, supportsThinking: true, contextWindow: 65536 },
         pricing: { inputMicroPerMtok: 3_000_000, outputMicroPerMtok: 16_000_000 } }),
  ];
  const res = autoSelect({
    task: 'coding', contextNeed: 1000,
    credentials: new Set(['c', 't']), models,
    dailyBudget: 1_000_000, maxOutTokens: 1000,
  });
  // coder fit=18+14=32；thinker fit=tools14（无 struct）
  assert.equal(res.model.slug, 'coder');
});

test('scoreCandidate：长上下文(>500k) 加 2 分惩罚', () => {
  const small = mk({ capabilities: { contextWindow: 128000 } });
  const huge = mk({ capabilities: { contextWindow: 1_000_000 } });
  const sSmall = scoreCandidate(small, 'chat');
  const sHuge = scoreCandidate(huge, 'chat');
  // 同价同 fit，huge 多 -2
  assert.equal(sSmall - sHuge, 2);
});

test('autoSelect：全部被过滤时返回 model=null', () => {
  const res = autoSelect({
    task: 'vision', contextNeed: 1000,
    credentials: new Set(), models: [mk({ id: 'a', provider: 'a', capabilities: { contextWindow: 128000 } })],
    dailyBudget: 1_000_000, maxOutTokens: 1000,
  });
  assert.equal(res.model, null);
  assert.equal(res.reason, 'no_candidate');
});
