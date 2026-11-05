/* SSE 分帧：把网络上来的一堆字节，变成一条一条 {event, data, id}
 * ------------------------------------------------------------
 * 为什么要有这个文件，而不是在 serve 和页面里各写一个 split('\n\n')：
 *
 *   一次 read() 拿到的东西，既不等于一个字符，也不等于一行，更不等于一条消息。
 *   它可能只有一个汉字的第一个字节，也可能是两条半消息粘在一起。
 *   这两件事（拆包、粘包）是网络的常态，不是异常。手写 split 一定会在这两处丢数据，
 *   而且丢得不明显——表现是"她偶尔少说半句"，查一天也查不出来。
 *
 * 结构照抄 eventsource-parser（Node/浏览器通用的那个分帧器）和 WHATWG 的
 * text/event-stream 规则，没有自己发明：
 *   1. 字节层：TextDecoder 带 {stream:true}，跨 chunk 的多字节字符由它自己攒。
 *      —— 不加这个参数，中文被切断就变 "�"。英文教程里几乎都没写，因为英文是单字节。
 *   2. 行层：\r\n、\r、\n 三种换行都当换行（规范要求，Windows 上的服务端会发 CRLF）。
 *   3. 帧层：多条 `data:` 行用 \n 连成一条（不是覆盖）；**空行**才提交一条消息。
 *   4. 注释行（`:` 开头，心跳用）直接丢掉——它不该打断正在攒的那条消息。
 *   5. `data:` 后面只去掉**一个**前导空格（规范写死了"exactly one"），不是 trim。
 *
 * 它不认识 DeepSeek，也不认识 [DONE]：厂商语义留给调用方（第四层）。
 * 这样换模型时只改上层，分帧器不用动。
 */

/** 一条消息攒够了 */
function dispatch(state, onEvent) {
  if (!state.data.length) {
    state.event = null; state.id = undefined;
    return;
  }
  const data = state.data.join('\n');
  const ev = { event: state.event || 'message', data, id: state.id };
  state.data = []; state.event = null; state.id = undefined;
  try { onEvent(ev); } catch { /* 上层炸了不该把解析器带崩 */ }
}

/** 处理一整行（不含换行符） */
function line(state, onEvent, raw) {
  const l = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
  if (l === '') return dispatch(state, onEvent);          // 空行 = 一条消息结束
  if (l[0] === ':') return;                                // 注释/心跳，忽略
  const i = l.indexOf(':');
  const field = i < 0 ? l : l.slice(0, i);
  let value = i < 0 ? '' : l.slice(i + 1);
  if (value[0] === ' ') value = value.slice(1);            // 只去一个，规范写死的
  if (field === 'data') state.data.push(value);
  else if (field === 'event') state.event = value;
  else if (field === 'id') state.id = value;
  // retry 等其它字段我们不用，也不报错——不认识就放着，这不叫宽容，叫规范
}

/**
 * 文本分帧器。输入是**已经解码好的字符串片段**（可以是半条消息）。
 * 返回 { push(text), end(), state }
 */
export function createSseParser({ onEvent = () => {} } = {}) {
  const state = { data: [], event: null, id: undefined };
  let buf = '';
  let closed = false;

  function push(text) {
    buf += String(text ?? '');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i);
      buf = buf.slice(i + 1);
      line(state, onEvent, l);
    }
  }

  /** 收尾：把没有换行结尾的最后一行也处理掉，剩下的半条消息按宽松策略提交。 */
  function end() {
    if (closed) return { ok: false, reason: 'already' };
    closed = true;
    if (buf) { line(state, onEvent, buf); buf = ''; }
    // 最后一帧后面没有空行是常见的（服务端直接 close），不能因此把最后一帧丢了
    if (state.data.length) dispatch(state, onEvent);
    return { ok: true };
  }

  return {
    push, end,
    get pending() { return buf.length; },
    get broken() { return !closed && buf.length > 1e6; },   // 一直等不到换行，多半是上游坏了
  };
}

/**
 * 字节→文本→帧。浏览器和 Node 都能用（TextDecoder 两边都有）。
 * 返回 { push(uint8), end() }
 *
 * 注意 end() 会把 decoder 里残留的半个字符冲出来再收尾——
 * 少这一步，最后那个字可能永远不出来（流的结尾恰好切断一个汉字时）。
 */
export function createSseDecoder({ onEvent = () => {}, onText = null } = {}) {
  if (typeof TextDecoder !== 'function') throw new Error('这个环境没有 TextDecoder');
  const dec = new TextDecoder('utf-8');
  const parser = createSseParser({
    onEvent,
  });

  function push(chunk) {
    const text = typeof chunk === 'string' ? chunk : dec.decode(chunk, { stream: true });
    if (onText) { try { onText(text); } catch { /* 旁路不影响主路 */ } }
    parser.push(text);
  }

  function end() {
    const tail = dec.decode();     // 不带 stream：强制 flush，把残留字节吐出来
    if (tail) { if (onText) { try { onText(tail); } catch { /* 同上 */ } } parser.push(tail); }
    return parser.end();
  }

  return { push, end, get pending() { return parser.pending; } };
}
