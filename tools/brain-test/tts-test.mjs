/* 合成这一侧：文本清洗 / 截断 / 引擎表 / 缓存 / 失败要说清
 * ============================================================
 * 这一组不联网、不发声：用 stub 引擎（造一段静音 wav）验"管道通不通"。
 * 真出声那一步只能在有系统语音的机器上验，断言证明不了音质。
 *
 * 跑：node tools/brain-test/tts-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { synth, cleanText, fitText, engineOrder, ENGINES, probeEngines, MAX_CHARS } from '../../tools/tts.mjs';

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
};
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name, `得到 ${JSON.stringify(a)}，要 ${JSON.stringify(b)}`);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-test-'));

console.log('\nA. 送进合成之前先把话洗干净');

{
  eq(cleanText('**好**'), '好', 'A1 去掉 markdown 星号');
  eq(cleanText('嗯（笑）好'), '嗯 好', 'A2 括号里的动作不念出来');
  /* 代码块整块丢掉，不是只丢围栏：念"坐下"跟念一堆 JSON 一样没意义。 */
  eq(cleanText('```\n坐下\n```'), '', 'A3 代码块整块不念');
  eq(cleanText('  多   空   格  '), '多 空 格', 'A4 空白收成一个');
  eq(cleanText(null), '', 'A5 null 不炸');
}

console.log('\nB. 太长就在句号处截断');

{
  const short = fitText('我在这儿。');
  eq(short.text, '我在这儿。', 'B1 短句原样');
  eq(short.truncated, false, 'B2 没截就说没截');

  const long = '啊'.repeat(MAX_CHARS) + '多出来的。';
  const r = fitText(long);
  ok(r.text.length <= MAX_CHARS, 'B3 不超过上限', String(r.text.length));
  eq(r.truncated, true, 'B4 截了就要标记出来');

  /* 截在标点后，不要截在字中间 */
  const withPunct = '这是一个很长的句子。'.repeat(40);
  const r2 = fitText(withPunct);
  ok(/[。！？，]$/.test(r2.text), 'B5 截在标点上（不在字中间切）', r2.text.slice(-6));
}

console.log('\nC. 试哪个引擎，顺序要说得清');

{
  const old = process.env.LIFE_TTS;
  delete process.env.LIFE_TTS;
  /* 顺序不是随手排的：edge 是神经音色（像人），sapi 是 2009 年的拼接音（像导航）。
   * 之前 sapi 在前，房间里听到的一直是那个播报腔——换声音这件事，一半就坏在顺序上。 */
  eq(engineOrder(), ['edge', 'sapi'], 'C1 默认先神经音色，本机那个留着救急');
  eq(engineOrder()[0], 'edge', 'C1b 第一个就是像人的那个（不是"能出声就行"）');
  process.env.LIFE_TTS = 'stub';
  eq(engineOrder(), ['stub'], 'C2 环境变量能指定（排障用）');
  delete process.env.LIFE_TTS;
  eq(engineOrder('sapi')[0], 'sapi', 'C3 点名要哪个就先试哪个');
  ok(engineOrder('sapi').includes('edge'), 'C4 失败了还能退回另一个（不是非黑即白）');
  if (old === undefined) delete process.env.LIFE_TTS; else process.env.LIFE_TTS = old;
}

console.log('\nD. 真走一遍合成（stub：不发声，只验管道）');

{
  const r = synth('我在这儿。', { engines: ['stub'], dir: TMP });
  ok(r.ok, 'D1 合成成功', JSON.stringify(r));
  eq(r.engine, 'stub', 'D2 用的是指定的引擎');
  ok(fs.existsSync(r.path), 'D3 wav 真落盘了');
  const head = fs.readFileSync(r.path).subarray(0, 4).toString('ascii');
  eq(head, 'RIFF', 'D4 是合法的 wav（不是空文件改个名）');
  eq(r.cached, false, 'D5 第一次不是缓存');
  eq(r.truncated, false, 'D6 短句没被截');

  const again = synth('我在这儿。', { engines: ['stub'], dir: TMP });
  eq(again.cached, true, 'D7 同一句话第二次直接拿缓存');
  eq(again.path, r.path, 'D8 同一个文件');
  eq(again.ms, 0, 'D9 缓存不花时间');
}

console.log('\nE. 出不来就说清为什么');

{
  const r = synth('随便说一句', { engines: ['不存在的引擎'], dir: TMP });
  eq(r.ok, false, 'E1 引擎不存在时返回失败，不抛');
  eq(r.reason, 'no_engine', 'E2 原因分类明确');
  ok(String(r.message).includes('试过'), 'E3 message 里写着"试过哪些"', r.message);

  const e = synth('   ', { engines: ['stub'], dir: TMP });
  eq(e.ok, false, 'E4 空话不合成');
  eq(e.reason, 'empty', 'E5 原因说得出');
  eq(e.tried, [], 'E6 而且没有白试一遍引擎');
}

console.log('\nF. 引擎表与探测');

{
  ok(['sapi', 'edge', 'stub'].every(k => ENGINES[k]), 'F1 三个引擎都在表里');
  const list = probeEngines();
  ok(Array.isArray(list) && list.length >= 1, 'F2 探测返回一张表');
  ok(list.every(x => typeof x.ready === 'boolean' && typeof x.why === 'string'), 'F3 每项都说"能不能用、为什么"');
  /* 探测不许为了回答"能不能用"就去合成一遍（太贵） */
  ok(list.every(x => !('path' in x)), 'F4 探测不合成');
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '全过' : '有失败'}：${pass} 过，${fail} 不过\n`);
process.exit(fail ? 1 : 0);
