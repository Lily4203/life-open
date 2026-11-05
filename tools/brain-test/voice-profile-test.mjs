/* 声音像不像人：音色 / 语速起伏 / 句尾呼吸
 * ============================================================
 * 这一组不联网、不发声。它验的不是"好不好听"（那个只能耳朵判断），
 * 而是**"机器感是从哪来的"这几个具体来源有没有被处理掉**：
 *
 *   ① 音色是不是神经音色（不是 Windows 那个拼接音）
 *   ② 每句是不是同一个速度（匀速是最强的机器感）
 *   ③ 同一句是不是每次都算得不一样（那样缓存全废，每说一遍花一遍钱）
 *   ④ 句尾有没有留空（机器是一串连着的）
 *   ⑤ 情绪会不会真的改变念法（而不是只在 UI 上换个表情）
 *
 * 跑：node tools/brain-test/voice-profile-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PERSONA, MOODS, MOOD_NAMES, prosody, pauseAfter, stableUnit } from '../../tools/voice-profile.mjs';
import { silentWav, okAudio, extOf } from '../../tools/tts.mjs';

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  → ' + extra : ''}`); }
};
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name, `得到 ${JSON.stringify(a)}，要 ${JSON.stringify(b)}`);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-test-'));

console.log('\nA. 音色本身：这是"像不像人"的大头');

{
  ok(/Neural$/.test(PERSONA.voice), 'A1 是神经音色（以 Neural 结尾）', PERSONA.voice);
  ok(/^zh-CN-/.test(PERSONA.voice), 'A2 是中文（不是英文音色念中文）', PERSONA.voice);
  /* 下面这几个是 Windows 自带的拼接音。它们不是"差一点"，是另一种东西：
   * 逐字拼接、没有韵律模型，怎么调语速都是导航播报。 */
  ok(!/Huihui|Kangkang|Yaoyao/i.test(PERSONA.voice), 'A3 不是 Windows 自带的那个拼接音', PERSONA.voice);
  ok(/^[a-z]{2}-[A-Z]{2}-[A-Za-z]+Neural$/.test(PERSONA.voice), 'A4 音色名是合法格式（拼错会 400）', PERSONA.voice);
}

console.log('\nB. 语速不是一刀切');

{
  const base = PERSONA.rate;
  const shortp = prosody('嗯。');
  const longp = prosody('我今天在窗边站了很久，看着外面那棵树，想了些自己也说不清的事情，然后就回来了。');
  ok(shortp.rateNum < longp.rateNum, 'B1 短句比长句慢（人说长句会赶）',
    `短 ${shortp.rateNum}% / 长 ${longp.rateNum}%`);
  ok(shortp.rateNum !== base || longp.rateNum !== base, 'B2 至少有一头偏离了基础语速');
  ok(/^[+-]\d+%$/.test(longp.rate), 'B3 给引擎的格式是 +N%（edge 只认这个）', longp.rate);
  ok(/^[+-]\d+Hz$/.test(longp.pitch), 'B4 音高格式是 +NHz', longp.pitch);
}

console.log('\nC. 每句自带起伏，但必须算得一样');

{
  const a = prosody('你回来啦。');
  const b = prosody('你回来啦。');
  eq(a.rate, b.rate, 'C1 同一句话两次结果完全一样（否则缓存全废）');
  eq(a.pitch, b.pitch, 'C2 音高也一样');

  /* 找两句肯定不同的话，确认抖动的确不同——否则"起伏"就是假的。 */
  const x = prosody('今天天气不错。');
  const y = prosody('这个我不太懂。');
  ok(x.rateNum !== y.rateNum || Math.abs(x.wobble - y.wobble) > 0,
    'C3 不同句子的起伏不一样', `${x.wobble} vs ${y.wobble}`);

  const u = stableUnit('同一句话');
  eq(u, stableUnit('同一句话'), 'C4 抖动源本身是确定的');
  ok(Math.abs(u) <= 1, 'C5 抖动在 -1..1 之内');
}

console.log('\nD. 情绪真的会换口气');

