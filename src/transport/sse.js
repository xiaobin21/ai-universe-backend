'use strict';

/**
 * SSE 流式读取（契约 §3.2）。
 *  - 按 \n 拆行（去 \r），空行分隔事件
 *  - 识别 `event:` 与 `data:`；注释行（以 `:` 开头）忽略
 *  - onLine 给每一行原始内容（适配 OpenAI 裸 `data: {...}` / `[DONE]` 这类解析）
 *  - onEvent 在空行 flush 时回调 (eventName, data)，eventName 默认 'message'
 *  - 连接中断 / 外部 abort 抛 AppError('network'/'cancel')
 */

const { AppError } = require('../core/errors');

/**
 * @param {ReadableStream|AsyncIterable<Buffer|string>} stream
 * @param {{onLine?:(line:string)=>void, onEvent?:(event:string,data:string)=>void, signal?:AbortSignal}} handlers
 */
async function pumpSSE(stream, { onLine, onEvent, signal } = {}) {
  let buf = '';
  let curEvent = 'message';
  const curData = [];

  const flush = () => {
    if (curData.length === 0) { curEvent = 'message'; return; }
    const data = curData.join('\n');
    curData.length = 0;
    const ev = curEvent;
    curEvent = 'message';
    if (onEvent) onEvent(ev, data);
  };

  for await (const chunk of stream) {
    if (signal && signal.aborted) {
      throw new AppError('cancel', 'SSE 流已被取消');
    }
    // 兼容 Node Buffer、web ReadableStream 的 Uint8Array、以及字符串
    let piece;
    if (Buffer.isBuffer(chunk)) piece = chunk.toString('utf8');
    else if (chunk instanceof Uint8Array) piece = Buffer.from(chunk).toString('utf8');
    else piece = String(chunk);
    buf += piece;

    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      let line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);

      if (line === '') { flush(); continue; }
      if (line.startsWith(':')) continue; // 注释/心跳

      if (onLine) onLine(line);

      if (line.startsWith('event:')) {
        curEvent = line.slice(6).trim() || 'message';
      } else if (line.startsWith('data:')) {
        curData.push(line.slice(5).replace(/^ /, ''));
      }
      // 其他字段（id:/retry:）本项目暂不关心
    }
  }
  // 收尾：尾部无空行 flush
  if (buf.length) {
    const line = buf.endsWith('\r') ? buf.slice(0, -1) : buf;
    if (onLine) onLine(line);
    if (line.startsWith('data:')) curData.push(line.slice(5).replace(/^ /, ''));
    flush();
  }
}

module.exports = { pumpSSE };
