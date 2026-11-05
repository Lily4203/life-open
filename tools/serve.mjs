/* 本地一条龙服务：静态文件 + 模型代理 + 记忆落盘
 * ------------------------------------------------------------
 * 为什么要它：浏览器不能直接调 DeepSeek（密钥会露），也不该把记忆放 localStorage
 * （换个浏览器就等于换了一个人）。所以三件事收到一个进程里：
 *
 *   GET  /            静态文件（就是 life/ 这一层，和以前 8765 一样）
 *   POST /api/chat    {system, messages} → {say 的原文, usage, ms}
 *                     加 stream:true 则改回 SSE（`data: {"d":"…"}` 逐帧，最后一帧 done）
 *   GET  /api/store/<name>          读记忆文件
 *   POST /api/store/<name>[?append=1]  写/追加
 *   POST /api/tts     {text} → audio/wav（本机离线语音；没有引擎就 503 并说清为什么）
 *   GET  /api/tts/health  哪个引擎装好了
 *   POST /api/model?name=<slug>  导入一个 .vrm（原始字节）→ 落盘 + 登记到 characters.json
 *   POST /api/in      外面的一句话进来（弹幕/群聊/别的程序）→ 广播给页面
 *   GET  /api/in/stream  页面订阅（SSE，一条一行）
 *   POST /api/alive   页面心跳（看门狗靠它判断"页面还活着"）
 *   GET  /api/health  密钥在不在、数据在哪、页面还活着吗
 *
 * 只监听 127.0.0.1。密钥从 keys.json 或 ~/.dsh/.credentials.yaml 读，绝不下发到浏览器。
 *
 * 跑：node tools/serve.mjs      然后开 http://127.0.0.1:8765/预览-66.html
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { requestJSON, requestStream } from './net-http.mjs';
import { synthAsync, probeEngines, prune, warmUp, daemonInfo, daemonIdleKill, edgeCooldown, MAX_CHARS } from './tts.mjs';
import { PERSONA, MOOD_NAMES } from './voice-profile.mjs';
import { describe, pickProvider, MAX_BYTES as SEE_MAX_BYTES, PROVIDERS } from './vision.mjs';
import { createAdapters } from './adapters.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const DATA = path.join(ROOT, 'data');
const LOGS = path.join(ROOT, 'logs');
const PORT = Number(process.env.PORT || 8765);
const MODEL = process.env.MODEL || 'deepseek-chat';

fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(LOGS, { recursive: true });

/* ---------------- 密钥：三处兜底，只报有没有 ---------------- */
function findKey() {
  if (process.env.DEEPSEEK_API_KEY) return { key: process.env.DEEPSEEK_API_KEY.trim(), from: '环境变量' };
  try {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'keys.json'), 'utf8'));
    if (j.DEEPSEEK_API_KEY) return { key: String(j.DEEPSEEK_API_KEY).trim(), from: 'keys.json' };
  } catch { /* 没有就算了 */ }
  try {
    const lines = fs.readFileSync(path.join(os.homedir(), '.dsh', '.credentials.yaml'), 'utf8').split('\n');
    for (const l of lines) {
      if (l.includes('DEEPSEEK_API_KEY') && l.includes(':')) {
        const v = l.split(':').slice(1).join(':').trim().replace(/^["']|["']$/g, '');
        if (v) return { key: v, from: '~/.dsh/.credentials.yaml' };
      }
    }
  } catch { /* 同上 */ }
  return { key: null, from: null };
}
const CRED = findKey();

/* 看图要的密钥是**另一组**（智谱/通义/Gemini），和聊天不是同一个。
 * 这里只读键名，不校验格式：填错了让上游返回 401，比我们猜"这像不像 key"可靠。 */
function readKeys() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'keys.json'), 'utf8'));
    const out = {};
    for (const p of Object.values(PROVIDERS)) {
      const v = String(j[p.keyName] || '').trim();
      if (v && !v.startsWith('_')) out[p.keyName] = v;
    }
    return out;
  } catch { return {}; }
}
const KEYS = readKeys();

/* ---------------- 外面的话：一个广播口 ----------------
 * 为什么服务端要管这件事：弹幕适配器、群聊机器人、别的脚本，都不该直接碰页面。
 * 它们只往这里 POST 一行；页面用 SSE 订阅。
 *
 * 为什么用 SSE 不用轮询：轮询是一个定时器，而且"这一秒没有消息"和"这一秒的消息丢了"
 * 分不清。SSE 是"有就推"，断了浏览器自己重连，形态和"话到了"这件事对得上。
 *
 * 没有页面在听的时候消息不丢：排队 50 条，页面一连上就补发。
 * 再多的就丢，并且计数——丢了多少要能看见，不许静默。
 */
const IN = { clients: new Set(), queue: [], got: 0, dropped: 0, maxQueue: 50 };

function pushIn(msg) {
  IN.got += 1;
  const line = 'data: ' + JSON.stringify(msg) + '\n\n';
  if (!IN.clients.size) {
    IN.queue.push(line);
    if (IN.queue.length > IN.maxQueue) { IN.queue.shift(); IN.dropped += 1; }
    return { ok: true, delivered: 0, queued: IN.queue.length, dropped: IN.dropped };
  }
  for (const res of IN.clients) {
    try { res.write(line); } catch { IN.clients.delete(res); }
  }
  return { ok: true, delivered: IN.clients.size, queued: 0 };
}

/* ---------------- 外线插槽：adapters/ 下放一个文件就接上一条线 ----------------
 * 机制在 tools/adapters.mjs，契约也在那儿（和 adapters/README.md）。
 * 这里只做两件事：告诉它消息往 pushIn 送；启动时扫一遍。
 *
 * 为什么是扫目录，不是写一串 import：
 *   写死 import 就等于"加一条线要改服务端代码"，那第三个人永远加不进来。
 *   扫目录 = 谁的线谁自己带走，删文件就是拔线。 */
