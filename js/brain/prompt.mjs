/* 提示词：把"启动块 + 记忆用法 + 动作表"拼成一条系统消息，再把回话解析成 say / read / remember / forget / do
 * ------------------------------------------------------------
 * 两条规矩来自前面 64 个实验（s01…s4x），不是想象：
 *   ① 只有他说的那句需要冒号。把整段处境都写成对话，她反而不会动了（s16）。
 *   ② 动作必须"做什么+对谁"，只给名字不给目标，控制感是假的（结果-31）。
 *
 * 第三处（2026-11-05 改）：记忆的用法写进提示词，索引由 memory.boot() 给。
 *   原来我们替她挑三条记忆塞进去，等于外置算法决定她想起什么；现在只给索引，
 *   看不看正文她自己说（read），记不记也她自己说（remember）。
 *
 * 输出用 JSON，但**不要求她整段只说 JSON**——先剥代码围栏、再取最外层花括号，
 * 解析失败就把原文当话，do 记空。宁可少动一下，不可因为格式崩掉。
 */

/* 时间差说成人话。为什么要说"多久以前"而不是毫秒：
 * 她判断"这件事值不值得再说一遍"，靠的正是"刚说过"这件事本身。 */
function ago(ms, at) {
  const t = Number(ms);
  if (!Number.isFinite(t) || !t) return '刚才';
  const s = Math.max(0, (Number(at) || Date.now()) - t) / 1000;
  if (s < 3) return '刚才';
  if (s < 60) return `${Math.round(s)} 秒前`;
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  return `${Math.round(s / 3600)} 小时前`;
}

/* 记忆纪律这几句是从 AIRI 的 composeMemoryPrompt 学来的，逐条都对得上一种坏法：
 *   - "索引一句话就说全的，不用看正文" → 否则每条都去 read，一轮四跳
 *   - "改一条要带 id 重写，不要新开近似的" → 否则同一件事写成三条，索引越来越长
 *   - "大多数轮次什么都不用记" → 否则她把每句寒暄都存下来，索引三个月就废了
 *   - "不记密码/口令" → 这条不用解释
 * 不能只写在工具描述里：我们没有 function calling，工具说明就是提示词的一部分。 */
const MEMORY_HOWTO = [
  '## 记忆怎么用',
  '上面那份是索引，每条一句话。要用到哪条，就把它填进 read，我再把正文给你。',
  '索引那一句已经把事说全了，就不用 read。',
  '只在有人让你记住、或他说了一句长期有效的话时 remember；一次一条，别把两件事并成一条。',
  '要改一条，带着它的 id 重写；不要新开一条差不多的。写错了、或他让你忘掉，用 forget 带 id。',
  '密码、口令、别人的隐私，不记。你自己的规矩不记——你已经在设定里了。',
  '大多数时候什么都不用记。',
].join('\n');

/* 议程的用法。这一块是"自主"真正的入口：没人吩咐的时候，她自己决定要做什么。
 * 为什么写这么多条限制：给她一个能装 100 条的清单，她会开始往回填，
 * 三天后这份文件就变成一份"永远做不完的待办"，每次开机都在提醒她欠着事——
 * 那不是自主，那是我们给她造了一个焦虑源。 */
const AGENDA_HOWTO = [
  '## 手上的事',
  '你随时可以给自己记一条想做的事（plan），不用等人吩咐。写的时候只写**你在这屋里做得到的一步**：',
  '走过去看看、坐下、把灯打开、问他一句。写"去外面"这种做不到的，只会一直挂着。',
  '一次最多两条。写过的事别重复写；改主意就带 id 改那一条。',
  '做完了把它的 id 填进 done。做不成、或者你已经不想做了，也划掉——别让一件事永远挂在那儿。',
  '这不是待办清单：他没让你做的事，你不必替他记；你不想做的事，一条都不要写。',
].join('\n');

