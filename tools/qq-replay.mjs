/* QQ 聊天记录回放（外线测试用，不是适配器）
 * ============================================
 * 干什么：读一份导出的 QQ 聊天 JSONL，按原来的先后顺序、压缩后的间隔，
 * 一句一句 POST 到 /api/in，就像 NapCat 正在往外吐消息一样。
 *
 * 为什么不是适配器：适配器要连协议、要重连、要鉴权；这里只是**把一段旧记录
 * 当成活的消息流灌进去**，用来回答一个问题——"她接得住群聊吗"。
 * 两种东西不要混：适配器进 chat-in 的 registerAdapter，这个脚本进的是 /api/in。
 *
 * 记录本身**只读**：不复制、不改写、不写进仓库；脚本里没有一句聊天内容。
 * 内存里留下的那条"她说她听见了"是她的记忆（chat-in 的设计），不是这个脚本写的。
 *
 * 跑：
 *   node tools/qq-replay.mjs --file <导出好的 messages.jsonl> \
 *        --conv 670607862 --offset 40000 --n 8 --gap 400
 *   node tools/qq-replay.mjs ... --dry        先看要发什么，不发
 *   node tools/qq-replay.mjs ... --no-watch   不盯她的回复
 *
 * 参数：
 *   --file    导出的 JSONL，每行 {conv,kind,ts,qq,nick,text}
 *   --conv    群号（kind=group 的 conv）
 *   --offset  从该会话的第几条开始（默认 0）
 *   --n       发几条（默认 8）
 *   --gap     两条之间等多少毫秒（默认 400；真实群聊会慢得多，压紧是为了看得清）
 *   --url     服务地址（默认 http://127.0.0.1:8765）
 *   --watch   发完盯多少秒她的回复（默认 40）
 *   --dry     只打印不发送
 *
 * 为什么 from 用 QQ 号、name 用昵称：chat-in 按 from 认人（guest:<from>），
 * 昵称会改、号不会。她读到的历史里显示的是 name（`[昵称] 说了什么`）。
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
const FILE = arg('file');
const CONV = arg('conv');
const OFFSET = Number(arg('offset', 0));
const N = Number(arg('n', 8));
const GAP = Number(arg('gap', 400));
const URL_BASE = String(arg('url', 'http://127.0.0.1:8765')).replace(/\/$/, '');
const WATCH = Number(arg('watch', 40));
const DRY = Boolean(arg('dry', false));
const NO_WATCH = Boolean(arg('no-watch', false));

if (!FILE || FILE === true) {
  console.error('要 --file（导出的聊天 JSONL）和 --conv（群号）。--help 看注释第一段。');
  process.exit(2);
}

/* 一行记录 → 一条外线消息。缺昵称就叫最后四位，不编一个名字出来
 * （和 chat-in 里"缺名字就叫有人"同一个道理：宁可不好听，不要假）。 */