const AD = createAdapters({
  dir: path.join(ROOT, 'adapters'),
  send: pushIn,
  log: m => console.log('[adapters] ' + m),
});

function handleIn(req, res) {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', c => { body += c; if (body.length > 64e3) req.destroy(); });
  req.on('end', () => {
    let q;
    try { q = JSON.parse(body || '{}'); } catch { return send(res, 400, JSON.stringify({ ok: false, error: 'body 不是 JSON' })); }
    const text = String(q.text ?? '').trim();
    if (!text) return send(res, 400, JSON.stringify({ ok: false, error: '没有 text' }));
    /* 这一层不判断"她要不要回"，只把话送到。判断在页面那侧（chat-in → 大模型）。 */
    const r = pushIn({
      text: text.slice(0, 500),
      from: String(q.from ?? 'script').slice(0, 40),
      name: String(q.name ?? '').slice(0, 24),
      source: String(q.source ?? 'script').slice(0, 16),
      at: Date.now(),
    });
    send(res, 200, JSON.stringify(r));
  });
}

function handleInStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  IN.clients.add(res);
  // 补发：没有页面在听的时候进来的话，现在给它
  while (IN.queue.length) { try { res.write(IN.queue.shift()); } catch { break; } }
  /* 心跳注释行：中间的代理/浏览器会把长时间没数据的连接掐掉，
   * 这一行不是消息，只是"这条线还通着"。 */
  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* 断了就算了 */ } }, 20e3);
  const bye = () => { clearInterval(hb); IN.clients.delete(res); };
  req.on('close', bye);
  res.on('close', bye);
  res.on('error', bye);
}

/* ---------------- 行动端口：外面也能让她动 ----------------
 * 为什么要开这个口：
 *   她本来只有一条路——自己想动，大脑产出 do，页面执行。外面（DSH、脚本、别的 agent）
 *   想说"走过去把灯关了"，以前只能发一句话给她**听**，再等她愿意。
 *   这个口把"决定"和"动手"分开：外面可以只动手，成败如实回来；
 *   但动作本身**仍然过注册表**——窗口、归属、失败不冒泡，还是执行层那一套。
 *
 * 为什么不让调用方直接连页面：
 *   那等于每个调用方都要懂 SSE、都要处理"页面没开"。收在服务端，
 *   调用方只要一个 POST，就能拿到一个和"她自己动手"一样的返回值。
 *
 * 没有页面在听时**不排队**：消息可以等（她醒了会看），动作不能等——
 *   三分钟后再走过去关灯，灯早就不是那个状态了。直接回 no_page。
 */
const ACT = { clients: new Set(), pending: new Map(), seq: 0, got: 0, done: 0, timedOut: 0, noPage: 0 };

function handleActStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': act connected\n\n');
  ACT.clients.add(res);
  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* 断了就算了 */ } }, 20e3);
  const bye = () => { clearInterval(hb); ACT.clients.delete(res); };
  req.on('close', bye);
  res.on('close', bye);
  res.on('error', bye);
}

function handleAct(req, res) {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', c => { body += c; if (body.length > 16e3) req.destroy(); });
  req.on('end', () => {
    let q;
    try { q = JSON.parse(body || '{}'); } catch { return send(res, 400, JSON.stringify({ ok: false, error: 'body 不是 JSON' })); }
    const name = String(q.name ?? '').trim();
    if (!name) return send(res, 400, JSON.stringify({ ok: false, reason: 'no_name' }));
    ACT.got += 1;
    if (!ACT.clients.size) {
      ACT.noPage += 1;
      return send(res, 503, JSON.stringify({ ok: false, reason: 'no_page', error: '页面没开，没有人能动手' }));
    }
    const id = `a${++ACT.seq}`;
    const timeoutMs = Math.min(Math.max(Number(q.timeoutMs) || 20e3, 1e3), 120e3);
    const timer = setTimeout(() => {
      if (!ACT.pending.delete(id)) return;
      ACT.timedOut += 1;
      send(res, 504, JSON.stringify({ ok: false, reason: 'timeout', id, name, timeoutMs }));
    }, timeoutMs);
    ACT.pending.set(id, { res, timer, at: Date.now(), name });
    const line = 'data: ' + JSON.stringify({ type: 'act', id, name, args: q.args ?? {}, timeoutMs }) + '\n\n';
    for (const c of ACT.clients) { try { c.write(line); } catch { ACT.clients.delete(c); } }
  });
}

function handleActResult(req, res) {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', c => { body += c; if (body.length > 64e3) req.destroy(); });
  req.on('end', () => {
    let q;
    try { q = JSON.parse(body || '{}'); } catch { return send(res, 400, JSON.stringify({ ok: false, error: 'body 不是 JSON' })); }
    const item = ACT.pending.get(q.id);
    /* 超时之后才回来的结果：收下，但没人等了。不报错——
     * 页面没做错事，它只是慢。记一笔，让 health 里看得见。 */
    if (!item) { ACT.timedOut += 1; return send(res, 200, JSON.stringify({ ok: true, late: true })); }
    clearTimeout(item.timer);
    ACT.pending.delete(q.id);
    ACT.done += 1;
    send(item.res, 200, JSON.stringify(q.result ?? { ok: false, reason: 'empty' }));
    send(res, 200, JSON.stringify({ ok: true }));
  });
}

/* ---------------- 看门狗：页面还活着吗 ----------------
 * 页面每 30 秒来一次。超过 90 秒没来，health 里就报 stalled，
 * 桌面壳看到就重载——这是"跑一晚上不能停在'她在想…'"那条的唯一实现。
 * 服务端**不主动重载**：它不知道页面为什么停（可能只是电脑睡眠），
 * 决定重载的是壳（它手里有 BrowserWindow），服务端只负责说"我多久没听见了"。
 */
