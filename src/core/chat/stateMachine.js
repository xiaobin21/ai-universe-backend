'use strict';

/**
 * 生成任务状态机（契约 §10）。
 * 状态：queued / running / completed / failed / cancelled / interrupted。
 * 合法转换：
 *   queued     -> running
 *   running    -> completed | failed | cancelled | interrupted
 *   interrupted-> completed | failed
 *   failed     -> queued （仅自动重试次数 < 上限且错误可重试；本模块只做声明，是否满足条件由调用方判断）
 * completed / cancelled 为终态。
 *
 * 非法转换抛 AppError('conflict')（HTTP 409）。
 */

const { AppError } = require('../errors');

const STATUSES = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  INTERRUPTED: 'interrupted',
});

const TRANSITIONS = Object.freeze({
  queued: ['running'],
  running: ['completed', 'failed', 'cancelled', 'interrupted'],
  interrupted: ['completed', 'failed'],
  failed: ['queued'],
  completed: [],
  cancelled: [],
});

const TERMINAL = new Set(['completed', 'cancelled']);

/**
 * 从 -> 到 是否合法。
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
function canTransition(from, to) {
  if (!from || from === to) return false; // 不允许自循环（除显式声明外）
  const allowed = TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

/**
 * 断言合法转换；非法抛 AppError('conflict')。
 * @param {string} from
 * @param {string} to
 */
function assertTransition(from, to) {
  if (from === to) return; // 同态视为幂等空操作
  if (!canTransition(from, to)) {
    throw new AppError('conflict', `非法任务状态转换: ${from || '(空)'} -> ${to}`);
  }
}

/** 终态判断（completed/cancelled）。 */
function isTerminal(status) {
  return TERMINAL.has(status);
}

module.exports = { STATUSES, TRANSITIONS, canTransition, assertTransition, isTerminal };