export function buildSystem({ boot, registry, entities = null, avatar = null, extra = '', styleText = '' } = {}) {
  const blocks = (boot?.blocks || []).filter(b => b.text && b.text.trim());
  const head = blocks.map(b => b.text.trim()).join('\n\n');
  // describeAll() 已经是窗口感知的：窗口开着就只列窗口里的那几条
  const actsText = registry?.describeAll ? String(registry.describeAll()).trim() : '';
  // 屋子里的东西必须点名给 id：只写"chair|bed 的 id"，模型会自己编一个 chair（第一次真跑就是这么失败的）
  const entText = (entities || []).filter(e => e && e.id).map(e => `${e.id}（${e.label || e.kind}）`).join('、');

  /* 窗口：屋子这次只放开了几件。标题要跟着改——写"你能做的"再只给两件，
   * 她会以为自己被削了权；写"这次能做的"，那是场景，不是限制。 */
  const win = registry?.windowInfo?.() || null;
  const actsHead = win ? '## 这次能做的（只有这几件）' : '## 你能做的';
  const actsBody = actsText || '（这间屋子暂时没给你动作，你只能说话）';

  return [
    head,
    '',
    MEMORY_HOWTO,
    AGENDA_HOWTO,
    entText ? '## 这屋里现在有什么\n' + entText : '',
    actsHead + '\n' + actsBody,
    /* 这具身体能做什么，得她自己知道。不写这一块，她会答"我给你跳个舞"，
     * 而这个模型连手臂都没有——那不是她撒谎，是我们没告诉她。 */
    avatar?.describe ? '## 你这具身体\n' + avatar.describe() : '',
    win?.note ? `（${win.note}）` : '',
    extra ? '\n' + extra : '',
    /* 说话的样子（style.mjs 算出来的）：她最近几句的原话、哪个开头用滥了、哪句撞了前面的。
     * 位置在"怎么回"**之前**：这是"说什么"的事，下面是"怎么写"的事。
     * 顺序反了，格式要求会盖过内容要求——她就会为了把 JSON 写对而随便说一句。
     * 没毛病时这一块是空串，一个字都不占（常驻的"注意风格"提示等于给她派了个活）。 */
    styleText ? '\n' + styleText : '',
    '',
    '## 怎么回',
    /* 上游的结构化输出（response_format: json_object）有一个硬前提：
     * prompt 里必须出现 json 这个词，并且给一个格式示例。所以这一行同时写小写 json 和大写 JSON，
     * 而且把唯一容易出错的地方说死：对象**外面**不许有字。
     * 真跑里那些"先来一句散文再给 JSON"，全都是因为这一条没写死。 */
    '每一句都必须是下面这个 json 对象（JSON）——包括闲聊、包括你只是应一声。',
    '字只写在 say 里面；对象外面别的字一个都不要有，不要解释、不要开场白、不要代码块。',
    '{"say":"你要说的话","mood":"happy","read":[],"remember":[],"forget":[],"plan":[],"done":[],"do":[{"do":"动作名","to":"目标 id"}]}',
    /* 长度这条改过一版，原因写在待办里：原来写"话最多两句，一句一行"，
     * 加上 identity 里那句"一句一行，几个字"，她把这当成**格式**执行——
     * 303 句里平均 12.3 字，8% 是"在。"这种两字回复。
     * 现在的写法把长短交回给她：跟着事情走，不跟着格式走。 */
    '长短跟着事走：只是应一声就一个字，真有话说就说几句；别为了让格式好看而说长，也别为了短而省掉要说的。',
    /* 沉默是合法的一种回法（2026-11-05 补）。
     * 原来这里只写了"每一句都必须是 json"，加上 chat-in 每一批都叫醒她，
     * 结果群里两个人聊吃的，她也凑一句"你们俩聊吃的"。不是她话多，是没人告诉她"这可以不说"。
     * 只给事实（谁在说）和许可（可以不接），不给"什么算没意思"——兴趣是她的事。 */
    '不是每句话都要接。带 [名字] 开头的是别人在说，不一定是对你说的：听着没意思、或者插不上嘴，'
      + '就不接——say 写空字符串、do 写 []，那也是回话（听见了，没接）。',
    /* 来源贴在那句话上（[小明·手机上的 QQ]）。只解释符号，不解释"该怎么对待"——
     * 要不要因为"这是手机里的"而换个说法，是她的事。 */
    '名字后面带一个 ·，是这话从哪儿来的；没有 · 就是他在屋里跟你说的。',
    '没有名字开头的是他本人在跟你说话，那句要回。沉默不是躲开难接的话。',
    '一句话一行。不想动就写 "do":[]。一次最多两个动作。',
    /* 标记：话里的停顿。这是"说话"不是"描述"——她写【停】就是真停 0.6 秒，
     * 不是嘴上说"我停了一下"。可用词表在 style.mjs 的 MARKS 里，两边必须一致。
     * 只有这一个：表情走 mood、做事走 do，缺的只有"话说一半停一下"。
     * 【笑】这种没写进来，不是没想到——TTS 做不出来，写了就是在字幕上假装。 */
    '话里可以插【停】，就是真的停半秒再说；插在你本来会顿一下的地方，别每句都插。',
    '不要解释这个标记，也不要在话外面写旁白（"（她笑了一下）"这种不要）。',
    /* P5：情绪是"落款"，不是第四个通道。
     * 给她一张五个词的词表，是因为身体只有五种表情——让她自由写"心花怒放"，
     * 端口认不出来，等于白写。词表限制的是**表达**，不是**感受**：她照样可以说得很细。
     * 明确写"不写就不改"，否则她会每句都填一个，表情一分钟变十次。 */
    /* 真跑第一次：8 轮全写 "relaxed"。模型把"字段存在"当成了任务，于是每句都填同一个值——
     * 结果表情从头到尾没变过，等于没做。所以这一句的重点不是"有这个字段"，
     * 而是"**大多数时候不写**"，再给一组对照，让它知道什么时候该变。 */
    'mood 只在情绪**明显**的时候写，从 happy / angry / sad / relaxed / surprised 里挑一个；'
      + '大多数话是不写的——不写不是没情绪，是"说这句时脸上不用变"。',
    '听到好事→happy；被冒犯→angry；真的低落→sad；惊到了→surprised；松下来→relaxed。'
      + '它是落款，不是动作：不要为了填它把 say 里的话说浅。',
    /* 真跑踩到过两次：一次是"已经在上头了，坐着呢"而人还站着，一次是四个明确的动作请求
     * 一个都没做。两次都是同一个毛病——只在 say 里答应，do 空着。
     * 这句只说明"答应了就要做"，不规定她做什么：做不做、做哪件，还是她的判断。 */
    '他说要你做什么、或者你自己想做，就把动作填进 do。只在 say 里答应、do 空着，等于没做。',
    '要查记忆就直接把 id 写进 read，不要用文字说"我去翻翻"；那句话我收不到，查不了。',
    'read 填索引里的 id，比如 ["m3"]；不用就写 []。',
    'remember 每条 {"id":null,"desc":"一句话索引","body":"正文"}；改旧的就把 id 填上。',
    'plan 每条 {"id":null,"text":"想做的事","next":"下一步"}；done 填议程里的 id，比如 ["a3"]。',
    'to 只能填「这屋里现在有什么」里列出的 id，要带序号（chair:1），不能只写 chair。',
    win ? 'do 只能填「这次能做的」里列出的动作；想做别的，就先用话说明。' : '',
    /* P2：她是可以被叫住的，而且叫住这件事要她自己解释。
     * 这里只陈述"发生了什么"，不写"你应该继续走完"——那是替她决定。
     * 两种错法都堵住：说成没发生（她会以为自己到了），说成失败（她下次不试了）。 */
    '回执里可能出现"走到一半停下来了"：那是他叫住了你，脚步停在半路——不在原处，也没到那儿。',
    '接着走完，还是先放下，你自己定；别因为被叫住就说自己已经做到了。',
    '做不到的事不要假装做到——没做就说没做。',
    /* 真跑抓到过：她回"已经在上头了，坐着呢"，而状态是站着、do 是空的。
     * 上一轮那条 already_stand 事件被她当成了"我坐过"。所以姿势只能以系统给的为准。
     * 这条放在**最末尾**再核对一遍：模型对末尾的注意力最实，埋在中间那句它会跳过。 */
    boot?.pose ? `（最后核对一遍：你现在${boot.pose}。你刚才嘴上说过什么都不改变它。）` : '',
  ].filter(s => s !== '').join('\n');
}

