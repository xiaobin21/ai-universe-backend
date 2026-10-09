'use strict';

/**
 * 适配器注册表（契约 §2）。
 * - 懒加载：getAdapter 才 require 对应供应商文件，避免适配器尚未落地时整包 require 报错。
 * - 未实现的适配器文件缺失时，抛 AppError('badreq','适配器未实现: <provider>')。
 * - listAdapters 静态返回 8 家 ProviderId（目录层面即可枚举，不依赖文件存在）。
 */

const { AppError } = require('../core/errors');

/** 8 家供应商 ProviderId（顺序即目录展示顺序） */
const PROVIDERS = Object.freeze([
  'openai',
  'anthropic',
  'gemini',
  'deepseek',
  'qwen',
  'zhipu',
  'doubao',
  'kimi',
]);

// provider -> [文件, 导出类名]
const FILE_MAP = {
  openai:     ['./openai.js', 'OpenAIAdapter'],
  anthropic: ['./anthropic.js', 'AnthropicAdapter'],
  gemini:     ['./gemini.js', 'GeminiAdapter'],
  deepseek:  ['./deepseek.js', 'DeepseekAdapter'],
  qwen:       ['./qwen.js', 'QwenAdapter'],
  zhipu:      ['./zhipu.js', 'ZhipuAdapter'],
  doubao:     ['./doubao.js', 'DoubaoAdapter'],
  kimi:       ['./kimi.js', 'KimiAdapter'],
};

const cache = new Map();

/**
 * 按 provider id 取适配器单例。
 * @param {string} provider
 * @returns {import('./base').BaseModelAdapter}
 */
function getAdapter(provider) {
  if (!PROVIDERS.includes(provider)) {
    throw new AppError('badreq', `未知供应商: ${provider}`);
  }
  if (cache.has(provider)) return cache.get(provider);

  const [file, exportName] = FILE_MAP[provider];
  let mod;
  try {
    mod = require(file);
  } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND') {
      throw new AppError('badreq', `适配器未实现: ${provider}`, { provider });
    }
    throw e;
  }
  const Cls = mod[exportName];
  if (!Cls) {
    throw new AppError('internal', `适配器文件未导出 ${exportName}: ${provider}`, { provider });
  }
  const instance = new Cls();
  cache.set(provider, instance);
  return instance;
}

/** @returns {string[]} 全部 8 家 ProviderId */
function listAdapters() {
  return PROVIDERS.slice();
}

module.exports = { getAdapter, listAdapters, PROVIDERS };
