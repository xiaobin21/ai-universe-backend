'use strict';

/**
 * 幂等种子（契约 §5 / §6）：8 家 providers + 24 个 models + 能力 + 当前价格版本。
 * 重复执行不产生重复行（ON CONFLICT DO UPDATE）。
 * 价格：元/百万 token -> micro/百万 token = round(元 * 1e6)。
 */

const { query, withTransaction, endPool } = require('./pool');

// ---------- 8 家供应商 ----------
const PROVIDERS = [
  { slug: 'openai',    name: 'OpenAI',            base: 'https://api.openai.com/v1',                              kind: 'openai' },
  { slug: 'anthropic', name: 'Anthropic / Claude', base: 'https://api.anthropic.com',                              kind: 'anthropic' },
  { slug: 'gemini',    name: 'Google Gemini',     base: 'https://generativelanguage.googleapis.com',              kind: 'gemini' },
  { slug: 'deepseek',  name: 'DeepSeek',           base: 'https://api.deepseek.com/v1',                            kind: 'openai' },
  { slug: 'qwen',      name: '通义千问 Qwen',      base: 'https://dashscope.aliyuncs.com/compatible-mode/v1',     kind: 'openai' },
  { slug: 'zhipu',     name: '智谱 GLM',           base: 'https://open.bigmodel.cn/api/paas/v4',                   kind: 'openai' },
  { slug: 'doubao',    name: '豆包 Doubao',        base: 'https://ark.cn-beijing.volces.com/api/v3',               kind: 'openai' },
  { slug: 'kimi',      name: 'Kimi / Moonshot',    base: 'https://api.moonshot.cn/v1',                             kind: 'openai' },
];

// ---------- 24 个模型（id, provider, slug=原生模型名, 名称, ctx, out, flags, 入元, 出元） ----------
const MODELS = [
  ['gpt-4o',        'openai',    'gpt-4o',                 'GPT-4o',           128000,   16384, ['vision','tools','struct'], 17.8,  71],
  ['gpt-4o-mini',   'openai',    'gpt-4o-mini',            'GPT-4o mini',      128000,   16384, ['vision','tools','struct'], 1.07,  4.26],
  ['gpt-4.1',       'openai',    'gpt-4.1',                'GPT-4.1',          1047576,  32768, ['tools','struct'],          14.2,  56.8],
  ['o3-mini',       'openai',    'o3-mini',                'o3-mini',          200000,   65536, ['think','tools','struct'],  7.8,   31.2],
  ['claude-sonnet', 'anthropic', 'claude-sonnet-4-5-20250929', 'Claude Sonnet 4.5', 200000, 8192, ['vision','tools'],         21.3,  106.5],
  ['claude-haiku',  'anthropic', 'claude-3-5-haiku-latest',   'Claude Haiku 3.5',  200000, 8192, ['vision','tools'],         5.7,   28.4],
  ['claude-opus',   'anthropic', 'claude-opus-4-20250514',    'Claude Opus 4',     200000, 32000, ['vision','tools'],        106.5, 532.5],
  ['gemini-flash',  'gemini',    'gemini-2.0-flash',       'Gemini 2.0 Flash', 1048576,  8192,  ['vision','tools','struct'], 0.71,  2.84],
  ['gemini-pro',    'gemini',    'gemini-2.5-pro',         'Gemini 2.5 Pro',   1048576,  65536, ['vision','tools','think','struct'], 8.5, 35.5],
  ['gemini-flash-15','gemini',   'gemini-1.5-flash',       'Gemini 1.5 Flash', 1048576,  8192,  ['vision','tools','struct'], 0.5,   2.1],
  ['deepseek-chat', 'deepseek',  'deepseek-chat',          'DeepSeek Chat V3', 65536,    8192,  ['tools','struct'],          2,     8],
  ['deepseek-r1',   'deepseek',  'deepseek-reasoner',      'DeepSeek R1 推理', 65536,    8192,  ['think','tools'],           3,     16],
  ['qwen-plus',     'qwen',      'qwen-plus',              'Qwen Plus',        131072,   8192,  ['tools','struct'],          0.8,   2],
  ['qwen-turbo',    'qwen',      'qwen-turbo',             'Qwen Turbo',       131072,   8192,  ['tools','struct'],          0.3,   0.6],
  ['qwen-max',      'qwen',      'qwen-max',               'Qwen Max',         32768,    8192,  ['tools','struct'],          20,    60],
  ['qwen-vl',       'qwen',      'qwen-vl-plus',           'Qwen VL 视觉',     32768,    8192,  ['vision','tools'],          8,     8],
  ['glm-plus',      'zhipu',     'glm-4-plus',              'GLM-4 Plus',       128000,   4096,  ['tools','struct'],          50,    50],
  ['glm-flash',     'zhipu',     'glm-4-flash',             'GLM-4 Flash',      128000,   4096,  ['tools','struct'],          0.1,   0.1],
  ['glm4v',         'zhipu',     'glm-4v-plus',            'GLM-4V 视觉',      8192,     4096,  ['vision'],                  50,    50],
  ['doubao-pro',    'doubao',    'doubao-pro-32k',         '豆包 Pro 32K',     32768,    4096,  ['tools','struct'],          5,     15],
  ['doubao-lite',   'doubao',    'doubao-lite-32k',        '豆包 Lite 32K',    32768,    4096,  ['tools','struct'],          0.3,   0.6],
  ['kimi-8k',       'kimi',      'moonshot-v1-8k',         'Kimi 8K',          8192,     4096,  [],                          12,    12],
  ['kimi-32k',      'kimi',      'moonshot-v1-32k',        'Kimi 32K',         32768,    4096,  [],                          24,    24],
  ['kimi-128k',     'kimi',      'moonshot-v1-128k',       'Kimi 128K',        131072,   4096,  [],                          60,    60],
];