function toMsg(d) {
  const text = String(d.text ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const qq = String(d.qq || '').trim();
  if (!qq) return null;
  const nick = String(d.nick || '').trim().slice(0, 24);
  return {
    text: text.slice(0, 500),
    from: qq,
    name: nick || `qq${qq.slice(-4)}`,
    source: 'group',
    _ts: Number(d.ts) || 0,
  };
}

function hhmm(ts) {
  if (!ts) return '--:--';
  const d = new Date(ts * 1000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 挑消息：只按 kind+conv 取，不按内容挑。
 * 这一条是规矩不是洁癖——"回放哪一段"由人决定，不由脚本替她挑"这段比较好接"。 */
async function pick() {
  if (!(await fs.promises.stat(FILE).then(s => s.isFile()).catch(() => false))) {
    throw new Error(`找不到文件：${FILE}`);
  }
  const out = [];
  let seen = 0;
  const rl = readline.createInterface({ input: fs.createReadStream(FILE, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (CONV && String(d.conv) !== String(CONV)) continue;
    if (CONV && d.kind && d.kind !== 'group') continue;
    const m = toMsg(d);
    if (!m) continue;
    if (seen++ < OFFSET) continue;
    out.push(m);
    if (out.length >= N) break;
  }
  rl.close();
  return out;
}

/* ---- 盯她的回复：读 chat-*.jsonl 的新增行 ----
 * 不猜、不插话，只把服务端已经落盘的 content 打出来。
 * 为什么读日志而不是等接口：她的话没有"回给谁"这个概念，日志是唯一的账本；
 * 再加一条到 /api/in 的返回里，等于给外线开一个"她说了什么"的后门。 */
function watchLog(sinceBytes) {
  const d = new Date();
  const name = `chat-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.jsonl`;
  const file = path.join(ROOT, 'logs', name);
  let pos = sinceBytes;
  /* 读到一半的行要留着。服务端是 appendFileSync 一行一次写，但那不代表我们
   * 每次 stat 都恰好落在行尾——丢了半行，等于她的话在屏幕上少了半句。 */
  let tail = '';
  const say = content => {
    let obj = null;
    try { obj = JSON.parse(content); } catch { /* 不是 JSON 就原样打 */ }
    const line = obj && typeof obj.say === 'string' ? obj.say : String(content ?? '');
    if (!line.trim()) return;
    const act = obj && Array.isArray(obj.do) && obj.do.length
      ? `  （动作：${obj.do.map(x => x.do || x).join('、')}）` : '';
    console.log(`  她：「${line.trim()}」${act}`);
  };
  const tick = () => {
    let st;
    try { st = fs.statSync(file); } catch { return; }
    if (st.size <= pos) return;
    const buf = Buffer.alloc(st.size - pos);
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      fs.readSync(fd, buf, 0, buf.length, pos);
    } catch { return; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
    pos = st.size;
    const text = tail + buf.toString('utf8');
    const parts = text.split('\n');
    tail = parts.pop() || '';        // 最后一段没有换行：可能是半行，留到下次
    for (const line of parts) {
      if (!line.trim()) continue;
      try { say(JSON.parse(line).content); } catch { /* 不是这个格式的行，跳过 */ }
    }
  };
  const h = setInterval(tick, 700);
  return () => clearInterval(h);
}

const msgs = await pick();
if (!msgs.length) {
  console.error('这一段一条都没取到：检查 --conv 和 --offset。');
  process.exit(1);
}

console.log(`回放 ${msgs.length} 条（${msgs[0]._ts ? new Date(msgs[0]._ts * 1000).toLocaleString('zh-CN') : '时间未知'} 起，间隔压到 ${GAP}ms）`);
console.log('---');
for (let i = 0; i < msgs.length; i++) {
  const m = msgs[i];
  console.log(`${String(i + 1).padStart(2)}. [${hhmm(m._ts)}] ${m.name}：${m.text}`);
}
console.log('---');

if (DRY) {
  console.log('（--dry：一条都没发）');
  process.exit(0);
}

/* 试一次口子通不通，再开始发。
 * 不通就整段不发——半段灌进去比不灌更糟：她会以为群里话说了一半就散了。 */
try {
  const h = await fetch(`${URL_BASE}/api/in`, { method: 'GET' });
  const j = await h.json();
  if (!j.ok) throw new Error(JSON.stringify(j));
  console.log(`口子是通的（现在 ${j.clients} 个页面在听，排着 ${j.queued} 条）`);
} catch (e) {
  console.error(`服务没起来或 /api/in 不通：${e.message}`);
  console.error(`先跑 node tools/serve.mjs，再开页面。`);
  process.exit(1);
}

/* 从"现在"开始记账，这样盯到的只会是新发生的对话。 */
let since = 0;
try {
  const d = new Date();
  const f = path.join(ROOT, 'logs', `chat-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.jsonl`);
  since = fs.statSync(f).size;
} catch { /* 今天还没有对话，从 0 开始 */ }

const stop = NO_WATCH ? () => {} : watchLog(since);
let sent = 0;
for (let i = 0; i < msgs.length; i++) {
  const { _ts, ...body } = msgs[i];
  try {
    const r = await fetch(`${URL_BASE}/api/in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (j.ok) sent += 1;
    const state = j.ok ? (j.delivered ? `→ ${j.delivered} 个页面` : `→ 排队 ${j.queued}`) : `✗ ${j.error}`;
    console.log(`发 ${i + 1}/${msgs.length} ${state}`);
  } catch (e) {
    console.log(`发 ${i + 1}/${msgs.length} ✗ ${e.message}`);
  }
  if (i < msgs.length - 1) await sleep(GAP);
}

console.log('---');
console.log(`发出 ${sent}/${msgs.length}。` + (NO_WATCH ? '' : `盯 ${WATCH} 秒她的回复…`));
if (!NO_WATCH) {
  await sleep(WATCH * 1000);
  stop();
}