/* ALIVE_STALL_MS 只给测试用：真跑用 90 秒（页面 30 秒一次，漏两次才算死）。 */
const ALIVE = { at: 0, ua: '', hits: 0, stalledMs: Number(process.env.ALIVE_STALL_MS) || 90e3 };

function markAlive(req) {
  ALIVE.at = Date.now();
  ALIVE.ua = String(req.headers['user-agent'] || '').slice(0, 120);
  ALIVE.hits += 1;
  return ALIVE.at;
}
const aliveInfo = () => ({
  lastAt: ALIVE.at || null,
  ageMs: ALIVE.at ? Date.now() - ALIVE.at : null,
  stalled: Boolean(ALIVE.at && Date.now() - ALIVE.at > ALIVE.stalledMs),
  hits: ALIVE.hits,
  stalledMs: ALIVE.stalledMs,
});

/* ---------------- 日志轮转 ----------------
 * 两样会一直长：chat-*.jsonl（按天，不删）和 data/tts/*.wav（缓存，不清）。
 * 只做两件最便宜的事：按天删旧聊天日志、按天数+条数清合成缓存。
 * **事件流不删**：她的记忆不归运维脚本管（见 契约 2.4 与 差距 ④）。
 */
function pruneLogs({ keepDays = 30 } = {}) {
  const out = { removed: 0, kept: 0 };
  let names;
  try { names = fs.readdirSync(LOGS); } catch { return out; }
  const oldest = Date.now() - keepDays * 86400e3;
  for (const n of names) {
    if (!/^chat-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)) continue;
    const p = path.join(LOGS, n);
    let st; try { st = fs.statSync(p); } catch { continue; }
    if (st.mtimeMs < oldest) { try { fs.unlinkSync(p); out.removed += 1; } catch { /* 删不掉留着 */ } }
    else out.kept += 1;
  }
  return out;
}


/* ---------------- 静态 ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.wasm': 'application/wasm',
  '.vrm': 'application/octet-stream', '.glb': 'model/gltf-binary', '.bin': 'application/octet-stream',
  '.moc3': 'application/octet-stream', '.wav': 'audio/wav', '.mp3': 'audio/mpeg',
  '.ico': 'image/x-icon', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

function send(res, code, body, type = 'application/json; charset=utf-8') {
  /* 一定要给 Content-Length。
   * 不给的话 Node 会走 chunked，浏览器和 curl 都读得懂，但 Python 的 urllib 在
   * keep-alive 连接上会一直等到超时——表现出来就是"接口挂了"，其实是响应没写完。
   * 这个坑是 /api/act 接进来才暴露的：以前只有浏览器调这些口。 */
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body == null ? '' : String(body), 'utf8');
  res.writeHead(code, {
    'Content-Type': type,
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/预览-66.html';
  const f = path.resolve(ROOT, '.' + p);
  if (!f.startsWith(ROOT)) return send(res, 403, 'forbidden', 'text/plain');
  fs.stat(f, (e, st) => {
    if (e || !st.isFile()) return send(res, 404, 'not found: ' + p, 'text/plain; charset=utf-8');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(f).pipe(res);
  });
}

/* ---------------- 记忆文件 ---------------- */
const NAME_OK = /^[a-z0-9._-]{1,40}$/i;

function storePath(name) {
  if (!NAME_OK.test(name)) throw new Error('文件名不合法：' + name);
  return path.join(DATA, name);
}

function handleStore(req, res, name, append) {
  const f = storePath(name);
  if (req.method === 'GET') {
    if (!fs.existsSync(f)) return send(res, 404, '', 'text/plain; charset=utf-8');
    return send(res, 200, fs.readFileSync(f, 'utf8'), 'text/plain; charset=utf-8');
  }
  let body = '';
  req.setEncoding('utf8');
  req.on('data', c => body += c);
  req.on('end', () => {
    try {
      if (append) fs.appendFileSync(f, body);
      else fs.writeFileSync(f, body);
      send(res, 200, JSON.stringify({ ok: true, name, bytes: Buffer.byteLength(body), append }));
    } catch (e) { send(res, 500, JSON.stringify({ ok: false, error: String(e.message) })); }
  });
}

/* ---------------- 导入模型：收一个 .vrm 落盘并登记 ----------------
 * POST /api/model?name=<slug>&label=<显示名>&author=&license=&commercial=0|1
 * body = VRM 原始字节
 *
 * 为什么要服务端做：浏览器不能写磁盘。想做到"拖进来、下次打开还在"，
 * 就必须有一步落盘 + 一步登记。
 *
 * 两件事必须**一起成功**：文件写进去、characters.json 记上了。
 * 只成一半的状态（文件在、注册表没记）表现为"导入成功但列表里没有"，
 * 而这种错最难查——文件确实在，日志也确实说成功了。
 * 所以顺序是：写临时文件 → 改注册表 → 改名。任何一步失败就全部回滚。
 */
const MODEL_MAX = 60 * 1024 * 1024;
const MODEL_DIR = path.join(ROOT, 'assets', 'vrm');
const CHAR_JSON = path.join(ROOT, 'assets', 'characters.json');

function handleModel(req, res, q) {
  const slug = String(q.get('name') || '').trim();
  /* 这个名字会变成磁盘文件名。规则比记忆文件更严：不许以 - 或 _ 开头，
   * 也不许有点——这样 `..` 这类东西从第一步就进不来，不靠后面的 path.join 兜。 */
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(slug)) {
    return send(res, 400, JSON.stringify({
      ok: false, error: '名字不合法：只允许小写字母、数字、- 和 _，不能以符号开头，40 字以内',
    }));
  }
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MODEL_MAX) {
    req.resume();
    return send(res, 413, JSON.stringify({
      ok: false, error: `文件太大（${(declared / 1048576).toFixed(1)} MB），上限 60 MB`,
    }));
  }

  const file = path.join(MODEL_DIR, slug + '.vrm');
  if (fs.existsSync(file)) {
    /* 不覆盖。他的模型可能是花了钱买的，同名就盖掉是不可接受的默认行为。 */
    req.resume();
    return send(res, 409, JSON.stringify({
      ok: false, error: `assets/vrm/${slug}.vrm 已经存在。换一个名字，或者先手动删掉旧的`,
    }));
  }

  const chunks = [];
  let size = 0, aborted = false;
  req.on('data', (c) => {
    size += c.length;
    if (size > MODEL_MAX) { aborted = true; req.destroy(); return; }
    chunks.push(c);
  });
  req.on('aborted', () => { aborted = true; });
  req.on('end', () => {
    if (aborted) return;
    if (!size) return send(res, 400, JSON.stringify({ ok: false, error: '空文件' }));

    const body = Buffer.concat(chunks);
    /* VRM 是 glb 容器，前四个字节就是 magic。检查它比检查扩展名可靠——
     * 扩展名谁都能改，改了之后 loader 会在页面里抛一个看不懂的错。 */
    const magic = body.subarray(0, 4).toString('latin1');
    if (magic !== 'glTF') {
      return send(res, 400, JSON.stringify({
        ok: false, error: '这不是 VRM/GLB 文件（文件头不对）。检查一下是不是拖错了，或者文件下载没下完',
      }));
    }

    const tmp = file + '.tmp';
    let backup = null;
    try {
      fs.mkdirSync(MODEL_DIR, { recursive: true });
      fs.writeFileSync(tmp, body);

      const raw = fs.readFileSync(CHAR_JSON, 'utf8');
      backup = raw;
      const reg = JSON.parse(raw);
      const ch = (reg.characters || [])[0];
      if (!ch) throw new Error('characters.json 里没有角色，不知道该登记给谁');
      if (!Array.isArray(ch.avatarModels)) ch.avatarModels = [];

      const id = 'vrm-' + slug;
      const entry = {
        id,
        kind: 'vrm',
        label: String(q.get('label') || '3D').slice(0, 20) || '3D',
        src: 'assets/vrm/' + slug + '.vrm',
        use: ['room'],
        note: `导入的模型（${slug}）`,
        credit: {
          author: String(q.get('author') || '').slice(0, 80),
          license: String(q.get('license') || '').slice(0, 120),
          commercial: q.get('commercial') === '1',
        },
      };
      /* 同一个 id 已经在了就替换，不再加一条——否则反复导入同一名字
       * 会在面板里堆出十几个长得一样的条目。 */
      const at = ch.avatarModels.findIndex((a) => a && a.id === id);
      if (at >= 0) ch.avatarModels[at] = entry;
      else ch.avatarModels.push(entry);

      fs.writeFileSync(CHAR_JSON, JSON.stringify(reg, null, 2) + '\n');
      fs.renameSync(tmp, file);

      send(res, 200, JSON.stringify({
        ok: true, id, slug, src: entry.src,
        bytes: body.length,
        replaced: at >= 0,
        characters: ch.avatarModels.length,
      }));
    } catch (e) {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e2) {}
      if (backup != null) { try { fs.writeFileSync(CHAR_JSON, backup); } catch (e2) {} }
      send(res, 500, JSON.stringify({ ok: false, error: String(e.message) }));
    }
  });
}