const round = (n) => Math.round(n);
const toMicro = (yuan) => round(yuan * 1e6);

function capabilitiesFor(provider, flags, ctx, out) {
  const vision = flags.includes('vision');
  const imageInputFormats =
    provider === 'anthropic' ? ['base64']
    : provider === 'gemini'   ? ['base64']
    : ['url'];
  const toolCallFormat =
    provider === 'anthropic' ? 'anthropic'
    : provider === 'gemini'   ? 'gemini'
    : 'openai';
  return {
    supportsStreaming: true,
    supportsTools: flags.includes('tools'),
    supportsVision: vision,
    supportsSystemPrompt: true,
    supportsThinking: flags.includes('think'),
    supportsStructuredOutput: flags.includes('struct'),
    contextWindow: ctx,
    maxOutputTokens: out,
    imageInputFormats,
    toolCallFormat,
    inputModalities: vision ? ['text', 'image'] : ['text'],
    outputModalities: ['text'],
  };
}

async function seed() {
  await withTransaction(async (client) => {
    // 1) providers
    for (const p of PROVIDERS) {
      await client.query(
        `INSERT INTO providers(id, slug, name, default_base_url, kind, enabled)
         VALUES($1,$2,$3,$4,$5,true)
         ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name, default_base_url=EXCLUDED.default_base_url, kind=EXCLUDED.kind`,
        [`prv_${p.slug}`, p.slug, p.name, p.base, p.kind]
      );
    }

    // provider slug -> id
    const provRows = await client.query('SELECT id, slug FROM providers');
    const provId = Object.fromEntries(provRows.rows.map((r) => [r.slug, r.id]));

    // 2) models + capabilities + pricing
    for (const [id, provider, slug, name, ctx, out, flags, inYuan, outYuan] of MODELS) {
      await client.query(
        `INSERT INTO models(id, provider_id, slug, display_name, is_default)
         VALUES($1,$2,$3,$4,$5)
         ON CONFLICT (id) DO UPDATE SET provider_id=EXCLUDED.provider_id, slug=EXCLUDED.slug,
            display_name=EXCLUDED.display_name, is_default=EXCLUDED.is_default`,
        [`mdl_${id}`, provId[provider], slug, name, id === 'gpt-4o-mini']
      );
      await client.query(
        `INSERT INTO model_capabilities(id, model_id, capabilities)
         VALUES($1,$2,$3::jsonb)
         ON CONFLICT (model_id) DO UPDATE SET capabilities=EXCLUDED.capabilities`,
        [`cap_${id}`, `mdl_${id}`, JSON.stringify(capabilitiesFor(provider, flags, ctx, out))]
      );
      await client.query(
        `INSERT INTO pricing_versions(id, provider, model, effective_from, effective_to,
            input_price_micro_per_mtok, output_price_micro_per_mtok, currency)
         VALUES($1,$2,$3,to_timestamp(0),NULL,$4,$5,'CNY')
         ON CONFLICT (provider, model) WHERE effective_to IS NULL DO UPDATE SET
            input_price_micro_per_mtok=EXCLUDED.input_price_micro_per_mtok,
            output_price_micro_per_mtok=EXCLUDED.output_price_micro_per_mtok`,
        [`pv_${id}`, provider, slug, toMicro(inYuan), toMicro(outYuan)]
      );
    }
  });

  const counts = await query(`
    SELECT
      (SELECT count(*) FROM providers)::int AS providers,
      (SELECT count(*) FROM models)::int AS models,
      (SELECT count(*) FROM model_capabilities)::int AS caps,
      (SELECT count(*) FROM pricing_versions)::int AS prices
  `);
  const c = counts.rows[0];
  console.log(`[seed] 完成：providers=${c.providers} models=${c.models} model_capabilities=${c.caps} pricing_versions=${c.prices}`);
  return c;
}

if (require.main === module) {
  seed()
    .then(() => endPool())
    .catch(async (e) => {
      console.error('[seed] 失败:', e.message);
      await endPool().catch(() => {});
      process.exit(1);
    });
}

module.exports = { seed };
