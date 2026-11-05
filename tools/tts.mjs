/* 把一句人话变成一段 wav
 * ------------------------------------------------------------
 * 为什么单独一个文件：合成这件事有三种做法（本机离线 / 在线 / 以后换云），
 * 而 serve.mjs 只该知道"给我一段 wav"。引擎写成一张表，加一个不用改路由。
 *
 * 现在的两个真引擎：
 *   edge  edge-tts（在线，神经音色，像真人）—— **默认走这个**
 *   sapi  本机离线的系统语音（Windows 自带的 Huihui/Kangkang/Yaoyao，拼接音，像导航）
 *
 * 顺序为什么是 edge 优先：sapi 排第一的时候，房间里听到的一直是那个 2009 年的
 * 拼接音，怎么调语速都像播报。换一个引擎就换了一个人，这是最省的一次改动。
 * 但 sapi 不能删：断网的时候它还能出声，哑掉比难听更糟。
 *
 * edge 走一个**常驻 python 进程**（tools/tts-edge-daemon.py）：
 * import edge_tts 本身要 1.8 秒，每句都付这 2.4 秒的话，字幕三句了第一句还没响。
 * 常驻之后每句只剩网络往返（实测 1.5-2.3 秒）。
 *
 * 都不行就**明说**（503 + 试过哪些、各自为什么失败），不许静默没声——
 * 页面那边会退回"只有字幕"，但用户得知道为什么。
 *
 * 缓存：按 sha1(文本+引擎+音色+语气) 存 data/tts/*.wav。同一个语气说同一句不再合成第二遍。
 * 语气进缓存键是必须的：同一句"我没事"，高兴和难过是两段音频，混用就等于没改语气。
 *
 * 跑：node tools/serve.mjs 会自动挂上 /api/tts
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PERSONA, prosody, pauseAfter } from './voice-profile.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
export const TTS_DIR = path.join(ROOT, 'data', 'tts');
export const SAPI_PS1 = path.join(HERE, 'tts-sapi.ps1');

/** 一次最多合成这么多字。再长就该拆成几句——直播里一口气说 300 字本来也不像人。 */
export const MAX_CHARS = 240;