/* ---------------- 模型 ---------------- */
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* 结构化输出只认一个布尔，**不接受外部传 response_format**。
 * 理由和"外面不许替她思考"是同一条：让人指定输出格式，等于让人规定她怎么想。
 * 要开也只有一种形状——DeepSeek 的 json_object，没有 schema、没有 strict。
 *
 * 官方文档的两个前提由调用方负责（这里管不了）：
 *   ① prompt 里必须出现 "json" 这个词，并给一个格式示例（在 prompt.mjs 的「怎么回」里）；
 *   ② max_tokens 要给够，否则 JSON 被截断。
 * 还有一条最要命的：**输出不是 JSON 时，上游会把正文整段替换成空格**，
 *   所以开了 json 之后拿到"空白"是正常现象，必须当成一种可诊断的失败来重试，
 *   不能当成"她今天不想说话"。 */
function jsonMode(q) {
  return q && q.json === true ? { response_format: { type: 'json_object' } } : null;
}

async function handleChat(req, res) {
  if (!CRED.key) return send(res, 500, JSON.stringify({ ok: false, error: '没有密钥：填 keys.json 的 DEEPSEEK_API_KEY 或 ~/.dsh/.credentials.yaml' }));
  let body = '';
  req.setEncoding('utf8');
  req.on('data', c => body += c);
  req.on('end', async () => {
    let q;
    try { q = JSON.parse(body || '{}'); } catch { return send(res, 400, JSON.stringify({ ok: false, error: 'body 不是 JSON' })); }
    const messages = [];
    if (q.system) messages.push({ role: 'system', content: String(q.system) });
    for (const m of (q.messages || [])) {
      if (!m || !m.content) continue;
      messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content) });
    }
    if (!messages.length) return send(res, 400, JSON.stringify({ ok: false, error: '没有消息' }));

    const t0 = Date.now();
    if (q.stream === true) return streamChat(req, res, { messages, q, t0 });
    try {
      const r = await requestJSON('https://api.deepseek.com/chat/completions', {
        headers: { Authorization: 'Bearer ' + CRED.key },
        body: {
          model: q.model || MODEL,
          messages,
          // flash 这种带思考的模型会把 max_tokens 先花在 reasoning 上，给小了正文就是空串
          max_tokens: Math.max(64, Number(q.max_tokens) || 400),
          temperature: q.temperature ?? 0.9,
          stream: false,
          ...(jsonMode(q) || {}),
        },
      });
      const ms = Date.now() - t0;
      if (r.status !== 200) {
        return send(res, 502, JSON.stringify({ ok: false, error: `上游 ${r.status}`, detail: String(r.text).slice(0, 400) }));
      }
      const content = r.json?.choices?.[0]?.message?.content ?? '';
      const usage = r.json?.usage ?? null;
      logChat({ ms, usage, model: r.json?.model || MODEL, system: q.system, messages, content,
        json: q.json === true, finish: r.json?.choices?.[0]?.finish_reason || null });
      /* finish 也回给页面：'length' 就是被 max_tokens 截断，JSON 截断必然是 bad_json，
       * 页面据此换一句话重发（'太长了，压到两句'），而不是盲目再要一遍。 */
      send(res, 200, JSON.stringify({ ok: true, content, ms, usage, model: r.json?.model || MODEL,
        finish: r.json?.choices?.[0]?.finish_reason || null }));
    } catch (e) {
      send(res, 502, JSON.stringify({ ok: false, error: String(e.message || e) }));
    }
  });
}