/* 只看正文那一轮用的问法：不是重新问一遍全流程，是把"你查到的"给她，让她接着回 */
export function buildReadSystem({ boot, registry, entities = null, entries = [], missing = [], extra = '', styleText = '' } = {}) {
  const base = buildSystem({ boot, registry, entities, extra, styleText });
  const got = (entries || []).map(e => `【${e.id}】${e.desc}\n${e.body}`).join('\n\n');
  return base + [
    '',
    '## 你要的那几条，正文在这',
    got || '（一条都没查到。）',
    missing.length ? `没有这几条：${missing.join('、')}。（那就是没有，别编。）` : '',
    '现在接着回。已经查到的不必再 read。',
  ].filter(s => s !== '').join('\n');
}

/* 唤醒时（没人跟她说话）用的另一套问法：不是"你想干嘛"，是"你手上那件要不要动一下" */
export function buildWakeSystem({ boot, registry, item, entities = null, avatar = null, extra = '', styleText = '' } = {}) {
  const base = buildSystem({ boot, registry, entities, avatar, extra, styleText });
  const cand = (item?.candidates || []).filter(Boolean);
  /* 候选现在由窗口管（loop 会在开窗前把它塞进去），所以这句只在没开窗时兜底。
   * 两处都说一遍会让提示词自我重复，而自我重复的提示词会被模型当成强调。 */
  const needCandLine = cand.length && !registry?.windowInfo?.();
  /* 空时刻：钟只说了"现在是时候了"，没说她该有什么感觉。
   * 所以这里一个字都不许替她下判断——不写"你有点闷"，不写"该做点什么"，
   * 也不给候选（给了就是我们在指使她）。她回 do:[] say:"" 是合法的。 */
  if (item?.beat) {
    return base + [
      '',
      '## 现在没人在跟你说话',
      '手上没有任何事在等你。这是你自己的一段时间。',
      '想做什么就做；不想做，就回 "do":[] 并且 "say":""，什么都不会缺。',
      '不许为了不冷场而找事。',
    ].filter(Boolean).join('\n');
  }

  return base + [
    '',
    '## 这次没人跟你说话',
    `你手上是这件事：${item?.detail || item?.target || '（没写清楚）'}${item?.agendaId ? `（你自己记下的，id 是 ${item.agendaId}）` : ''}。`,
    /* 同一件事第几次了：只报次数和时间，不说"别再提了"。
     * 少了这一行，第四次和第一次在她眼里完全一样——她只能把上次那句再说一遍。 */
    (item?.occurrences > 1)
      ? `同样的事这是第 ${item.occurrences} 次：头一次在${ago(item.firstAt)}，上一次在${ago(item.lastAt)}。`
      : '',
    item?.next ? `上次你想的下一步是：${item.next}。` : '',
    needCandLine ? `这件事只考虑这几个动作：${cand.join('、')}；别的这次先不做。` : '',
    // 第一次、或者他没在场：给最轻的那一下。选错了代价只是"她走过去看了看"。
    item?.probe ? '这是头一次，先做最轻的那个：走过去、看一眼、坐下。别一上来就开口。' : '',
    '要不要为它做点什么？要就只做一步；不做就回 "do":[] 并且 "say":""。',
    /* 真跑抓到过：议程写着"去把顶灯关掉"，她只做了 go_to 就说"灯我去关了"。
     * 一步没说成两步，话就先到了——和"我已经坐着了"是同一个病。 */
    '只做一步，就只说这一步。走过去了不等于关掉了；没说成的事，别用完成的口气说。',
    '像"去把灯关掉"这种，toggle 自己会走过去，不用先 go_to 再 toggle。',
    /* 不做的事必须能退场。否则议程里那一条永远 open，每次没人说话都把它捞出来问一遍，
     * 她要么一直敷衍，要么一直欠着——两种都会把"自主"变成"被追债"。 */
    '如果这件事是你自己记的、而你已经不想做了，把它的 id 填进 done 划掉，以后不再提。',
    '不许为了不冷场而找事。',
    /* 放在最后：她已经决定要动、也已经开口了，最容易忘的就是"把这件事划掉"。
     * 真跑两次：灯关掉了，议程还挂着，下一次又被捞出来问一遍。 */
    item?.agendaId ? `做完这一下就把 ${item.agendaId} 填进 done，这件事就算了了；没做成、或者不想做了，也填。` : '',
  ].filter(s => s !== '').join('\n');
}

