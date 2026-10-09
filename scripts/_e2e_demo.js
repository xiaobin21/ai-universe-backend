'use strict';

// 端到端演示（对已运行的真实服务，无供应商 Key → 服务端 demo 流式）。
const BASE = process.env.BASE_URL || 'http://127.0.0.1:34385';

async function parseSse(response) {
  const events = [];
  let buf = '';
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    buf += decoder.decode(r.value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, idx); buf = buf.slice(idx + 2);
      let name = 'message'; const data = [];
      for (let line of raw.split('\n')) {
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line.startsWith('event:')) name = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      let json = null; try { json = JSON.parse(data.join('\n')); } catch (e) {}
      events.push({ name, json });
    }
  }
  return events;
}

(async () => {
  const email = `demo-${Date.now()}@example.com`;
  const password = 'Passw0rd!2026';

  // 1) 注册
  let res = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  let reg = await res.json();
  const token = reg.accessToken || (reg.user && reg.user.accessToken);
  console.log('1) 注册:', res.status, '拿到token:', Boolean(token));
  const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  // 从 catalog 解析模型真实 id（mdl_ 前缀），按供应商原生 slug 找 gpt-4o-mini
  const cat = await (await fetch(`${BASE}/api/catalog`, { headers: auth })).json();
  const target = cat.models.find((m) => m.slug === 'gpt-4o-mini') || cat.models[0];
  console.log('   catalog 模型数:', cat.models.length, '| 选定:', target.id, target.slug);

  // 2) 建会话
  res = await fetch(`${BASE}/api/conversations`, {
    method: 'POST', headers: auth, body: JSON.stringify({ modelId: target.id }),
  });
  let c = await res.json();
  const conv = c.conversation || c;
  console.log('2) 建会话:', res.status, 'id=', conv.id, 'model=', conv.modelId);

  // 3) 发消息（SSE，带幂等键）
  const idem = crypto.randomUUID();
  res = await fetch(`${BASE}/api/conversations/${conv.id}/messages`, {
    method: 'POST',
    headers: { ...auth, 'Idempotency-Key': idem },
    body: JSON.stringify({ text: '你好，请用三句话介绍你自己。' }),
  });
  console.log('3) 发消息 HTTP', res.status, 'content-type=', res.headers.get('content-type'));
  const events = await parseSse(res);
  const byName = {};
  let text = ''; let reasoning = '';
  for (const e of events) {
    byName[e.name] = (byName[e.name] || 0) + 1;
    if (e.name === 'delta' && e.json) {
      if (e.json.kind === 'text') text += e.json.text;
      if (e.json.kind === 'reasoning') reasoning += e.json.text;
    }
  }
  console.log('   SSE事件计数:', JSON.stringify(byName));
  console.log('   正文长度:', text.length, '| 思考链长度:', reasoning.length);
  console.log('   正文预览:', text.replace(/\s+/g, ' ').slice(0, 90));

  // 4) 重新拉取历史，验证落库
  res = await fetch(`${BASE}/api/conversations/${conv.id}`, { headers: auth });
  const full = await res.json();
  const msgs = full.messages || (full.conversation && full.messages) || [];
  const asst = msgs.filter((m) => m.role === 'assistant');
  const lastAsst = asst[asst.length - 1];
  const partTypes = lastAsst ? lastAsst.parts.map((p) => p.type) : [];
  console.log('4) 历史消息数:', msgs.length, '| 末条assistant状态:', lastAsst && lastAsst.status, '| parts类型:', JSON.stringify(partTypes));

  // 5) 幂等：同 key 再发，不应产生第二个 assistant
  res = await fetch(`${BASE}/api/conversations/${conv.id}/messages`, {
    method: 'POST',
    headers: { ...auth, 'Idempotency-Key': idem },
    body: JSON.stringify({ text: '你好，请用三句话介绍你自己。' }),
  });
  const ev2 = await parseSse(res);
  res = await fetch(`${BASE}/api/conversations/${conv.id}`, { headers: auth });
  const full2 = await res.json();
  const msgs2 = full2.messages || [];
  console.log('5) 幂等重发: assistant数=', msgs2.filter((m) => m.role === 'assistant').length,
    '(应为1) | 复用事件数=', ev2.length);

  // 6) 用量汇总
  res = await fetch(`${BASE}/api/usage/summary`, { headers: auth });
  const usage = await res.json();
  console.log('6) 用量汇总:', JSON.stringify(usage).slice(0, 200));

  const ok = text.length > 0 && lastAsst && lastAsst.status === 'completed'
    && msgs2.filter((m) => m.role === 'assistant').length === 1;
  console.log(ok ? '\nE2E_RESULT PASS' : '\nE2E_RESULT FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('E2E_ERROR', e); process.exit(1); });
