/* 看图：一帧进，一句话出
 * ------------------------------------------------------------
 * 这一层只做一件事：把一张图变成**一句话**（外加不超过六个关键实体）。
 * 它不看屏幕、不截屏、不认识房间——截屏是桌面壳的事，投事件是感官的事。
 *
 * 五条界线，改之前先读：
 *   ① **图不进大脑。** 大脑是文字模型，每轮都带一张图等于每句话都贵十倍，
 *      而且"她在看屏幕"会从一件事变成一种常态。这里只把结论递过去。
 *   ② **不存图。** 图片只在内存里从 dataURL 走到请求体，中间不落盘、不进日志、
 *      不进返回值。要排障看的是"她说了什么"，不是"他屏幕上有什么"。
 *   ③ **不给坐标。** 和 REGIONS 同一条道理：给了坐标，模型就会开始算像素距离。
 *   ④ **不重试。** 视觉按图计费，失败就是失败；再试一次由人决定，
 *      因为"再看一眼"对隐私也不是免费的事。
 *   ⑤ **provider 可插拔。** 境外接口在这台机器上不通（代理 502），
 *      仓库写死一家就等于在别人机器上跑不起来。三家国内兼容 OpenAI 的 +
 *      Gemini 原生，差异全在下面这张表里，上层只认 describe()。
 *
 * 不依赖 three、不依赖 DOM：这个文件在 Node 里跑，测试直接 import。
 */
import { requestJSON } from './net-http.mjs';

/* 2.5 MB 解码后。1280 宽的 JPEG 大约 100–200 KB，这个上限留了十倍余量；
 * 超过它多半不是"缩过的截图"，而是有人把原图直接递进来了。 */
export const MAX_BYTES = 2.5 * 1024 * 1024;
export const MAX_SUMMARY = 120;      // 一句话的上限。超过就是"她在描述整个界面"，不是"看了一眼"
export const MAX_ENTITIES = 6;
export const MAX_ENTITY_CHARS = 16;

/* 只收这三种。gif 会动（一眼看一帧没有意义），bmp 太大，svg 能带脚本——
 * 虽然这张图不会进浏览器，但不收就不需要论证它安全。 */
const IMG_RE = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=\s]+)$/;

/* 把 dataURL 拆成"能不能用"。返回 null 就是不能用，调用方据此 400。
 * 这里不信 content-length：字符串长度和解码后字节数差 4/3，按字节算才是真的。 */
export function parseDataUrl(s) {
  if (typeof s !== 'string') return null;
  if (s.length > MAX_BYTES * 1.4 + 4096) return null;      // 先挡掉明显超大的，省得解析
  const m = IMG_RE.exec(s.trim());
  if (!m) return null;
  const base64 = m[2].replace(/\s+/g, '');
  const pad = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  const bytes = Math.floor((base64.length * 3) / 4) - pad;
  if (bytes <= 0 || bytes > MAX_BYTES) return null;
  return { mime: 'image/' + m[1], base64, bytes };
}

const clip = (s, n) => {
  /* 按码点截，不按 .length：不然一个 emoji 会被劈成两个半字符，
   * 那半个字符后面会变成 （U+FFFD），在字幕里就是一个黑方块。 */
  const cs = Array.from(String(s ?? '').replace(/\s+/g, ' ').trim());
  return cs.length > n ? cs.slice(0, n).join('') : cs.join('');
};

/* 模型给的永远不一定是 JSON。
 * 三种情况都要能收：干净的 JSON、包在 ```json 里的 JSON、以及"它就是不听话，
 * 回了一句人话"。第三种如果直接判失败，她会一句话都看不到——**降级比失败好**，
 * 但要标记 degraded，让上层知道这句话没经过结构校验。 */
