'use strict';

/**
 * 状态机单测（契约 §10）：合法/非法转换、interrupted 恢复。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  STATUSES, TRANSITIONS, canTransition, assertTransition, isTerminal,
} = require('../src/core/chat/stateMachine');

test('合法转换：queued->running', () => {
  assert.equal(canTransition('queued', 'running'), true);
  assert.doesNotThrow(() => assertTransition('queued', 'running'));
});

test('合法转换：running -> completed/failed/cancelled/interrupted', () => {
  for (const to of ['completed', 'failed', 'cancelled', 'interrupted']) {
    assert.equal(canTransition('running', to), true, `running->${to}`);
  }
});

test('非法转换：queued 不能直接 completed', () => {
  assert.equal(canTransition('queued', 'completed'), false);
  assert.throws(() => assertTransition('queued', 'completed'), (e) => e.code === 'conflict');
});

test('非法转换：终态不可再转出', () => {
  assert.equal(isTerminal('completed'), true);
  assert.equal(isTerminal('cancelled'), true);
  assert.equal(canTransition('completed', 'running'), false);
  assert.equal(canTransition('cancelled', 'running'), false);
});

test('interrupted 恢复：->completed / ->failed', () => {
  assert.equal(canTransition('interrupted', 'completed'), true);
  assert.equal(canTransition('interrupted', 'failed'), true);
  // interrupted 不能直接 running
  assert.equal(canTransition('interrupted', 'running'), false);
});

test('failed 可回 queued（自动重试）', () => {
  assert.equal(canTransition('failed', 'queued'), true);
});

test('TRANSITIONS 覆盖全部 6 个状态', () => {
  assert.deepEqual(Object.keys(TRANSITIONS).sort(),
    ['cancelled', 'completed', 'failed', 'interrupted', 'queued', 'running']);
});

test('STATUSES 常量齐全', () => {
  assert.equal(STATUSES.QUEUED, 'queued');
  assert.equal(STATUSES.RUNNING, 'running');
  assert.equal(STATUSES.COMPLETED, 'completed');
  assert.equal(STATUSES.FAILED, 'failed');
  assert.equal(STATUSES.CANCELLED, 'cancelled');
  assert.equal(STATUSES.INTERRUPTED, 'interrupted');
});