/* 聊天记录落盘。流式和非流式写同一份，字段也一样——
 * 事后查"她那天说了什么"时不该因为当时走的是哪条路而少几个字段。 */
function logChat({ ms, usage, model, system, messages, content, stream = false, aborted = false, thinking = 0,
                   json = false, finish = null }) {
  try {
    fs.appendFileSync(path.join(LOGS, `chat-${today()}.jsonl`), JSON.stringify({
      at: new Date().toISOString(), model, ms, usage,
      systemChars: system ? String(system).length : 0,
      messages: messages.filter(m => m.role !== 'system'),
      content,
      ...(stream ? { stream: true } : {}),
      ...(aborted ? { aborted: true } : {}),
      ...(thinking ? { thinkingChars: thinking } : {}),
      /* json 与 finish 一起记：事后算"合规率"和"是不是被截断"都靠这两个字段，
       * 不然只剩一句"她那天话少"，查不出原因。 */
      ...(json ? { json: true } : {}),
      ...(finish ? { finish } : {}),
    }) + '\n');
  } catch (e) {
    // 日志写不上不该让这一轮失败：她在说话，账本可以回头补
    console.warn('[serve] 聊天日志没写上：', e.message);
  }
}

/*
 * 流式代理。它只做一件事：把上游的 SSE 一条一条转给页面。
 *
 * 它**不认识** say / do / JSON 里的任何意思——那是她的话，归大脑和页面解析。
 * 它唯一知道的语义是两个，都是 DeepSeek 文档写明的：
 *   `data: [DONE]`          —— 流结束
 *   delta.content           —— 这一帧她新说的话
 *
 * 为什么还要单独认出 delta.reasoning_content：思考模型把推理过程放这个字段里。
 * 它不是她说的话。顺手当正文转出去，她会把心里想的念出来——这正是"用外部算法
 * 替她想"的另一种形态，而且更难发现（观众会以为她想得很深）。
 *
 * 为什么没加 stream_options.include_usage：文档说最后一帧**一定**带 usage，
 * 加不加都一样。少一个参数就少一种 400 的可能。
 */
async function streamChat(req, res, { messages, q, t0 }) {
  const ac = new AbortController();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',       // 有反代时别攒包
  });
  res.write(': open\n\n');           // 先冒个头，别让页面以为连了个空响应

  let closed = false;
  let content = '';
  let thinking = 0;
  let usage = null;
  let model = q.model || MODEL;
  let aborted = false;
  let finish = null;              // 流式下它出现在最后一帧的 choices[0] 上

  const write = obj => {
    if (closed) return;
    try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { closed = true; }
  };

  /* 页面断开（打断 / 关页 / 网断）→ 立刻掐上游。
   * 不掐的后果：她那边还在生成，钱在花，而我们以为停了——"打断"就成了假的。 */
  res.on('close', () => { closed = true; ac.abort(); });

  try {
    const r = await requestStream('https://api.deepseek.com/chat/completions', {
      headers: { Authorization: 'Bearer ' + CRED.key },
      body: {
        model: q.model || MODEL,
        messages,
        max_tokens: Math.max(64, Number(q.max_tokens) || 400),
        temperature: q.temperature ?? 0.9,
        stream: true,
        ...(jsonMode(q) || {}),
      },
      signal: ac.signal,
      onEvent: ev => {
        const d = ev.data;
        if (d === '[DONE]') return;
        let j;
        try { j = JSON.parse(d); } catch { return; }   // 分帧器保证整帧，真解析不了就跳，别把流搞断
        if (j.model) model = j.model;
        if (j.usage) usage = j.usage;
        if (j.choices?.[0]?.finish_reason) finish = j.choices[0].finish_reason;
        const delta = j.choices?.[0]?.delta || {};
        if (delta.reasoning_content) { thinking += String(delta.reasoning_content).length; return; }
        const t = delta.content;
        if (t) { content += t; write({ d: t }); }
      },
    });

    const ms = Date.now() - t0;
    if (r.aborted || ac.signal.aborted) {
      aborted = true;
      logChat({ ms, usage, model, system: q.system, messages, content, stream: true, aborted: true, thinking,
        json: q.json === true, finish });
      return;
    }
    if (r.status !== 200) {
      logChat({ ms, usage, model, system: q.system, messages, content, stream: true, thinking,
        json: q.json === true, finish });
      write({ error: `上游 ${r.status}`, detail: String(r.text || '').slice(0, 400) });
      closed = true;
      return res.end();
    }
    logChat({ ms, usage, model, system: q.system, messages, content, stream: true, thinking,
      json: q.json === true, finish });
    write({ done: true, content, ms, usage, model, thinking, finish });
    closed = true;
    res.end();
  } catch (e) {
    if (ac.signal.aborted) { closed = true; return res.end(); }
    write({ error: String(e.message || e) });
    closed = true;
    try { res.end(); } catch { /* 已经断了 */ }
  }
}

