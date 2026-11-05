/* QQ 外线（NapCat / OneBot 11 正向 WebSocket）——骨架，不是成品
 * ------------------------------------------------------------
 * 下划线开头 = 不自动加载。要真接：
 *   1. 装 NapCat（https://github.com/NapNeko/NapCatQQ），用小号扫码登一次
 *   2. 在 NapCat 的网络配置里开「WebSocket 服务器」，端口 3001，设一个 token
 *   3. 复制本文件成 qq.mjs，把下面三个环境变量填上，重启服务
 *        QQ_WS=ws://127.0.0.1:3001   QQ_TOKEN=你设的   QQ_GROUPS=群号1,群号2
 *   4. curl /api/health 看 adapters 里 qq 是不是 started
 *
 * 只做了收。发回群里要另一条下行通道（现在没有，见文件末尾）。
 *
 * ⚠ 风控：模拟器/新设备/异地登录几乎一定触发验证，别拿主号第一次就上。
 */

const URL_BASE = process.env.QQ_WS || 'ws://127.0.0.1:3001';
const TOKEN = process.env.QQ_TOKEN || '';
/* 群号白名单。不配 = 所有群都收——她会突然听见一堆陌生人在说话，
 * 而且那些人不知道自己在跟谁说话。默认应该只收你指定的。 */
const GROUPS = String(process.env.QQ_GROUPS || '').split(',').map(s => s.trim()).filter(Boolean);

let ws = null;
let timer = null;
let tries = 0;
let stopped = false;
const seen = { got: 0, groups: 0, skipped: 0, errors: 0 };
let lastErr = null;

/* 把 OneBot 的 message 段拼成一句人话。
 * 图片/表情不解释内容——看得懂就说看得懂，看不懂就记"图"，别猜。 */
function flatten(segs) {
  if (!Array.isArray(segs)) return String(segs || '');
  const out = [];
  for (const s of segs) {
    if (!s || typeof s !== 'object') continue;
    if (s.type === 'text') out.push(String(s.data?.text || ''));
    else if (s.type === 'image') out.push('[图片]');
    else if (s.type === 'face') out.push('[表情]');
    else if (s.type === 'record') out.push('[语音]');
    else if (s.type === 'at') out.push('@' + (s.data?.qq === 'all' ? '全体' : s.data?.qq || ''));
    /* 其它类型直接丢：一条读不懂的 JSON 塞进她记忆，比不记更坏。 */
  }
  return out.join('').replace(/\s+/g, ' ').trim();
}

function connect(send) {
  if (stopped) return;
  const url = TOKEN ? `${URL_BASE}?access_token=${encodeURIComponent(TOKEN)}` : URL_BASE;
  try { ws = new WebSocket(url); }
  catch (e) { lastErr = '连不上：' + (e.message || e); schedule(send); return; }

  ws.onopen = () => { tries = 0; lastErr = null; console.log('[qq] 连上了 ' + URL_BASE); };

  ws.onmessage = ev => {
    let d;
    try { d = JSON.parse(ev.data); } catch { seen.errors += 1; return; }
    if (d.post_type !== 'message') return;          // 心跳、通知、请求，都不进她的记忆
    seen.got += 1;

    const isGroup = d.message_type === 'group';
    if (isGroup) {
      if (GROUPS.length && !GROUPS.includes(String(d.group_id))) { seen.skipped += 1; return; }
      seen.groups += 1;
    }

    const text = flatten(d.message ?? d.raw_message);
    if (!text) { seen.skipped += 1; return; }

    const nick = d.sender?.card || d.sender?.nickname || String(d.user_id || '');
    send({
      text,
      /* guest:qq12345 —— 号在，她就能分清"同一个人这次和上次"。
       * 别用昵称当身份：群里三个人都能叫"鱼"。 */
      from: 'qq' + (d.user_id || 'unknown'),
      name: nick,
      source: isGroup ? 'group' : 'script',
      /* 这句话在她世界里从哪来。她读到的是 [小明·手机上的 QQ]。
       * 写成"手机上的 QQ"而不是"QQ"：装置和软件是两件事，
       * 她要能说"我手机上那个群里"，而不是干巴巴一个软件名。 */
      where: '手机上的 QQ',
    });
  };

  ws.onerror = () => { seen.errors += 1; };   // onclose 一定会跟着来，错误信息在那儿说
  ws.onclose = () => { ws = null; if (!stopped) schedule(send); };
}

/* 断线重连：1s、2s、4s…最多 30s。
 * 不重连的话，NapCat 重启一次她这条线就永久哑了，而且没人看得出来。 */
function schedule(send) {
  if (stopped || timer) return;
  tries += 1;
  const wait = Math.min(1000 * 2 ** Math.min(tries - 1, 5), 30e3);
  lastErr = `断开，${Math.round(wait / 1000)} 秒后重连（第 ${tries} 次）`;
  timer = setTimeout(() => { timer = null; connect(send); }, wait);
}

export default {
  id: 'qq',
  label: 'QQ',
  where: '手机上的 QQ',

  start(send) {
    stopped = false;
    connect(send);
    return { ok: true };
  },

  stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    try { ws?.close(); } catch { /* 关不掉就算了 */ }
    ws = null;
  },

  state() {
    return {
      connected: ws?.readyState === 1,
      groups: GROUPS.length ? GROUPS : '全部',
      ...seen, lastErr,
    };
  },
};

/* ---- 还缺的那一条：她说话，回到群里 ----
 *
 * 现在只有"入"。要真互动，得有一条下行，而且**不能是"她每句话都发出去"**——
 * 她自言自语、她跟他说的话，都不该出现在群里。
 *
 * 形状应该是：她自己选"要对那个群里说一句"（一个新的动作，比如
 * send_to { to:'qq', text }），执行层把它交给这条线的 say(text, meta)。
 * 也就是说：先有动作，再有通道；反过来做，等于给她装了一个自动转发。
 *
 * NapCat 那边一行就够（OneBot 11）：
 *   ws.send(JSON.stringify({ action:'send_group_msg', params:{ group_id, message:text } }))
 * 卡的不是协议，是"什么时候该发"这个决定该她做、还是我们替她做。
 */