/* ---------------- 解析 ---------------- */
const idList = v => {
  if (!v) return [];
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.map(x => (typeof x === 'string' ? x : x?.id)).filter(Boolean).map(String);
  return [];
};

/* 身体只有五种表情，所以词表也只有五个。这不是限制她怎么感受，
 * 是限制**能演出来的那部分**——端口认不出的词写进来只会被丢掉。 */
export const MOODS = ['happy', 'angry', 'sad', 'relaxed', 'surprised'];

export function parseOut(text, { registry } = {}) {
  const raw = String(text ?? '').trim();
  const fail = (why) => ({ say: raw, mood: null, do: [], read: [], remember: [], forget: [], plan: [], done: [], raw, parseError: why });

  let body = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const a = body.indexOf('{'), b = body.lastIndexOf('}');
  if (a === -1 || b === -1 || b < a) return fail('no_json');
  let obj;
  try { obj = JSON.parse(body.slice(a, b + 1)); } catch { return fail('bad_json'); }
  if (!obj || typeof obj !== 'object') return fail('not_object');

  const say = typeof obj.say === 'string' ? obj.say.trim() : '';

  /* 情绪落款：**不在词表里就当没写**，不报错、不重发。
   * 表情是给眼睛看的，一个生词不该把整轮拖进重发——那会为了演得像而说得不像。 */
  const mood = MOODS.includes(String(obj.mood ?? obj.emotion ?? '').trim()) ? String(obj.mood ?? obj.emotion).trim() : null;

  /* 记忆三件事先收：它们不影响动作，解析失败也不该连累 do。
   * remember 单条写成对象也认（模型经常把数组写成单个对象）。 */
  const read = idList(obj.read ?? obj.readMemory);
  const forget = idList(obj.forget ?? obj.forgetMemory);
  const remRaw = obj.remember ?? obj.rememberMemory ?? obj.memory;
  const remember = [];
  for (const it of (Array.isArray(remRaw) ? remRaw : (remRaw ? [remRaw] : [])).slice(0, 3)) {
    if (typeof it === 'string') { remember.push({ id: null, desc: it.slice(0, 150), body: it }); continue; }
    // 没正文的**不在这里丢**：丢在这里就成了"她说了记住，什么都没发生也没人告诉她"。
    // 交给 writeMem 回一句人话（H17）。
    const text = String(it?.body ?? it?.text ?? '').trim();
    remember.push({ id: it?.id ? String(it.id) : null, desc: String(it?.desc ?? it?.description ?? '').trim(), body: text });
  }

  /* 议程：她自己给自己记的事。和 remember 同一层（都是她的输出），但存的地方不同：
   * remember 进 memories.json（她记得的事实），plan 进 agenda.json（她打算做的事）。
   * 分开的理由：事实要能被检索，计划要能被划掉；混在一起，做完的事会留在索引里当噪音。 */
  const plan = [];
  const plRaw = obj.plan ?? obj.agendaAdd ?? obj.planAdd;
  for (const it of (Array.isArray(plRaw) ? plRaw : (plRaw ? [plRaw] : [])).slice(0, 2)) {
    if (typeof it === 'string') { plan.push({ id: null, text: it.slice(0, 60), next: null }); continue; }
    const text = String(it?.text ?? it?.what ?? it?.task ?? '').trim();
    if (!text) continue;   // 空文本不在这里丢给上层判断，这里直接没有，因为没正文的"记一条"没有任何意义
    plan.push({ id: it?.id ? String(it.id) : null, text, next: String(it?.next ?? '').trim() || null });
  }
  const done = idList(obj.done ?? obj.agendaDone ?? obj.finish);

  const list = Array.isArray(obj.do) ? obj.do : (obj.do ? [obj.do] : []);
  const doList = [];
  for (const it of list.slice(0, 2)) {
    const name = typeof it === 'string' ? it : (it?.do || it?.name);
    if (!name) continue;
    let args = (typeof it === 'object' && it.args && typeof it.args === 'object') ? { ...it.args } : {};
    if (typeof it === 'object') {
      // 写在顶层的参数（{"do":"toggle","to":"lamp:2","state":"on"}）也算数
      for (const [k, v] of Object.entries(it)) {
        if (k === 'do' || k === 'name' || k === 'to' || k === 'args') continue;
        if (args[k] === undefined) args[k] = v;
      }
    }
    if (typeof it === 'object' && it.to !== undefined) {
      // 短写 {do,to} → 长写 {name,args:{target}}。哪个字段接，看注册表怎么声明的，不猜。
      // 注意：不能要求"其它参数为空"才映射——{"do":"toggle","to":"lamp:2","state":"on"} 同时有 to 和 state
      const d = registry?.get?.(name);
      const keys = Object.keys(d?.schema || {});
      const field = keys.includes('target') ? 'target' : (keys.length === 1 ? keys[0] : null);
      if (field && args[field] === undefined) args[field] = it.to;
    }
    doList.push({ name: String(name), args });
  }
  return { say, mood, do: doList, read, remember, forget, plan, done, raw, parseError: null };
}