/* ---------------- 声音 ----------------
 * 只做一件事：一句话进，一段 wav 出。
 * 没有可用引擎时**不装死**——503 里带上"试过哪几个、各自为什么不行"，
 * 页面看到 503 就退回"只有字幕"，并且只记一次，不弹红字。 */
/* POST /api/tts  {text, mood?, engine?, voice?}  → audio/wav
 *
 * mood 只影响"怎么念"（语速/音高），不影响"念什么"。
 * 所以它是可选的：不传就是她平常的口气，传了不会改变一个字。
 */
function handleTts(req, res) {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', c => { body += c; if (body.length > MAX_CHARS * 8) req.destroy(); });
  req.on('end', async () => {
    let q;
    try { q = JSON.parse(body || '{}'); } catch { return send(res, 400, JSON.stringify({ ok: false, error: 'body 不是 JSON' })); }
    const text = String(q.text ?? '');
    if (!text.trim()) return send(res, 400, JSON.stringify({ ok: false, error: '没有文本' }));
    /* 认识的情绪才传，不认识的一律当没有——不猜她想用什么口气。 */
    const mood = MOOD_NAMES.includes(String(q.mood)) ? String(q.mood) : null;

    const t0 = Date.now();
    let r;
    try { r = await synthAsync(text, { engine: q.engine, voice: q.voice, mood }); }
    catch (e) { r = { ok: false, reason: 'threw', message: String(e.message || e) }; }

    if (!r.ok) {
      /* 404 会让页面以为是"没有这个接口"；503 才是"有这个接口，但出不了声"。 */
      return send(res, 503, JSON.stringify({ ok: false, reason: r.reason, message: r.message, tried: r.tried }));
    }
    let buf;
    try { buf = fs.readFileSync(r.path); }
    catch { return send(res, 503, JSON.stringify({ ok: false, reason: 'read_failed', message: '合成好了但读不出来' })); }

    /* 两种格式：edge 给 mp3，sapi 给 wav。浏览器两个都认，
     * 但 Content-Type 必须说对——说成 wav 给它 mp3，有的浏览器会直接拒绝播。 */
    const ext = path.extname(r.path).slice(1).toLowerCase();
    res.writeHead(200, {
      'Content-Type': ext === 'mp3' ? 'audio/mpeg' : 'audio/wav',
      'Content-Length': buf.length,
      'Cache-Control': 'no-store',
      'X-Tts-Engine': r.engine,
      'X-Tts-Voice': r.voice || '',
      'X-Tts-Ms': String(Date.now() - t0),
      'X-Tts-Cached': r.cached ? '1' : '0',
      'X-Tts-Truncated': r.truncated ? '1' : '0',
      /* 语气也回给前端：排障时"为什么这句这么平"能一眼看出是没传 mood 还是没生效。 */
      'X-Tts-Rate': encodeURIComponent(r.prosody?.rate || ''),
      'X-Tts-Pitch': encodeURIComponent(r.prosody?.pitch || ''),
      'X-Tts-Pause': String(r.pauseMs || 0),
    });
    res.end(buf);
  });
}

/* ---------------- 看一眼屏幕 ----------------
 * POST /api/see  {image: dataURL}  →  {summary, entities, private, provider, ms}
 *
 * 这是整个服务里**唯一**会碰到屏幕内容的接口，所以三条克制写死在这里：
 *   ① 图只在内存里活一次：不落盘、不回显、不进日志。日志只记"看了多久、多大、成没成"。
 *      要查"她为什么这么说"，去看事件流（记忆），不要在运维日志里存一份屏幕内容。
 *   ② 一次只能有一个在看。并发返回 busy，**不排队**——排队等于她看的是五秒前的屏幕
 *      却当成"现在"，这和 P3 里"每句话都算新的"是同一条。
 *   ③ 限频（默认 2.5 秒一次）。不是防谁点，是这一下真要花钱；
 *      按着按钮狂点不该变成一串账单。
 */
const SEE = {
  inflight: false, lastAt: 0, minGapMs: Number(process.env.SEE_GAP_MS) || 2500,
  looks: 0, ok: 0, failed: 0, busy: 0, tooSoon: 0, last: null,
};

function logSee(r) {
  try {
    fs.appendFileSync(path.join(LOGS, `see-${today()}.jsonl`), JSON.stringify({
      at: new Date().toISOString(), ok: r.ok, reason: r.reason || null,
      provider: r.provider || null, model: r.model || null,
      ms: r.ms ?? null, bytes: r.bytes ?? null,
      chars: r.summary ? r.summary.length : 0, entities: r.entities ? r.entities.length : 0,
      degraded: r.degraded === true || undefined,
      /* 摘要和图都不写。这一行是账本，不是内容档案。 */
    }) + '\n');
  } catch (e) { console.warn('[serve] 看图日志没写上：', e.message); }
}