export function readAnswer(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { ok: false, reason: 'empty', message: '模型什么都没回' };

  let body = raw;
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  if (fence) body = fence[1].trim();

  const a = body.indexOf('{');
  const b = body.lastIndexOf('}');
  let j = null;
  if (a >= 0 && b > a) { try { j = JSON.parse(body.slice(a, b + 1)); } catch { /* 下面走降级 */ } }

  if (!j || typeof j !== 'object' || Array.isArray(j)) {
    const first = raw.split('\n').map(x => x.trim()).find(Boolean) || '';
    const summary = clip(first, MAX_SUMMARY);
    if (!summary) return { ok: false, reason: 'empty', message: '模型回了空话' };
    return { ok: true, degraded: true, summary, entities: [], private: false };
  }

  const summary = clip(j.what ?? j.summary ?? j.description ?? j.text ?? '', MAX_SUMMARY);
  /* private 三种写法都见过：布尔、字符串、"是/否"。说的是"这一屏不该细看"，
   * 不是"我不看"——她照看，只是不往里念。 */
  const pv = j.private;
  const isPrivate = pv === true || pv === 1 || /^(true|yes|是|对)$/i.test(String(pv ?? ''));

  let list = j.entities ?? j.things ?? j.keys ?? [];
  if (typeof list === 'string') list = list.split(/[、,，;；\n]/);
  const seen = new Set();
  const entities = [];
  for (const x of Array.isArray(list) ? list : []) {
    const t = clip(x, MAX_ENTITY_CHARS);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    entities.push(t);
    if (entities.length >= MAX_ENTITIES) break;
  }

  if (!summary) {
    /* 只有实体没有一句话：拼一句，总比"什么都没有"强。这不是编造，
     * 是把已经看到的几样东西连起来陈述。 */
    if (!entities.length) return { ok: false, reason: 'no_content', message: '模型只回了空字段' };
    return { ok: true, degraded: true, summary: clip('屏幕上' + entities.join('、'), MAX_SUMMARY),
             entities, private: isPrivate };
  }
  return { ok: true, degraded: false, summary, entities, private: isPrivate };
}

/* ---------------- 提示词 ----------------
 * 三条要求写进话里，不靠"模型应该懂"：
 *   · 说"他在干什么"，不说"这个界面长什么样"——前者是她的视角，后者是一份说明书。
 *   · 不念屏幕上的字。这一条不是洁癖：截图里最常见的就是聊天、邮件、密码管理器。
 *   · 不给坐标、不猜屏幕外、不评价。
 */
export const SCREEN_PROMPT = `你在替一个住在电脑里的角色"看一眼"用户的屏幕。她只能拿到你写的这一句。

写什么：
- 一句话说清"他正在干什么"（例：他在写代码，屏幕上有一行红色的报错；他在看一个视频网站的首页）。
- 再说最多两样最显眼的东西：窗口名、页面标题、正在玩的游戏名、正在用的软件。
- 如果屏幕上主要是一个人脸/角色/插画（不是界面），就说"屏幕上是一张图，画的是……"。

不要写什么：
- 不要复述屏幕上的具体文字：聊天记录、邮件正文、文档内容、密码、密钥、身份证号、手机号一律不要念。
  如果屏幕上主要是这类内容，把 private 填 true，what 只写"一屏私人的东西，我没细看"。
- 不要给像素、坐标、尺寸、颜色代码。
- 不要猜屏幕外的事，不要评价他，不要提建议。
- 总共不超过 80 个字。

只输出 JSON，不要代码块，不要解释：
{"what":"一句话","entities":["最显眼的东西，最多两个"],"private":false}`;

/* ---------------- provider 表 ----------------
 * 三家国内接口都兼容 OpenAI 的 chat/completions，只有两处不一样：
 * 图片放哪儿、base64 要不要带 data: 前缀。智谱要纯 base64，通义要 dataURL。
 * Gemini 是另一套（contents/parts/inline_data），单独写。
 *
 * 默认模型挑的是**能免费跑**的那个：glm-4v-flash 免费，qwen-vl-plus 有免费额度，
 * gemini-2.5-flash 也有免费额度。这条不是省钱，是"clone 下来的人当天就能看见效果"。
 */
