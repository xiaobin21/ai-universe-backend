'use strict';

/**
 * 服务端 demo 适配器（契约 §14）。
 *
 * 无任何真实 Key（用户凭证与平台环境变量都没有）时，按模型能力在服务端本地模拟一段
 * 「思考链 + 结构化文本」流式输出，使「无真实 Key」也能端到端演示完整 SSE 链路。
 *
 *  - 逐块 yield，可被 AbortSignal 取消。
 *  - 产出 usage（保守估算）；调用方（chat.service）负责：demo 不写 usage_records / costMicro=0。
 *  - 不触外网、不扣费。
 *
 * 与真实适配器同构：async generator yield 统一 ChatChunk（textDelta/reasoningDelta/usage/done）。
 */

const { estimateTokens } = require('../billing/tokenEstimate');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 从对话里取出最后一条 user 文本，用于让演示回复「有上下文感」。 */
function lastUserText(messages = []) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      const t = (messages[i].parts || [])
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join('');
      if (t) return t;
    }
  }
  return '';
}

function chunk(text, bytes = 24) {
  // 简单按字符切片，保证中文也能平滑流式
  const out = [];
  for (let i = 0; i < text.length; i += bytes) out.push(text.slice(i, i + bytes));
  return out;
}

/**
 * @param {object} req ChatRequest（已裁剪好的 messages、model.capabilities）
 * @param {AbortSignal} [signal]
 */
async function* runDemo(req, signal) {
  const caps = (req.model && req.model.capabilities) || {};
  const supportsThinking = !!caps.supportsThinking;
  const modelName = (req.model && req.model.displayName) || (req.model && req.model.providerModel) || 'demo';
  const userText = lastUserText(req.messages);
  const preview = userText.length > 60 ? userText.slice(0, 60) + '…' : userText;

  if (signal && signal.aborted) return;

  // 1) 思考链（仅声明支持 thinking 的模型）
  if (supportsThinking) {
    const reasoning = [
      `这是一次**演示模式**回复（未配置真实 ${modelName} 密钥）。`,
      `我会基于你的问题给出一段结构化样例，帮助你预览流式输出、思考链与多部分渲染。`,
      `你提到的内容大致是：「${preview || '（空）'}」。`,
    ].join('\n');
    for (const piece of chunk(reasoning, 18)) {
      if (signal && signal.aborted) return;
      yield { kind: 'reasoningDelta', text: piece };
      await sleep(12);
    }
  }

  // 2) 正文（结构化 markdown 样例）
  const body = [
    `## 你好，这是演示模式`,
    '',
    `当前模型：**${modelName}**。由于尚未配置该供应商的 API Key，本回复由内置演示引擎在本地生成，**不会产生任何真实费用**。`,
    '',
    `### 它可以演示什么`,
    `- 逐字流式输出（你能看到我一边打字一边出现）`,
    supportsThinking ? `- 独立的「思考过程」折叠块（就是上面那段）` : `- 本模型未声明思考链能力，故没有思考块`,
    `- 多部分消息渲染、取消、断线重放、用量与费用统计`,
    '',
    `### 如何接入真实模型`,
    `进入「设置 → 模型密钥」，填入对应供应商的 API Key 并保存；之后切换到真实模型即可走真实推理。`,
    '',
    `> 提示：演示模式下所有回复均为占位内容，不代表真实模型的能力与回答质量。`,
  ].join('\n');

  for (const piece of chunk(body, 20)) {
    if (signal && signal.aborted) return;
    yield { kind: 'textDelta', text: piece };
    await sleep(14);
  }

  // 3) 估算用量（仅供展示，demo 不计费）
  const promptTokens = (req.messages || []).reduce(
    (sum, m) => sum + (m.parts || []).reduce((s, p) => s + estimateTokens(p.text || ''), 0),
    0
  );
  const completionTokens = estimateTokens(body);
  yield {
    kind: 'usage',
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      usageSource: 'estimated',
    },
  };
  yield { kind: 'done' };
}

module.exports = { runDemo };
