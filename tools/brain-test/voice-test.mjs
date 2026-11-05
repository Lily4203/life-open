/* 声音端口：有声音 / 没声音 / 被打断
 * ============================================================
 * 这一组测的是"哑了会不会出事"，不是"音质好不好"（音质断言测不出来）。
 *
 * 四条底线：
 *   1. 没有声音时，说话这件事本身不能失败（字幕照常，口型保持闭合，不假装在说）
 *   2. 服务端说不行，就别每句都再问一次（不然每句话多一次 503 往返）
 *   3. 一个人不能同时说两句（新的接上，旧的停掉）
 *   4. 口型来自波形，不来自文本（换语言不用改）
 *
 * 跑：node tools/brain-test/voice-test.mjs
 */
import { createVoice, levelFromWave, BACKENDS } from '../../js/brain/voice.mjs';

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
};
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name, `得到 ${JSON.stringify(a)}，要 ${JSON.stringify(b)}`);

/* ---- 假的音频上下文：不发声，只记"开始了几次、停了几次" ---- */
function fakeAudio({ amp = 150 } = {}) {
  const log = { started: 0, stopped: 0, decoded: 0, src: null, an: null };
  const ctx = {
    destination: {},
    async decodeAudioData(ab) { log.decoded += 1; return { duration: 0.8, size: ab.byteLength }; },
    createBufferSource() {
      const s = {
        buffer: null, onended: null,
        connect() { return this; },
        start() { log.started += 1; },
        stop() { log.stopped += 1; },
      };
      log.src = s;
      return s;
    },
    createAnalyser() {
      const a = {
        fftSize: 0,
        connect() { return this; },
        disconnect() {},
        getByteTimeDomainData(arr) { arr.fill(amp); },
      };
      log.an = a;
      return a;
    },
  };
  return { ctx, log };
}

/* ---- 假的服务端 ---- */
function fakeServer({ health = { ok: true, engines: [{ engine: 'sapi', ready: true }] }, tts = 200 } = {}) {
  const hits = [];
  const fetchImpl = async (url, opt = {}) => {
    hits.push({ url, body: opt.body ? JSON.parse(opt.body) : null });
    if (url.endsWith('/api/tts/health')) {
      return { ok: true, json: async () => health };
    }
    if (tts !== 200) {
      return {
        ok: false, status: tts,
        json: async () => ({ ok: false, reason: 'no_engine', message: '没有一个能出声的引擎（测试用）' }),
      };
    }
    return {
      ok: true, status: 200,
      headers: { get: () => '0' },
      arrayBuffer: async () => new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0]).buffer,
    };
  };
  return { fetchImpl, hits };
}

console.log('\nA. 波形 → 张嘴幅度');

{
  eq(levelFromWave(new Uint8Array([128, 128, 128, 128])), 0, 'A1 静音就是闭嘴');
  ok(levelFromWave(new Uint8Array([255, 0, 255, 0])) > 0.95, 'A2 满幅几乎全张');
  ok(levelFromWave(new Uint8Array([130, 126, 129, 127])) === 0, 'A3 底噪被吃掉，嘴不会一直抖');
  eq(levelFromWave(null), 0, 'A4 没数据不炸');
  /* 单调：响一点张得大一点 */
  const soft = levelFromWave(new Uint8Array([140, 116])), loud = levelFromWave(new Uint8Array([200, 56]));
  ok(loud > soft, 'A5 越响张得越大', `${soft} vs ${loud}`);
}

console.log('\nB. 关掉声音：说话照常，只是哑的');

{
  const { ctx, log } = fakeAudio();
  const levels = [];
  const v = createVoice({ backend: 'none', audio: ctx, onLevel: x => levels.push(x), fetchImpl: async () => { throw new Error('不该发请求'); } });
  const r = await v.speak('你好');
  eq(r.ok, false, 'B1 没有声音时 speak 返回失败');
  eq(r.reason, 'off', 'B2 失败原因说得出（不是静默）');
  eq(log.started, 0, 'B3 一遍都没播，也没假装播');
  eq(levels, [], 'B4 口型一次都没动（不演"在说话"）');
  eq(v.caps(), [], 'B5 能力表老实：没有 lipsync');
  ok(v.describe().includes('没有声音'), 'B6 describe 说人话', v.describe());
}

console.log('\nC. 服务端有声音：真的走了一遍');