function handleSee(req, res) {
  const prv = pickProvider({ keys: KEYS, prefer: process.env.VISION_PROVIDER || null, model: process.env.VISION_MODEL || null });
  if (!prv) {
    req.resume();
    return send(res, 503, JSON.stringify({
      ok: false, reason: 'no_key',
      message: `没有能看图的密钥。在 keys.json 里填一个：${Object.values(PROVIDERS).map(p => p.keyName).join(' / ')}`,
      tried: Object.values(PROVIDERS).map(p => p.label + '·' + p.model),
    }));
  }
  if (SEE.inflight) {
    req.resume(); SEE.busy += 1;
    return send(res, 409, JSON.stringify({ ok: false, reason: 'busy', message: '上一眼还没看完' }));
  }
  const gap = Date.now() - SEE.lastAt;
  if (SEE.lastAt && gap < SEE.minGapMs) {
    req.resume(); SEE.tooSoon += 1;
    return send(res, 429, JSON.stringify({
      ok: false, reason: 'too_soon', waitMs: SEE.minGapMs - gap,
      message: `刚看过（${gap} 毫秒前），等一下再看`,
    }));
  }

  let body = '', over = false;
  const LIMIT = SEE_MAX_BYTES * 1.4 + 8192;
  req.setEncoding('utf8');
  /* 超限就停止累积，但**不断开连接**：断开会让她看到一个"网络错误"，
   * 而实际原因是图太大。这条是本地服务，把这点字节读完比让人猜便宜。 */
  req.on('data', c => {
    if (over) return;
    body += c;
    if (body.length > LIMIT) { over = true; body = ''; }
  });
  req.on('end', async () => {
    if (over) return send(res, 413, JSON.stringify({ ok: false, reason: 'too_large', message: '图太大' }));
    let q;
    try { q = JSON.parse(body || '{}'); } catch { return send(res, 400, JSON.stringify({ ok: false, error: 'body 不是 JSON' })); }
    if (!q.image) return send(res, 400, JSON.stringify({ ok: false, reason: 'no_image', message: '没有 image' }));

    SEE.inflight = true;
    SEE.looks += 1;
    SEE.lastAt = Date.now();
    try {
      const r = await describe({ dataUrl: q.image, keys: KEYS, prefer: prv.id, model: process.env.VISION_MODEL || null });
      if (r.ok) SEE.ok += 1; else SEE.failed += 1;
      SEE.last = { at: Date.now(), ok: r.ok, ms: r.ms ?? null, bytes: r.bytes ?? null,
                   reason: r.reason || null, chars: r.summary ? r.summary.length : 0 };
      logSee(r);
      /* 状态码分三层：图不对是 400（他的错），没配 key 是 503（没装好），
       * 上游失败是 502（别人的错）。页面据此说不同的话。 */
      const code = r.ok ? 200 : r.reason === 'bad_image' ? 400 : r.reason === 'no_key' ? 503 : 502;
      send(res, code, JSON.stringify({ ok: r.ok, ...r }));
    } catch (e) {
      SEE.failed += 1;
      send(res, 500, JSON.stringify({ ok: false, reason: 'threw', message: String(e.message || e) }));
    } finally {
      SEE.inflight = false;
    }
  });
}

