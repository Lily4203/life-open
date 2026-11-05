#!/usr/bin/env node
/* 行动端口 · MCP 这一侧
 * ============================================================
 * 它做的事只有一件：把「请她做一个动作」翻译成一次 HTTP 调用。
 *
 * 为什么要单独一个进程、走 MCP：
 *   DSH（以及任何支持 MCP 的宿主）不需要知道 SSE、不需要知道页面里有个注册表，
 *   它只要看见几个工具。**适配的代价应该是"加一个文件"，不是"改它的核心"。**
 *
 * 它**不**替她想。
 *   这里没有提示词、没有判断"该不该关灯"、没有默认动作。
 *   外面（DSH 里的 agent）决定做什么，这里只负责送到，再把她的返回值原样带回——
 *   包括失败。把 failed 说成 ok，就是在替她圆谎。
 *
 * 用法（stdio，宿主自己会拉起）：
 *   node mcp/server.mjs
 * 环境变量：
 *   LIFE_URL  她住的那个服务，默认 http://127.0.0.1:8765
 *
 * 手测：
 *   echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node mcp/server.mjs
 */
import process from 'node:process';

const BASE = (process.env.LIFE_URL || 'http://127.0.0.1:8765').replace(/\/+$/, '');
const VERSION = '0.1.0';

/* stdout 是协议通道：任何一行多余的输出都会让宿主读不懂。
 * 所以这里所有诊断一律走 stderr。 */
const log = (...a) => process.stderr.write('[life-mcp] ' + a.join(' ') + '\n');

/* ---------------- 和屋子说话 ---------------- */
async function http(path, { method = 'GET', body = null, timeoutMs = 25000 } = {}) {
  const r = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 不是 JSON 就原样带回去 */ }
  return { status: r.status, json, text };
}

/** 派一个动作，超时比服务端多给 5 秒：让服务端先报超时，我们拿到的是它的原话。 */
async function act(name, args = {}, timeoutMs = 20000) {
  try {
    const r = await http('/api/act', { method: 'POST', timeoutMs: timeoutMs + 5000,
      body: { name, args, timeoutMs } });
    if (r.json) return r.json;
    return { ok: false, reason: 'bad_response', message: r.text.slice(0, 200) };
  } catch (e) {
    /* 连不上 = 她没在家。这不是"动作失败"，是"没人能动手"，要分开说。 */
    return {
      ok: false, reason: 'unreachable',
      message: `连不上 ${BASE}。她住的那个服务没开：node tools/serve.mjs`,
      detail: String(e.message || e),
    };
  }
}

/* ---------------- 工具 ---------------- */
/* 描述写得像"给人看的说明书"，不是给机器看的枚举：
 * 宿主里的模型只有这几行字可以依靠，写含糊了它就会乱调。 */
const TOOLS = [
  {
    name: 'life_state',
    description: '读她现在什么样：姿势、站在哪、手边是什么、哪盏灯亮着、正在放哪个动作。'
      + '只读，不改变任何东西。派动作之前先看这个——她的位置和灯的状态会变。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'life_actions',
    description: '列出这个房间里她现在能做的动作（名字、参数、说明）。'
      + '名字会随屋子变（换了房间、拔了衣柜，就不一样），所以别把动作名写死在上游。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'life_act',
    description: '请她做一个动作，等结果。失败会如实返回 failed/partial，不会自动重试。'
      + '动作只认注册表里的名字，参数也照注册表——比如 go_to 的 target 是实体（种类名 bed，'
      + '或 bed:1 这种带序号的 id），不接受坐标。写错参数会回 missing_arg，照它说的字段改。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '动作名，先查 life_actions，别凭印象写' },
        args: { type: 'object', description: '动作参数，照 life_actions 给的 schema', additionalProperties: true },
        timeoutMs: { type: 'number', description: '最多等多久（毫秒），默认 20000，上限 120000' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'life_hear',
    description: '往她耳朵里放一句话：像是群里有人说了句话。她**可以不理**——'
      + '回不回由她决定，这个调用不代表她一定会开口。'
      + '想让她一定回应，用 life_speak；想让她动手，用 life_act。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '那句话' },
        from: { type: 'string', description: '谁说的：him（他本人）/ guest:QQ号 之类，默认 dsh' },
        name: { type: 'string', description: '说话人的显示名' },
        source: { type: 'string', description: '从哪来的：group / private / danmaku / dsh，默认 dsh' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'life_speak',
    description: '让她说一句话（走她的嘴和声音，不只是字幕）。'
      + '这是"替她开口"，不是"她自己想说"——她的风格和记忆不会参与，慎用。',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: '要说的话' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
];

const text = t => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) }] });
const fail = t => ({ ...text(t), isError: true });