export const PROVIDERS = {
  zhipu: {
    label: '智谱',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4v-flash',
    keyName: 'ZHIPU_API_KEY',
    /* 智谱的 image_url 收纯 base64（也收 URL）；带前缀在部分版本上会 400。 */
    body: ({ model, text, base64 }) => ({
      model,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: base64 } },
          { type: 'text', text },
        ],
      }],
      max_tokens: 400,
      temperature: 0.2,
    }),
    text: j => j?.choices?.[0]?.message?.content ?? '',
  },
  dashscope: {
    label: '通义',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-vl-plus',
    keyName: 'DASHSCOPE_API_KEY',
    body: ({ model, text, dataUrl }) => ({
      model,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: dataUrl } },
          { type: 'text', text },
        ],
      }],
      max_tokens: 400,
      temperature: 0.2,
    }),
    text: j => j?.choices?.[0]?.message?.content ?? '',
  },
  gemini: {
    label: 'Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-2.5-flash',
    keyName: 'GEMINI_API_KEY',
    /* Gemini 的 key 在 query 上，不在 header 上。这不是我们选的，是它的接口形状。 */
    url: ({ baseUrl, model, key }) => `${baseUrl}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`,
    body: ({ model, text, mime, base64 }) => ({
      contents: [{ role: 'user', parts: [{ text }, { inline_data: { mime_type: mime, data: base64 } }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 400,
        responseMimeType: 'application/json',
        /* 2.5 默认先想一遍再答，看图这活儿不需要想——关掉省 1~3 秒。
         * 只有 2.5 系认这个字段，别的模型带上会 400，所以按名字判断。 */
        ...(/^gemini-2\.5/.test(String(model)) ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
      },
    }),
    text: j => (j?.candidates?.[0]?.content?.parts || []).map(p => p?.text || '').join(''),
  },
};

/* 选一个能用的：环境变量 > 传进来的 keys。
 * 顺序是"免费额度最稳的在前"，不是"名字好听的在前"。 */
export function pickProvider({ keys = {}, prefer = null, model = null, env = process.env } = {}) {
  const order = prefer ? [prefer] : ['zhipu', 'dashscope', 'gemini'];
  for (const id of order) {
    const p = PROVIDERS[id];
    if (!p) continue;
    const key = String(env[p.keyName] || keys[p.keyName] || '').trim();
    if (!key) continue;
    return { id, ...p, key, model: model || p.model };
  }
  return null;
}

/* ---------------- 真正发出去 ----------------
 * 只返回"能不能用"和"那句话"，不返回图的任何形式。
 * request 是注入点：测试传一个假的，就能把整条链路跑通，不花一分钱。
 */
export async function describe({ dataUrl, keys = {}, prefer = null, model = null, timeoutMs = 15000,
                                 request = requestJSON, env = process.env, prompt = SCREEN_PROMPT } = {}) {
  const t0 = Date.now();
  const img = parseDataUrl(dataUrl);
  if (!img) return { ok: false, reason: 'bad_image', message: '图不对：只收 png/jpeg/webp 的 dataURL，且不超过 2.5 MB' };

  const p = pickProvider({ keys, prefer, model, env });
  if (!p) {
    return { ok: false, reason: 'no_key', bytes: img.bytes, ms: Date.now() - t0,
             message: `没有能看图的密钥。填一个就行：${Object.values(PROVIDERS).map(x => x.keyName).join(' / ')}`
                      + `（${Object.values(PROVIDERS).map(x => x.label + ' ' + x.model).join('、')} 都有免费额度）` };
  }

  const url = p.url
    ? p.url({ baseUrl: String(env.VISION_BASE || '').trim() || p.baseUrl, model: p.model, key: p.key })
    : `${(String(env.VISION_BASE || '').trim() || p.baseUrl).replace(/\/$/, '')}/chat/completions`;

  const body = p.body({ model: p.model, text: prompt, mime: img.mime, base64: img.base64, dataUrl });

  let r;
  try {
    r = await request(url, {
      method: 'POST',
      headers: p.id === 'gemini' ? {} : { Authorization: 'Bearer ' + p.key },
      body,
      timeoutMs,
    });
  } catch (e) {
    return { ok: false, reason: 'net', provider: p.id, model: p.model, bytes: img.bytes,
             ms: Date.now() - t0, message: '连不上去：' + String(e.message || e) };
  }

  const ms = Date.now() - t0;
  if (r.status !== 200) {
    return { ok: false, reason: r.status === 429 ? 'rate_limited' : 'upstream', provider: p.id, model: p.model,
             status: r.status, bytes: img.bytes, ms,
             message: `上游 ${r.status}：` + String(r.text || '').slice(0, 300) };
  }

  const out = p.text(r.json);
  const ans = readAnswer(out);
  if (!ans.ok) {
    return { ok: false, reason: ans.reason, provider: p.id, model: p.model, bytes: img.bytes, ms,
             message: ans.message, detail: String(out).slice(0, 200) };
  }
  return {
    ok: true, ...ans, provider: p.id, model: p.model, bytes: img.bytes, ms,
    usage: r.json?.usage ?? null,
  };
}