/** 一句人话进合成之前的清洗：去掉 markdown、括号里的动作、多余的空白。 */
export function cleanText(t) {
  return String(t ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_`#>]/g, '')
    .replace(/（[^）]{0,20}）/g, ' ')
    .replace(/\([^)]{0,20}\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 太长就在标点处截断——截在句子中间比截在字中间好。 */
export function fitText(t, max = MAX_CHARS) {
  const s = cleanText(t);
  if (s.length <= max) return { text: s, truncated: false };
  const cut = s.slice(0, max);
  const at = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'),
    cut.lastIndexOf('，'), cut.lastIndexOf('.'));
  return { text: (at > max * 0.5 ? cut.slice(0, at + 1) : cut), truncated: true };
}

/* 每个引擎产出什么格式。edge 给 mp3（接口把 outputFormat 写死成 48kbps mp3，
 * 库源码里那一行是常量），sapi 和 stub 给 wav。
 *
 * 为什么不统一转成 wav：这台机器上没有 ffmpeg，没有 pydub，没有 miniaudio，
 * 一个能解 mp3 的都没有。而**浏览器本来就会解 mp3**，转一道纯属给自己找事。
 * 曾经踩过的坑：把 mp3 字节当裸 PCM 套一个 wav 头，RIFF 是对的、播放是噪声——
 * 校验全过、听起来全错，是最难查的那一类。所以下面按后缀认格式，不猜。 */
const ENGINE_EXT = { edge: 'mp3', sapi: 'wav', stub: 'wav' };
export const extOf = (id) => ENGINE_EXT[id] || 'wav';

export const okAudio = (p) => {
  const ext = path.extname(String(p)).slice(1).toLowerCase();
  try {
    const st = fs.statSync(p);
    if (st.size < 600) return false;
    const fd = fs.openSync(p, 'r');
    const b = Buffer.alloc(4);
    fs.readSync(fd, b, 0, 4, 0);
    fs.closeSync(fd);
    if (ext === 'wav') return b.toString('ascii', 0, 4) === 'RIFF';
    if (ext === 'mp3') {
      /* 帧同步（11 个 1）或者 ID3 标签。两样都不是，说明这段"音频"其实是别的什么东西。 */
      return (b[0] === 0xFF && (b[1] & 0xE0) === 0xE0) || b.toString('ascii', 0, 3) === 'ID3';
    }
    return true;
  } catch { return false; }
};

/* 曾经在这里补"句尾静音"（把 wav 尾部塞零、改两处长度）。
 * 删掉的原因：edge 产出 mp3，补不了；而 sapi 能补、edge 不能补，
 * 就成了"两种引擎停顿不一样"。现在统一由播放端在 onended 之后等 pauseAfter()
 * 那么久——一句话只有一种做法，而且 mp3/wav 都适用。 */

/* ---------------- edge 的常驻进程 ----------------
 * 一个进程，一行一个请求。为什么不并发：一句话本来就该说完再说下一句，
 * 并发只会抢带宽。而且真到"她被打断"的时候，排队里的那些本来就不该继续烧钱。
 */
const DAEMON_SCRIPT = path.join(HERE, 'tts-edge-daemon.py');
let DAEMON = null;

function daemonDead(why) {
  if (!DAEMON) return;
  const d = DAEMON;
  DAEMON = null;
  try { d.proc.kill(); } catch { /* 已经死了 */ }
  for (const [, p] of d.waiting) { try { p.resolve({ ok: false, error: why }); } catch { /* 没人等了 */ } }
  d.waiting.clear();
}

function daemonStart() {
  if (DAEMON && !DAEMON.dead) return DAEMON;
  if (!fs.existsSync(DAEMON_SCRIPT)) return null;
  const py = process.env.PYTHON || 'python';
  let proc;
  try {
    proc = spawn(py, [DAEMON_SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  } catch { return null; }

  const d = { proc, dead: false, ready: false, readyWait: [], buf: '', seq: 0, waiting: new Map(), lastUsed: Date.now() };
  DAEMON = d;

  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    d.buf += chunk;
    let i;
    while ((i = d.buf.indexOf('\n')) >= 0) {
      const line = d.buf.slice(0, i).trim();
      d.buf = d.buf.slice(i + 1);
      if (!line) continue;
      let j; try { j = JSON.parse(line); } catch { continue; }
      if (j.ready) { d.ready = true; for (const f of d.readyWait) f(true); d.readyWait = []; continue; }
      if (j.fatal) { daemonDead('常驻进程起不来：' + j.error); return; }
      const w = d.waiting.get(j.id);
      if (!w) continue;
      d.waiting.delete(j.id);
      w.resolve(j.ok ? { ok: true, ms: j.ms, bytes: j.bytes } : { ok: false, error: j.error || '没说出为什么' });
    }
  });
  proc.stderr.setEncoding('utf8');
  let errBuf = '';
  proc.stderr.on('data', (c) => { errBuf = (errBuf + c).slice(-800); });
  proc.on('error', (e) => { daemonDead('起不来：' + (e.message || e)); });
  proc.on('exit', (code) => { d.dead = true; daemonDead(`常驻进程退了（exit ${code}）${errBuf ? '：' + errBuf.trim().slice(0, 200) : ''}`); });
  return d;
}

/** 常驻进程空闲太久就杀掉一个，别留一个 python 永远在后台。 */
export function daemonIdleKill({ idleMs = 10 * 60 * 1000, now = Date.now } = {}) {
  if (!DAEMON || DAEMON.waiting.size) return false;
  if (now() - DAEMON.lastUsed < idleMs) return false;
  const d = DAEMON; DAEMON = null;
  try { d.proc.stdin.end(); d.proc.kill(); } catch { /* 已经死了 */ }
  return true;
}

export function daemonInfo() {
  if (!DAEMON) return { running: false, ready: false, pending: 0 };
  return { running: !DAEMON.dead, ready: DAEMON.ready, pending: DAEMON.waiting.size };
}

/** 一句话交给常驻进程。没有进程/进程死了返回 {ok:false}，调用方自己决定退到谁。 */
export function daemonSynth({ text, out, voice, rate, pitch, volume, timeoutMs = 12000 }) {
  const d = daemonStart();
  if (!d) return Promise.resolve({ ok: false, error: '启动不了常驻进程（python 或脚本不在）' });

  return new Promise((resolve) => {
    const id = String(++d.seq);
    d.lastUsed = Date.now();

    const timer = setTimeout(() => {
      if (!d.waiting.has(id)) return;
      d.waiting.delete(id);
      resolve({ ok: false, error: `超过 ${Math.round(timeoutMs / 1000)} 秒没回来` });
    }, timeoutMs);

    const done = (v) => { clearTimeout(timer); resolve(v); };
    d.waiting.set(id, { resolve: done });

    let sent = false;
    try {
      sent = d.proc.stdin.write(JSON.stringify({ id, text, out, voice, rate, pitch, volume }) + '\n');
    } catch (e) {
      d.waiting.delete(id);
      clearTimeout(timer);
      resolve({ ok: false, error: '写不进常驻进程：' + (e.message || e) });
      return;
    }
    if (sent === false) {
      /* stdin 缓冲满了：说明这个进程卡住了（网络卡住），杀掉重来比干等强。 */
      daemonDead('写不进去（缓冲满了），当它卡死');
    }
  });
}

/** 启动时预热一次：把 python 那 1.7 秒的启动成本花在开机，不是花在她第一句话上。 */
export async function warmUp({ timeoutMs = 20000 } = {}) {
  if (!engineOrder().includes('edge')) return { ok: false, skipped: true, why: '没选 edge' };
  const d = daemonStart();
  if (!d) return { ok: false, error: '没有常驻进程' };
  if (d.ready) return { ok: true, cold: false };
  return new Promise((res) => {
    const timer = setTimeout(() => res({ ok: false, error: '预热超时' }), timeoutMs);
    d.readyWait.push((okv) => { clearTimeout(timer); res({ ok: okv, cold: true }); });
  });
}

/* ---------------- 引擎表 ---------------- */

export const ENGINES = {
  edge: {
    id: 'edge',
    zh: 'edge-tts（在线，神经音色）',
    needs: ['python', 'edge-tts', 'tts-edge-daemon.py'],
    /* 同步版本只在常驻进程用不了的时候才走到（比如第一次就崩了）。
     * 它每句都要重新 import 一遍 edge_tts（1.8 秒），所以慢——但慢也比哑着强。 */
    run({ textFile, out, voice, rate, pitch, volume }) {
      const py = process.env.PYTHON || 'python';
      const args = ['-m', 'edge_tts', '--no-progress', '--file', textFile, '--write-media', out,
        '--voice', voice || PERSONA.voice];
      if (rate) args.push('--rate', String(rate));
      if (pitch) args.push('--pitch', String(pitch));
      if (volume) args.push('--volume', String(volume));
      const r = spawnSync(py, args, { encoding: 'utf8', timeout: 30000, windowsHide: true });
      return { ok: r.status === 0 && okAudio(out), detail: (r.stderr || r.stdout || '').trim().slice(0, 300) || `exit ${r.status}` };
    },
  },
  sapi: {
    id: 'sapi',
    zh: '本机语音（离线，救急用）',
    needs: ['windows', 'tts-sapi.ps1'],
    run({ textFile, out, voice }) {
      const host = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe';
      const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SAPI_PS1, '-TextFile', textFile, '-Out', out];
      if (voice) args.push('-Voice', voice);
      const r = spawnSync(host, args, { encoding: 'utf8', timeout: 30000, windowsHide: true });
      return { ok: r.status === 0 && okAudio(out), detail: (r.stderr || r.stdout || '').trim().slice(0, 300) || `exit ${r.status}` };
    },
  },
  /* 只给测试和排障用：不发声，造一段 0.4 秒的静音 wav。
   * 它的存在是为了能验"链路通不通"，不是为了假装有声。 */
  stub: {
    id: 'stub',
    zh: '测试用的假引擎（不发声）',
    needs: [],
    run({ out }) {
      fs.writeFileSync(out, silentWav(0.4));
      return { ok: okAudio(out), detail: 'stub' };
    },
  },
};

/** 一段合法的静音 wav（8kHz 单声道 16bit）。 */
export function silentWav(seconds = 0.4) {
  const rate = 8000, n = Math.round(rate * seconds);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0, 'ascii'); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii'); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii'); buf.writeUInt32LE(n * 2, 40);
  return buf;
}

/** 试的顺序：环境变量指定 > edge > sapi。stub 只有显式要才用。
 *
 * edge 在前不是因为它更"高级"，是因为它像人。sapi 那个拼接音不管怎么调语速
 * 都是导航播报，用户第一句就能听出来。sapi 留着只为了断网时还能出声。 */
export function engineOrder(pref) {
  const want = String(pref || process.env.LIFE_TTS || '').trim();
  if (want === 'stub') return ['stub'];
  if (want && ENGINES[want]) return [want, ...['edge', 'sapi'].filter(x => x !== want)];
  return ['edge', 'sapi'];
}

/** 这个引擎用哪个音色。sapi 不认 edge 的音色名，混着传会直接失败。 */
function voiceFor(id, want) {
  if (want) return want;
  return id === 'edge' ? PERSONA.voice : '';
}

/** 缓存键。语气进键是必须的：同一句"我没事"，高兴和难过是两段音频。 */
function cacheKey(id, voice, say, p) {
  /* sapi 用不上语速/音高（tts-sapi.ps1 只认音色），所以它不把这些算进键，
   * 否则同一句话会按 mood 存出五份一模一样的音频。 */
  const tone = id === 'sapi' ? '' : `${p.rate}|${p.pitch}|${p.volume}`;
  return crypto.createHash('sha1').update(`${id}|${voice}|${tone}|${say}`).digest('hex').slice(0, 16);
}

/** 清洗 + 算语气 + 列引擎。两种合成共用的前半段。 */
function prepare(text, opts = {}) {
  const { engine, engines, voice, mood, dir = TTS_DIR, now = Date.now, pad = true } = opts;
  fs.mkdirSync(dir, { recursive: true });
  const { text: say, truncated } = fitText(text);
  if (!say) return { err: { ok: false, reason: 'empty', tried: [] } };
  const p = prosody(say, { mood });
  const list = Array.isArray(engines) && engines.length ? engines : engineOrder(engine);
  return { say, truncated, p, list, voice, mood, dir, now, pad };
}

const noEngine = (tried) => ({
  ok: false, reason: 'no_engine',
  /* 这句是给人看的：用户拿到的不是"500"，是"在线那个没连上 / 本机那个没配好"。 */
  message: `没有一个能出声的引擎。试过：${tried.map(t => `${t.engine}（${t.detail}）`).join('；')}`,
  tried,
});

/** 一句，一个引擎，同步跑。查缓存 → 合成 → 补句尾停顿。 */
function oneEngineSync(id, ctx) {
  const e = ENGINES[id];
  if (!e) return { ok: false, detail: '没有这个引擎' };

  const v = voiceFor(id, ctx.voice);
  const key = cacheKey(id, v, ctx.say, ctx.p);
  const out = path.join(ctx.dir, `${key}.${extOf(id)}`);
  const pauseMs = ctx.pad ? pauseAfter(ctx.say) : 0;
  const shape = (extra) => ({
    ok: true, path: out, engine: id, voice: v, bytes: fs.statSync(out).size,
    truncated: ctx.truncated, prosody: ctx.p, pauseMs, ...extra,
  });

  if (okAudio(out)) return shape({ ms: 0, cached: true });

  const t0 = ctx.now();
  const textFile = path.join(ctx.dir, `${key}.txt`);
  fs.writeFileSync(textFile, ctx.say, 'utf8');
  let r;
  try { r = e.run({ textFile, out, voice: v, rate: ctx.p.rate, pitch: ctx.p.pitch, volume: ctx.p.volume }); }
  catch (err) { r = { ok: false, detail: String(err.message || err) }; }
  finally { try { fs.unlinkSync(textFile); } catch { /* 删不掉就留着，不影响 */ } }

  if (r.ok && okAudio(out)) {
    return shape({ ms: ctx.now() - t0, cached: false, via: 'inline' });
  }
  const detail = r.detail || '没有产出合法的 wav';
  try { if (fs.existsSync(out)) fs.unlinkSync(out); } catch { /* 同上 */ }
  return { ok: false, detail };
}

/**
 * 合成一句（同步）。
 * 返回 { ok:true, path, engine, voice, bytes, ms, truncated, cached, prosody, pauseMs }
 * 返回 { ok:false, reason, message, tried }
 */
export function synth(text, opts = {}) {
  const ctx = prepare(text, opts);
  if (ctx.err) return ctx.err;
  const tried = [];
  for (const id of ctx.list) {
    const r = oneEngineSync(id, ctx);
    if (r.ok) return r;
    tried.push({ engine: id, detail: r.detail });
  }
  return noEngine(tried);
}

/**
 * edge 连续失败就暂时别再试它。
 *
 * 为什么必须有：断网或者微软那边抽风时，每一句都要先等一次超时（最长 12 秒）
 * 才退回 sapi——结果是"网络一断，她说话每句卡十几秒"，比哑掉还难受。
 * 失败两次就冷却 60 秒，冷却期间直接用 sapi（难听但出声），到点自动再试一次。
 * 只失败一次不冷却：那是抖动，罚它一分钟反而让她一直用难听的那个。
 */
let EDGE_FAILS = { n: 0, until: 0, why: '' };
const EDGE_COOLDOWN_MS = 60000, EDGE_FAILS_TO_COOL = 2;

/** 现在 edge 是不是在冷却。排障和健康检查要能看见。 */
export function edgeCooldown(now = Date.now) {
  return EDGE_FAILS.until > now() ? { cooling: true, until: EDGE_FAILS.until, why: EDGE_FAILS.why } : { cooling: false, fails: EDGE_FAILS.n };
}

/**
 * edge 走常驻进程。失败就退回同步那一路（慢 2 秒，但只慢这一次）。
 * 返回和 oneEngineSync 一样的结果形状。
 */
async function oneEngineDaemon(ctx) {
  if (EDGE_FAILS.until > Date.now()) {
    return { ok: false, detail: `刚才连着失败，冷却到 ${new Date(EDGE_FAILS.until).toLocaleTimeString()}（${EDGE_FAILS.why}）` };
  }
  const v = voiceFor('edge', ctx.voice);
  const key = cacheKey('edge', v, ctx.say, ctx.p);
  const out = path.join(ctx.dir, `${key}.${extOf('edge')}`);
  const t0 = ctx.now();

  if (okAudio(out)) {
    return {
      ok: true, path: out, engine: 'edge', voice: v, bytes: fs.statSync(out).size,
      ms: 0, truncated: ctx.truncated, cached: true, prosody: ctx.p, pauseMs: pauseAfter(ctx.say),
    };
  }

  const r = await daemonSynth({ text: ctx.say, out, voice: v, rate: ctx.p.rate, pitch: ctx.p.pitch, volume: ctx.p.volume });
  if (r.ok && okAudio(out)) {
    EDGE_FAILS = { n: 0, until: 0, why: '' };      // 好了就清零，不记账
    const pauseMs = ctx.pad ? pauseAfter(ctx.say) : 0;
    return {
      ok: true, path: out, engine: 'edge', voice: v, bytes: fs.statSync(out).size,
      ms: ctx.now() - t0, truncated: ctx.truncated, cached: false, prosody: ctx.p, pauseMs, via: 'daemon',
    };
  }

  /* 常驻进程这条路断了（没 python / 没装包 / 崩了 / 卡死 / 连不上）——
   * 用同步那条再试一次。慢，但比"这一句没声"强。 */
  try { if (fs.existsSync(out)) fs.unlinkSync(out); } catch { /* 留着也不影响，会被覆盖 */ }
  const retry = oneEngineSync('edge', ctx);
  if (retry.ok) { EDGE_FAILS = { n: 0, until: 0, why: '' }; return { ...retry, via: 'spawn', fallback: r.error }; }

  EDGE_FAILS.n += 1;
  EDGE_FAILS.why = String(r.error || retry.detail || '失败').slice(0, 120);
  if (EDGE_FAILS.n >= EDGE_FAILS_TO_COOL) EDGE_FAILS.until = Date.now() + EDGE_COOLDOWN_MS;
  return { ok: false, detail: `${r.error || '常驻进程失败'}；再同步试一次也失败：${retry.detail}` };
}

/** 异步合成：edge 走常驻进程，每句快两秒左右。页面用这个。 */
export async function synthAsync(text, opts = {}) {
  const ctx = prepare(text, opts);
  if (ctx.err) return ctx.err;
  const tried = [];
  for (const id of ctx.list) {
    const r = id === 'edge' ? await oneEngineDaemon(ctx) : oneEngineSync(id, ctx);
    if (r.ok) return r;
    tried.push({ engine: id, detail: r.detail });
  }
  return noEngine(tried);
}

/** 哪个能用：只探"装没装"，不合成（合成太贵，不该在 health 里做）。
 *
 * 结果缓存 60 秒。为什么要缓存：探 edge 要起一个 python 去 import 包，
 * 那一下 1.8 秒——health 被前端轮询时，一个"看看有什么引擎"的请求
 * 不该花两秒。60 秒够短：装完包不用重启服务也能自己发现。 */
let PROBE_CACHE = null;
export function probeEngines({ maxAgeMs = 60000, now = Date.now } = {}) {
  if (PROBE_CACHE && now() - PROBE_CACHE.at < maxAgeMs) return PROBE_CACHE.list;
  const list = engineOrder().map(id => {
    const e = ENGINES[id];
    let ready = true, why = '';
    if (id === 'sapi') { ready = fs.existsSync(SAPI_PS1); why = ready ? '' : '缺 tools/tts-sapi.ps1'; }
    if (id === 'edge') {
      const hasScript = fs.existsSync(DAEMON_SCRIPT);
      const hasPkg = spawnSync(process.env.PYTHON || 'python', ['-c', 'import edge_tts'], { encoding: 'utf8', timeout: 15000, windowsHide: true }).status === 0;
      ready = hasScript && hasPkg;
      why = ready ? '' : !hasPkg ? '没装 edge-tts（python -m pip install edge-tts）' : '缺 tools/tts-edge-daemon.py';
    }
    if (id === 'stub') { ready = true; why = '不发声'; }
    return { engine: id, zh: e.zh, ready, why };
  });
  PROBE_CACHE = { at: now(), list };
  return list;
}

/* ---------------- 清理：缓存会一直长，得有人扫 ----------------
 * 为什么放在这里而不是 serve.mjs：这是"合成缓存"的规矩，和引擎是同一件事。
 * 两条红线：
 *   ① 只删本工具自己产出的 *.wav（文件名是 16 位十六进制 + .wav），别的一律不碰；
 *   ② 先按天数删，再按条数删。天数管"太旧"，条数管"一天之内刷了几万条"。
 * 返回 {removed, kept, bytes}，启动时打一行——删了多少要看得见。
 */
export function prune({ dir = TTS_DIR, keepDays = 7, maxFiles = 400, now = Date.now } = {}) {
  const out = { removed: 0, kept: 0, bytes: 0 };
  let names;
  try { names = fs.readdirSync(dir); } catch { return out; }
  const isOurs = n => /^[0-9a-f]{16}\.(wav|mp3)$/.test(n);
  const files = [];
  for (const n of names) {
    if (!isOurs(n)) continue;
    const p = path.join(dir, n);
    let st; try { st = fs.statSync(p); } catch { continue; }
    files.push({ p, n, mtime: st.mtimeMs, size: st.size });
  }
  const oldest = now() - keepDays * 86400e3;
  for (const f of files) {
    if (f.mtime < oldest) {
      try { fs.unlinkSync(f.p); out.removed += 1; } catch { /* 删不掉就留着 */ }
    }
  }
  const left = files.filter(f => f.mtime >= oldest).sort((a, b) => b.mtime - a.mtime);
  for (const f of left.slice(maxFiles)) {
    try { fs.unlinkSync(f.p); out.removed += 1; } catch { /* 同上 */ }
  }
  out.kept = Math.min(left.length, maxFiles);
  try {
    out.bytes = fs.readdirSync(dir).filter(isOurs)
      .reduce((n, x) => { try { return n + fs.statSync(path.join(dir, x)).size; } catch { return n; } }, 0);
  } catch { /* 算不出来就算了 */ }
  return out;
}