/* ---------------- 路由 ---------------- */
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/health') {
    return send(res, 200, JSON.stringify({
      ok: true, hasKey: !!CRED.key, keyFrom: CRED.from, model: MODEL, root: ROOT, data: DATA,
      alive: aliveInfo(),
      inbox: { clients: IN.clients.size, queued: IN.queue.length, got: IN.got, dropped: IN.dropped },
      /* 行动端口：谁在听、派了几个、回来几个、超时几个。
       * 分开数，是因为"她没动"有三种原因：页面没开、超时了、动作被注册表拒了。 */
      act: { clients: ACT.clients.size, pending: ACT.pending.size, got: ACT.got, done: ACT.done,
        timedOut: ACT.timedOut, noPage: ACT.noPage },
      /* 接了哪几条外线、起没起来、各收了几条、最后一次是多久以前。
       * 不列这个，"QQ 怎么不说话"就只能靠猜：是没接、是没起来、还是没人发。 */
      adapters: AD.info(),
      /* 能不能看图，要在 health 里说清楚。不说的话，用户只会看到"她看不见"，
       * 然后怀疑是模型、是权限、是显卡，最后发现是没填 key。 */
      vision: {
        ready: Boolean(pickProvider({ keys: KEYS, prefer: process.env.VISION_PROVIDER || null,
                                      model: process.env.VISION_MODEL || null })),
        provider: pickProvider({ keys: KEYS, prefer: process.env.VISION_PROVIDER || null })?.id || null,
        have: Object.values(PROVIDERS).filter(p => KEYS[p.keyName]).map(p => p.keyName),
        stats: { ...SEE },
      },
      /* 声音：哪个引擎、什么音色、常驻进程在不在。
       * 不写清楚的话，"声音还是机器人"这件事只能靠猜——分不清是没装包、
       * 是退回了本机拼接音、还是常驻进程根本没起来。 */
      voice: {
        persona: PERSONA.voice,
        daemon: daemonInfo(),
        /* 冷却：连着失败两次就 60 秒内不再试 edge——断网时别让每句话都等一次超时。 */
        edge: edgeCooldown(),
      },
    }));
  }
  if (u.pathname === '/api/alive' && req.method === 'POST') {
    return send(res, 200, JSON.stringify({ ok: true, at: markAlive(req) }));
  }
  if (u.pathname === '/api/in' && req.method === 'POST') return handleIn(req, res);
  if (u.pathname === '/api/in' && req.method === 'GET') {
    // 只读一眼：现在有几个页面在听、排了几条
    return send(res, 200, JSON.stringify({ ok: true, clients: IN.clients.size, queued: IN.queue.length,
      got: IN.got, dropped: IN.dropped }));
  }
  if (u.pathname === '/api/in/stream' && req.method === 'GET') return handleInStream(req, res);
  if (u.pathname === '/api/act' && req.method === 'POST') return handleAct(req, res);
  if (u.pathname === '/api/act/stream' && req.method === 'GET') return handleActStream(req, res);
  if (u.pathname === '/api/act/result' && req.method === 'POST') return handleActResult(req, res);
  if (u.pathname === '/api/chat' && req.method === 'POST') return handleChat(req, res);
  if (u.pathname === '/api/see' && req.method === 'POST') return handleSee(req, res);
  if (u.pathname === '/api/tts' && req.method === 'POST') return handleTts(req, res);
  if (u.pathname === '/api/tts/health') {
    const list = probeEngines();
    return send(res, 200, JSON.stringify({
      ok: list.some(x => x.ready),
      engines: list,
      persona: { voice: PERSONA.voice },
      daemon: daemonInfo(),
      edge: edgeCooldown(),
    }));
  }
  if (u.pathname === '/api/model' && req.method === 'POST') return handleModel(req, res, u.searchParams);
  if (u.pathname.startsWith('/api/store/')) {
    const name = u.pathname.slice('/api/store/'.length);
    if (req.method === 'GET' || req.method === 'POST') return handleStore(req, res, name, u.searchParams.get('append') === '1');
    return send(res, 405, 'method not allowed', 'text/plain');
  }
  if (req.method !== 'GET') return send(res, 405, 'method not allowed', 'text/plain');
  serveStatic(req, res);
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 被占用。先关掉旧的那个，或换端口：PORT=8766 node tools/serve.mjs`);
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[serve] http://127.0.0.1:${PORT}/  根=${ROOT}`);
  console.log(`[serve] 模型=${MODEL}  密钥=${CRED.key ? '有（来自 ' + CRED.from + '）' : '没有'}  记忆目录=${DATA}`);
  /* 声音：启动时把引擎探一遍，并且把 edge 的常驻进程**热起来**。
   * 热起来这件事不能省：python 那边 import edge_tts 要 1.8 秒，
   * 不预热的话这 1.8 秒要算在她开口的第一句上——第一句永远是慢的，而且查不出原因。 */
  try {
    const list = probeEngines();
    const ready = list.filter(x => x.ready);
    console.log(`[serve] 声音=${ready.length ? ready.map(x => x.engine).join('+') : '没有可用引擎（她会只有字幕）'}`
      + (ready.length ? '' : '  ' + list.map(x => x.engine + ':' + x.why).join('；')));
    console.log(`[serve] 音色=${PERSONA.voice}`);
    if (ready.some(x => x.engine === 'edge')) {
      const t0 = Date.now();
      warmUp({ timeoutMs: 20000 }).then(r => {
        console.log(r.ok
          ? `[serve] 语音常驻进程热好了（${Date.now() - t0} ms），之后每句只等网络`
          : `[serve] 语音常驻进程预热失败（${r.error || '超时'}）——会退回同步合成，每句慢约两秒`);
      }).catch(e => console.log('[serve] 预热出错 ' + (e.message || e)));
    }
  } catch (e) { console.log('[serve] 声音：探测失败 ' + e.message); }
  /* 常驻进程不能永远活着：没人在说话就把它关掉，下次要用再起。 */
  setInterval(() => { try { daemonIdleKill(); } catch { /* 关不掉也不影响服务 */ } }, 60 * 1000).unref?.();
  /* 清理：删了多少要说出来。悄悄删和悄悄不删一样坏。 */
  try {
    const t = prune();
    const l = pruneLogs();
    console.log(`[serve] 清理：语音缓存删 ${t.removed} 条（留 ${t.kept}，${(t.bytes / 1048576).toFixed(1)} MB）；`
      + `旧日志删 ${l.removed} 份（留 ${l.kept}）`);
  } catch (e) { console.log('[serve] 清理失败（不影响运行）：' + e.message); }
  console.log(`[serve] 外面的话：POST /api/in 进来，页面 GET /api/in/stream 订阅；现在 ${IN.clients.size} 个页面在听`);

  /* 外线：扫 adapters/。失败只说一句人话，不把服务拖下来——
   * 一条线接不上，她照样能跟他说话。 */
  AD.load().then(r => {
    if (r.missing) return console.log('[serve] 外线=没有（adapters/ 目录不存在；想接 QQ/弹幕，看 adapters/README.md）');
    const list = AD.info();
    if (!list.length) console.log('[serve] 外线=没有（adapters/ 里没有 .mjs；_example.mjs 复制改名就能加一条）');
    else console.log('[serve] 外线：' + list.map(a =>
      `${a.id}${a.label && a.label !== a.id ? '（' + a.label + (a.where ? ' · ' + a.where : '') + '）' : ''}${a.error ? ' ✗ ' + a.error : a.started ? '' : ' ✗ 没起来'}`
    ).join('、'));
    for (const s of r.skipped) console.log(`[serve] 外线跳过 ${s.file}：${s.why}`);
  }).catch(e => console.log('[serve] 外线加载出错（不影响她说话）：' + (e.message || e)));
  /* 能不能看图也说一句，理由和声音一样：不说的话，"她看不见"会被当成 bug 查半天。 */
  const vp = pickProvider({ keys: KEYS, prefer: process.env.VISION_PROVIDER || null, model: process.env.VISION_MODEL || null });
  console.log(vp
    ? `[serve] 看图=${vp.label}·${vp.model}（POST /api/see；一眼一算，限频 ${SEE.minGapMs}ms）`
    : `[serve] 看图=没有（keys.json 里填 ${Object.values(PROVIDERS).map(p => p.keyName).join(' / ')} 任意一个就能用）`);
});

/* 退出时把外线拔干净。WebSocket 不关的话进程要等连接超时才走，
 * 双击关窗口的人会以为它卡死了——那种"关不掉"的体验一次就够。 */
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    try { AD.stopAll(); } catch { /* 停不下来也只能算了 */ }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref?.();
  });
}