async function callTool(name, args = {}) {
  if (name === 'life_state') {
    const r = await act('__state', {}, 8000);
    if (r.reason === 'unreachable') return fail(r.message);
    return text(r);
  }
  if (name === 'life_actions') {
    const r = await act('__actions', {}, 8000);
    if (r.reason === 'unreachable') return fail(r.message);
    return text(r);
  }
  if (name === 'life_act') {
    const n = String(args.name || '').trim();
    if (!n) return fail('缺 name：要做什么动作？先用 life_actions 看有哪些。');
    const r = await act(n, args.args || {}, Number(args.timeoutMs) || 20000);
    /* 动作失败**不算工具失败**：failed 是一个正常结果，宿主里的模型应该看见它、
     * 然后自己决定怎么办（换一个动作、还是算了）。只有"根本没法问"才 isError。 */
    if (r.reason === 'unreachable') return fail(r.message);
    return text(r);
  }
  if (name === 'life_hear') {
    const t = String(args.text || '').trim();
    if (!t) return fail('缺 text');
    try {
      const r = await http('/api/in', {
        method: 'POST', timeoutMs: 8000,
        body: {
          text: t.slice(0, 500),
          from: String(args.from || 'dsh').slice(0, 40),
          name: String(args.name || '').slice(0, 24),
          source: String(args.source || 'dsh').slice(0, 16),
        },
      });
      return text(r.json || { ok: false, message: r.text.slice(0, 200) });
    } catch (e) {
      return fail(`连不上 ${BASE}：${e.message}`);
    }
  }
  if (name === 'life_speak') {
    const t = String(args.text || '').trim();
    if (!t) return fail('缺 text');
    const r = await act('__speak', { text: t }, 15000);
    if (r.reason === 'unreachable') return fail(r.message);
    return text(r);
  }
  return fail(`没有这个工具：${name}`);
}

/* ---------------- MCP：一行一条 JSON ---------------- */
function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
function replyErr(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

let buf = '';
process.stdin.setEncoding('utf8');

async function handle(msg) {
  const { id, method, params } = msg;
  /* 通知没有 id，不回。回一条空的会让宿主以为我们答错了请求。 */
  const isNotice = id === undefined || id === null;

  switch (method) {
    case 'initialize':
      return reply(id, {
        /* 回显宿主提议的版本：它比我们新就用它的，它比我们旧就用我们支持的最老的。
         * 硬写一个版本号，遇到更新的宿主会直接被判定不兼容。 */
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'life', version: VERSION },
      });
    case 'notifications/initialized':
    case 'initialized':
      return;                                  // 通知，不回
    case 'ping':
      return isNotice ? undefined : reply(id, {});
    case 'tools/list':
      return reply(id, { tools: TOOLS });
    case 'tools/call':
      try {
        const out = await callTool(params?.name, params?.arguments || {});
        return reply(id, out);
      } catch (e) {
        log('tools/call 抛了：', e.stack || e.message);
        return reply(id, fail(String(e.message || e)));
      }
    case 'resources/list':
      return reply(id, { resources: [] });
    case 'prompts/list':
      return reply(id, { prompts: [] });
    default:
      if (isNotice) return;
      return replyErr(id, -32601, `不支持的方法：${method}`);
  }
}

process.stdin.on('data', chunk => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (e) {
      /* 回 -32700：宿主发错了，我们要让它知道我们没读懂，而不是静默吞掉。 */
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null,
        error: { code: -32700, message: 'parse error: ' + e.message } }) + '\n');
      continue;
    }
    Promise.resolve(handle(msg)).catch(e => log('处理失败：', e.stack || e.message));
  }
});

process.stdin.on('end', () => process.exit(0));
log(`起来了，屋子在 ${BASE}`);