{
  const text = '我知道了。';
  const happy = prosody(text, { mood: 'happy' });
  const sad = prosody(text, { mood: 'sad' });
  const plain = prosody(text);

  ok(happy.rateNum > plain.rateNum, 'D1 高兴比平常快', `${happy.rateNum} vs ${plain.rateNum}`);
  ok(sad.rateNum < plain.rateNum, 'D2 难过比平常慢', `${sad.rateNum} vs ${plain.rateNum}`);
  ok(happy.pitchNum > sad.pitchNum, 'D3 高兴比难过亮', `${happy.pitchNum} vs ${sad.pitchNum}`);
  ok(MOOD_NAMES.length === 5, 'D4 五档情绪都有定义', MOOD_NAMES.join(','));
  ok(Object.keys(MOODS).every(k => MOODS[k].zh), 'D5 每档都写了人话说明');

  const unknown = prosody(text, { mood: '莫名的情绪' });
  eq(unknown.mood, null, 'D6 不认识的情绪当没有（不猜）');
  eq(unknown.rate, plain.rate, 'D7 而且不会偷偷改语速');

  /* 只加一次，不叠乘：情绪不该把语速推到听不清。 */
  ok(Math.abs(prosody('啊。'.repeat(60), { mood: 'surprised' }).rateNum) <= 60,
    'D8 超长句子 + 强烈情绪也不会突破 ±60%');
  ok(Math.abs(prosody('嗯', { mood: 'surprised' }).pitchNum) <= 25,
    'D9 音高不会突破 ±25Hz（再高就换人了）');
}

console.log('\nE. 句尾留多长的空');

{
  ok(pauseAfter('你回来了。') > 0, 'E1 句号后面有停顿');
  ok(pauseAfter('你回来了吗？') > pauseAfter('你回来了。'), 'E2 问句停得比陈述句长（在等你回答）');
  ok(pauseAfter('我想想……') > pauseAfter('你回来了。'), 'E3 省略号最长（在想）');
  ok(pauseAfter('快看！') < pauseAfter('你回来了。'), 'E4 叹号最短（急着往下说）');
  eq(pauseAfter(''), 0, 'E5 空话不补停顿');
  eq(pauseAfter('没有句末标点'), 120, 'E6 没标点的（被硬切的半句）留得短，别听着像说完了');
}

console.log('\nF. 音频格式：别把 mp3 当 wav 存');

{
  /* 这一组是给一个真踩过的坑立的桩：
   * edge 的接口固定回 mp3，曾经被当成裸 PCM 套了一个 wav 头——
   * RIFF 是对的、字节数是对的、校验全过，播出来是噪声。
   * 所以校验必须"按后缀认格式"，不能只看文件够不够大。 */
  const mp3 = Buffer.concat([
    Buffer.from([0xFF, 0xF3, 0x64, 0xC4, 0x00, 0x00, 0x00, 0x03]),
    Buffer.alloc(3000, 7),
  ]);
  const wav = silentWav(0.4);

  const asMp3 = path.join(TMP, 'a.mp3');
  fs.writeFileSync(asMp3, mp3);
  ok(okAudio(asMp3), 'F1 真 mp3 认得出（0xFF 帧同步）');

  const asWav = path.join(TMP, 'a.wav');
  fs.writeFileSync(asWav, mp3);
  ok(!okAudio(asWav), 'F2 同样的字节叫 .wav 就不认（这就是那个坑）');

  const realWav = path.join(TMP, 'b.wav');
  fs.writeFileSync(realWav, wav);
  ok(okAudio(realWav), 'F3 真 wav 认得出（RIFF）');

  const junk = path.join(TMP, 'c.mp3');
  fs.writeFileSync(junk, Buffer.concat([Buffer.from('{"error":"quota"}'), Buffer.alloc(2000)]));
  ok(!okAudio(junk), 'F4 一段 JSON 错误不当成音频（否则这句永远是嘶声）');

  const tiny = path.join(TMP, 'd.mp3');
  fs.writeFileSync(tiny, Buffer.from([0xFF, 0xF3, 0, 0]));
  ok(!okAudio(tiny), 'F5 太小的不算（连一个帧都没有）');

  ok(!okAudio(path.join(TMP, '不存在.mp3')), 'F6 文件不存在时返回失败，不抛');

  /* 引擎产出什么格式是一张表明说的：换了引擎不改这里，会把 mp3 存成 .wav。 */
  eq([extOf('edge'), extOf('sapi'), extOf('stub')], ['mp3', 'wav', 'wav'], 'F7 每个引擎的格式都写明了');
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '全过' : '有失败'}：${pass} 过，${fail} 不过\n`);
process.exit(fail ? 1 : 0);