{
  const { ctx, log } = fakeAudio();
  const { fetchImpl, hits } = fakeServer();
  const levels = [];
  let frames = 0;
  const v = createVoice({
    audio: ctx, fetchImpl, onLevel: x => levels.push(x),
    raf: cb => { if (frames++ < 3) cb(0); return frames; },
  });
  const r = await v.speak('我在这儿。');
  ok(r.ok, 'C1 合成 + 播放成功', JSON.stringify(r));
  eq(hits[0].url, '/api/tts/health', 'C2 先探一次有没有引擎');
  eq(hits[1].url, '/api/tts', 'C3 再请求合成');
  eq(hits[1].body.text, '我在这儿。', 'C4 送上去的是原话');
  eq(log.decoded, 1, 'C5 解了一次音频');
  eq(log.started, 1, 'C6 播了一次');
  ok(levels.length >= 2 && levels.at(-1) > 0.2, 'C7 播的时候有响度喂给口型', JSON.stringify(levels));
  eq(v.caps(), ['lipsync'], 'C8 有声音时才声称会口型');

  /* 播完：嘴必须闭上 */
  log.src.onended();
  eq(levels.at(-1), 0, 'C9 播完嘴闭上（不是一直张着）');
  eq(v.level(), 0, 'C10 level 归零');
  eq(v.stats().ok, 1, 'C11 记了一次成功');
}

console.log('\nD. 服务端没有引擎：说一次就够，别每句都问');

{
  const { ctx } = fakeAudio();
  const { fetchImpl, hits } = fakeServer({ health: { ok: false, engines: [{ engine: 'sapi', ready: false, why: '没有 ps1' }] } });
  const v = createVoice({ audio: ctx, fetchImpl });
  const r1 = await v.speak('第一句');
  eq(r1.ok, false, 'D1 出不了声');
  eq(r1.reason, 'no_voice', 'D2 原因分类是"没有声音"，不是"出错"');
  ok(String(v.reason()).includes('sapi'), 'D3 原因里带着"哪个引擎为什么不行"', v.reason());
  const before = hits.length;
  await v.speak('第二句');
  eq(hits.length, before, 'D4 第二句不再打网络（不重复问同一个问题）');
  ok(v.describe().includes('没有声音'), 'D5 describe 保持老实');
}

console.log('\nE. 合成中途翻车：不抛，记下来');

{
  const { ctx } = fakeAudio();
  const { fetchImpl } = fakeServer({ tts: 503 });
  const v = createVoice({ audio: ctx, fetchImpl });
  const r1 = await v.speak('试试');
  eq(r1.ok, false, 'E1 503 不往外抛');
  eq(r1.reason, 'no_voice', 'E2 归到"没有声音"这一类');
  ok(r1.message.includes('引擎') || r1.message.includes('出声'), 'E3 message 是人话', r1.message);
  const r2 = await v.speak('再试');
  eq(r2.ok, false, 'E4 之后直接不试了');
  eq(v.stats().failed, 1, 'E5 只记一次失败（不是每次说话都记）');
}

console.log('\nF. 一个人不能同时说两句话');

{
  const { ctx, log } = fakeAudio();
  const { fetchImpl } = fakeServer();
  let frames = 0;
  const v = createVoice({ audio: ctx, fetchImpl, raf: cb => { if (frames++ < 2) cb(0); return frames; } });
  const r1 = await v.speak('第一句');
  eq(log.started, 1, 'F1 第一句在播');
  /* 逐句说话（流式）时，下一句要等这一句真的播完。
   * duration 是估算，onended 才是真的——所以 speak 要把"播完了"这个信号交出去。 */
  ok(r1.done && typeof r1.done.then === 'function', 'F1b 带一个 done：谁要等它播完，有得等');
  const r = await v.speak('第二句');
  ok(r.ok, 'F2 第二句照样能说');
  eq(log.stopped >= 1, true, 'F3 第一句被停掉（不叠在一起）');
  eq(log.started, 2, 'F4 第二句开始播');
  v.stop();
  eq(v.level(), 0, 'F5 stop 之后嘴立刻闭上');
}

console.log('\nG. 传空话不发请求');

{
  const { ctx } = fakeAudio();
  const { fetchImpl, hits } = fakeServer();
  const v = createVoice({ audio: ctx, fetchImpl });
  const r = await v.speak('   ');
  eq(r.ok, false, 'G1 空字符串不算一句话');
  eq(hits.length, 0, 'G2 一个请求都没发');
  eq(v.stats().asked, 0, 'G3 也不算一次"问过"');
}

console.log(`\n${fail === 0 ? '全过' : '有失败'}：${pass} 过，${fail} 不过\n`);
process.exit(fail ? 1 : 0);
