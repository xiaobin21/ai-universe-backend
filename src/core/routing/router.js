'use strict';

/**
 * 自动路由（契约 §12）。
 * 三模式：manual（不擅切）/ recommend（推荐待确认）/ auto（自动）。
 * 本模块负责：任务分类 fitScore 打分、候选过滤、每任务预算门、纯打分选择；
 * autoSelectForUser 为 DB 入口（读目录/凭证/预算，写 routing_decision 审计）。
 *
 * 候选模型描述（注入式，便于纯函数单测）：
 * {
 *   id, provider, slug, displayName,
 *   capabilities: { supportsVision, supportsTools, supportsThinking,
 *                   supportsStructuredOutput, contextWindow, ... },
 *   pricing: { inputMicroPerMtok, outputMicroPerMtok },
 *   providerEnabled, circuitOpen,
 * }
 */

const { query } = require('../../db/pool');
const { AppError } = require('../errors');
const { perTaskBudget } = require('../billing/budget');

// ---------- 任务分类 ----------
const CODING_RE = /```|`[^`\n]+`|\bfunction\b|\bdef\s|\bclass\s|\bimport\b|\bconst\b|\blet\b|\bvar\b|=>|console\.(log|error|warn)|traceback|exception|\berror\b|报错|代码|编程|算法|sql|\bbug\b|debug|stack\s*trace|syntaxerror|referenceerror|typeerror|编译|程序|函数|数组|指针/i;
const REASONING_RE = /为什么|为何|分析|推理|对比|比较|数学|方案|是否值得|该不该|权衡|利弊|证明|推导|论证|评估|哪个好|哪个更|是否合理|如何看待/i;

/**
 * @param {string} text
 * @param {boolean} hasImages
 * @returns {'vision'|'coding'|'reasoning'|'chat'}
 */
function classifyTask(text, hasImages = false) {
  if (hasImages) return 'vision';
  const t = String(text || '');
  if (CODING_RE.test(t)) return 'coding';
  if (REASONING_RE.test(t)) return 'reasoning';
  return 'chat';
}

// ---------- 能力适配分 ----------
/**
 * @param {object} capabilities ModelCapabilities
 * @param {'vision'|'coding'|'reasoning'|'chat'} task
 * @returns {number} 整数分
 */
function fitScore(capabilities, task) {
  const cap = capabilities || {};
  switch (task) {
    case 'vision':
      return cap.supportsVision ? 60 : -999;
    case 'coding': {
      let s = 0;
      if (cap.supportsStructuredOutput) s += 18;
      if (cap.supportsTools) s += 14;
      return s; // 两者都没有 → 0（仍可被价格/上下文救回，但远低于有能力者）
    }
    case 'reasoning':
      return cap.supportsThinking ? 40 : 8;
    case 'chat':
    default:
      return 6;
  }
}

/**
 * 该任务是否已含不可逆副作用（工具已执行）——有 tool_result part 即视为已执行。
 * @param {Array<object>} parts ChatPart[]
 * @returns {boolean}
 */
function hasIrreversibleSideEffect(parts) {
  if (!Array.isArray(parts)) return false;
  return parts.some((p) => p && p.type === 'tool_result');
}

/**
 * 纯打分：对已过滤候选按 score 排序，取最高。
 * 量纲说明：fit 为整数分；价格项 (in+out)*0.25 中价格单位是 micro/百万 token，
 *   例如 gpt-4o in=17.8元≈17.8e6 micro → (17.8+71)e6*0.25 ≈ 22.2e6，
 *   与 fit（个位~60）量纲严重不匹配 —— 这是按契约 §12 原文实现的权重，
 *   实际效果是「同档能力内价格几乎决定排序」，仅在能力分差距悬殊时覆盖。
 *   如需让能力更主导，应把价格项除以 1e6（标注于此，未改动契约权重）。
 */
function scoreCandidate(c, task) {
  const fit = fitScore(c.capabilities, task);
  const inP = c.pricing?.inputMicroPerMtok || 0;
  const outP = c.pricing?.outputMicroPerMtok || 0;
  const ctxPenalty = (c.capabilities?.contextWindow || 0) > 500000 ? 2 : 0;
  return fit - (inP + outP) * 0.25 - ctxPenalty;
}

/**
 * 纯选择：过滤 + 预算门 + 打分。
 * @param {{task:string, contextNeed:number, credentials:Set, models:object[],
 *          dailyBudget:number, maxOutTokens:number, demoMode?:boolean}} args
 * @returns {{model:object|null, score:number|null, reason:string, candidates:object[]}}
 */
function autoSelect({ task, contextNeed, credentials = new Set(), models = [], dailyBudget, maxOutTokens, demoMode = false }) {
  const perTask = perTaskBudget(dailyBudget);

  const survived = [];
  const dropped = [];
  for (const m of models) {
    const cap = m.capabilities || {};
    // 1) 模态能力
    if (task === 'vision' && !cap.supportsVision) { dropped.push({ m, why: 'no_vision' }); continue; }
    // 2) provider 可用
    if (m.providerEnabled === false) { dropped.push({ m, why: 'provider_disabled' }); continue; }
    if (m.circuitOpen) { dropped.push({ m, why: 'circuit_open' }); continue; }
    // 3) 凭证：已配 或 demo 模式
    if (!demoMode && !credentials.has(m.provider)) { dropped.push({ m, why: 'no_credential' }); continue; }
    // 4) 上下文窗口够用
    if ((cap.contextWindow || 0) < contextNeed) { dropped.push({ m, why: 'context_too_small' }); continue; }
    // 5) 有价格
    if (!m.pricing) { dropped.push({ m, why: 'no_pricing' }); continue; }
    // 6) 每任务预算门：预估 floor((ctx*in + maxOut*out)/1e6) > perTask 淘汰
    const estCost = Math.floor(
      (contextNeed * m.pricing.inputMicroPerMtok + maxOutTokens * m.pricing.outputMicroPerMtok) / 1_000_000
    );
    if (estCost > perTask) { dropped.push({ m, why: 'over_task_budget', estCost }); continue; }
    survived.push({ m, estCost });
  }

  if (!survived.length) {
    return { model: null, score: null, reason: 'no_candidate', candidates: [], dropped };
  }

  // 打分排序：分高优先；同分则便宜者优先（estCost 小）；再同分则窗口大者优先
  const ranked = survived
    .map(({ m, estCost }) => ({
      model: m,
      score: scoreCandidate(m, task),
      estCost,
    }))
    .sort((a, b) =>
      b.score - a.score ||
      a.estCost - b.estCost ||
      (b.model.capabilities?.contextWindow || 0) - (a.model.capabilities?.contextWindow || 0)
    );

  return {
    model: ranked[0].model,
    score: ranked[0].score,
    reason: 'best_fit',
    candidates: ranked,
    dropped,
  };
}

/**
 * DB 入口：为用户挑模型。
 * @param {string} userId
 * @param {{text:string, hasImages:boolean, contextNeed:number, maxOutTokens:number,
 *          demoMode?:boolean, recordDecision?:boolean}} opts
 */
async function autoSelectForUser(userId, { text, hasImages = false, contextNeed, maxOutTokens, demoMode = false, recordDecision = true }) {
  const task = classifyTask(text, hasImages);

  // 目录：models + provider 启停/熔断 + 能力 + 价格
  const { rows: modelRows } = await query(
    `SELECT m.id AS "modelId", m.slug, m.display_name AS "displayName",
            p.slug AS provider, p.enabled AS "providerEnabled", p.circuit_open AS "circuitOpen",
            mc.capabilities,
            pv.input_price_micro_per_mtok AS "inPrice",
            pv.output_price_micro_per_mtok AS "outPrice"
       FROM models m
       JOIN providers p            ON p.id = m.provider_id
       JOIN model_capabilities mc  ON mc.model_id = m.id
       LEFT JOIN pricing_versions pv
             ON pv.provider = p.slug AND pv.model = m.slug
            AND pv.effective_from <= now()
            AND (pv.effective_to IS NULL OR pv.effective_to > now())`
  );

  // 用户已配置凭证的 provider 集合
  const { rows: credRows } = await query(
    `SELECT pr.provider_id AS "providerId"
       FROM provider_credentials pr
      WHERE pr.user_id = $1`,
    [userId]
  );
  const credentials = new Set(credRows.map((r) => r.providerId));

  const { rows: setRows } = await query(
    'SELECT budget_daily_micro AS "daily", max_output_tokens AS "maxOut" FROM user_settings WHERE user_id = $1',
    [userId]
  );
  const dailyBudget = setRows.length ? Number(setRows[0].daily) : 10_000_000;
  const outCap = maxOutTokens || (setRows.length ? Number(setRows[0].maxOut) : 4096);

  const models = modelRows.map((r) => ({
    id: r.modelId,
    provider: r.provider,
    slug: r.slug,
    displayName: r.displayName,
    capabilities: r.capabilities,
    pricing: r.inPrice == null ? null : {
      inputMicroPerMtok: Number(r.inPrice),
      outputMicroPerMtok: Number(r.outPrice),
    },
    providerEnabled: r.providerEnabled,
    circuitOpen: r.circuitOpen,
  }));

  const sel = autoSelect({ task, contextNeed, credentials, models, dailyBudget, maxOutTokens: outCap, demoMode });

  if (recordDecision) {
    await query(
      `INSERT INTO audit_logs(id, user_id, action, meta_json)
       VALUES ($1,$2,'routing_decision',$3::jsonb)`,
      [`aud_${require('crypto').randomUUID()}`, userId, JSON.stringify({
        task,
        chosen: sel.model ? { provider: sel.model.provider, slug: sel.model.slug } : null,
        score: sel.score,
        reason: sel.reason,
        contextNeed,
        candidates: sel.candidates.slice(0, 5).map((c) => ({
          provider: c.model.provider, slug: c.model.slug, score: c.score,
        })),
      })]
    ).catch(() => {/* 审计失败不影响主流程 */});
  }

  return { task, ...sel };
}

module.exports = {
  classifyTask,
  fitScore,
  hasIrreversibleSideEffect,
  scoreCandidate,
  autoSelect,
  autoSelectForUser,
};
