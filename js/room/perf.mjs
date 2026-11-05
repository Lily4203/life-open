/* 表现层 —— 她"怎么动"，不是"动不动"。
 * ============================================================
 * 从 js/room/world.mjs 里切出来的，因为它和屋子是两件事：
 *   屋子管"能不能"（走到床边、按开关），这里管"好不好看"（抬手多高、先眨哪只眼）。
 * 切出来之后它能被单独喂骨头和状态来验——以前只能靠打开页面看。
 *
 * 依赖只有两个，都从外面传进来，不自己去找：
 *   nbone(name) → 骨骼节点（找不到返回 null）
 *   state       → 她的姿势/走没走（只读，这里不改她）
 * 这样 node 里给一个假的 state 就能验"坐着的时侯不演站姿那套"。
 */
import { GESTURES as GEST, NEAREST, sample as gestSample } from '../brain/gestures.mjs';

export function createPerf({ nbone, state }) {

/* ============================================================
   五点五、表现层 —— 她"怎么动"，不是"动不动"
   ------------------------------------------------------------
   这一层在屋子里，不在大脑里。大脑只说"我有点得意""看向台灯"，
   抬手、换重心、什么时候眨眼，全在这里决定。
   它守三条规矩，每条都来自"做不好比不做更糟"：

     一、一次只演一个。两个手势叠在一起不是丰富，是抽搐。
     二、同一个不连着演两次。第二次出现时人眼立刻看出是循环。
     三、走路、躺着、坐着时不演站姿那套。人不会一边走一边整理衣领。

   还有一条边界：**手的骨骼归这里，头归眼睛**。
   tick 里那段"头跟着鼠标"每帧都在把 head.rotation 往目标上拽，
   这里再往 head 上叠偏移，两边会互相拉锯（看起来像轻微发抖）。
   所以手势只动 neck 以下，头交给视线——包括 glance，扭的是脖子不是头。
   ============================================================ */
/* 时间轴用 performance.now()，不用 state.t。
 * 为什么：state.t 是"累计的 dt"，而 dt 被夹在 0.05——掉帧的时候它比墙上的钟慢得多。
 * 夹 dt 是为了物理稳定（一帧跳 2 秒会把人瞬移出去），但**动作时长是给人看的**：
 * 挥手说好 1.5 秒，就该在 1.5 秒后结束，不管这一秒渲了几帧。
 * 用 state.t 的后果实测过：headless 里 3 帧/秒时，一次挥手演了 30 秒，像卡住。 */
const perfNow = () => performance.now();

const PERF = {
  g: null,                 // 正在演的手势 { kind, t0, dur }
  last: null,              // 上一个（不许连着同一个）
  applied: new Map(),      // 骨骼 → 这一帧加了多少（每帧先减掉，否则越转越歪）
  nextIdle: 0,             // 下一次自己找点事做的时间（ms，第一次在 perfStart 里定）
  speaking: false,         // 正在说话（影响镜头和待机）
  speakUntil: 0,           // ms
  lines: 0,                // 这一轮说了几句（每两句强调一次）
  camK: 1,                 // 镜头距离系数：说话时 0.97（推近 3%）
  done: [],                // 最近演过什么，调试用
};

/* 骨骼偏移的加减法。为什么不是直接赋值：姿势（applyPose）只在换姿势时写一次，
 * 每帧写会把坐/躺那些手拧出来的角度全冲掉。所以这里只"加"，加之前先把上一帧加的减掉。 */
function perfSpin(name, v){
  const n = nbone(name); if(!n) return;
  const p = PERF.applied.get(name) || [0,0,0];
  n.rotation.x += v[0] - p[0];
  n.rotation.y += v[1] - p[1];
  n.rotation.z += v[2] - p[2];
  PERF.applied.set(name, v);
}
function perfClear(){
  for(const [name,p] of PERF.applied){
    const n = nbone(name);
    if(!n) continue;
    n.rotation.x -= p[0]; n.rotation.y -= p[1]; n.rotation.z -= p[2];
  }
  PERF.applied.clear();
}

/* 演一个。忙的时候不硬插：正在演的那个走完 70% 才让位；已经演完的直接换。 */
function perfGesture(kind){
  const g = GEST[kind];
  if(!g){ console.warn('[perf] 没有这个手势：' + kind); return { ok: false, reason: 'unknown_gesture' }; }
  if(PERF.g){
    const u = (perfNow() - PERF.g.t0) / 1000 / PERF.g.dur;
    if(u < 0.7) return { ok: false, reason: 'busy', now: PERF.g.kind };
    perfClear();
  }
  /* 连着两次同一个会被一眼看穿；换成"最接近的另一种"（不是随机跳）。
   * 映射表在 gestures.mjs：它属于"身体的语言"，和演法放一起。 */
  let k = kind;
  if(k === PERF.last) k = NEAREST[kind] || kind;
  PERF.g = { kind: k, t0: perfNow(), dur: GEST[k].dur };
  PERF.last = k;
  return { ok: true, kind: k };
}

/* 她开口了：这一句配一个手势（每两句一次），镜头推近一点。
 * 为什么不是每句都配：每句都动就是"机械节拍"，比不动更假。 */
function perfOnSay(){
  PERF.speaking = true;
  PERF.speakUntil = perfNow() + 4000;   // 一句最多算 4 秒（长句由下一次 onSay 续上）
  PERF.lines += 1;
  if(PERF.lines % 2 === 0 && !state.walking && state.poseName === 'stand'){
    perfGesture(Math.random() < 0.55 ? 'emphasize' : 'nod');
  }
}
/* 换了表情：带一个和情绪同调的动作。她没说这是"动作"，是身体自己带的。 */
function perfOnEmotion(e){
  const m = { happy:'nod', surprised:'tilt', angry:'shrug', sad:'tilt', relaxed:'shift' };
  if(!m[e]) return;
  if(state.walking || state.poseName !== 'stand') return;
  perfGesture(m[e]);
}

function perfTick(dt){
  // 第一次进来不该立刻演：先安静五秒，让她站定
  if(!PERF.nextIdle) PERF.nextIdle = perfNow() + 5000;

  // 说话状态：到点自动落下来，不依赖页面记得关
  if(PERF.speaking && perfNow() > PERF.speakUntil) PERF.speaking = false;

  // 镜头：说话时近 3%，不说话回到 100%；慢慢来，快了像呼吸重
  const camWant = PERF.speaking ? 0.97 : 1;
  PERF.camK += (camWant - PERF.camK) * Math.min(1, dt*2.2);

  // 正在演的，推进一步
  if(PERF.g){
    const u = Math.min(1, (perfNow() - PERF.g.t0) / 1000 / PERF.g.dur);
    /* sample() 会顺手做三件事：夹 u、滤掉白名单外的骨头、限幅。
     * 页面这一侧只负责"加上去"，不负责"该不该加"——那是词的属性。 */
    const off = gestSample(PERF.g.kind, u) || {};
    for(const name in off) perfSpin(name, off[name]);
    if(u >= 1){ perfClear(); PERF.done.push(PERF.g.kind); PERF.g = null; }
  }

  /* 待机：不忙的时候自己找点事做。
   * 间隔 6–13 秒，节奏刻意不齐——齐了就成了节拍器，那是机器人。
   * 只在"站着、没走、没说话"时进行：坐着躺着要靠骨骼姿势，这套站姿偏移会把它们弄形变。 */
  const idle = !PERF.g && !state.walking && !PERF.speaking && state.poseName === 'stand';
  if(idle && perfNow() > PERF.nextIdle){
    const pool = ['shift','glance','tidy','glance','shift'];
    perfGesture(pool[Math.floor(Math.random()*pool.length)]);
    PERF.nextIdle = perfNow() + 6000 + Math.random()*7000;
  }
}

const debug = {
  gesture: perfGesture,
  /* 后端 say/emotion 会调这两个。漏掉它们的后果不是报错，而是**静默不生效**：
   * 后端那边 try/catch 吞了 TypeError，看起来一切正常，只是她从来不带手势。
   * 真跑第一次就是这样——所以它必须在这儿，也必须有断言盯着（perform-test D13）。 */
  onSay: perfOnSay,
  onEmotion: perfOnEmotion,
  now: () => (PERF.g ? PERF.g.kind : null),
  last: () => PERF.last,
  done: () => PERF.done.slice(-12),
  stats: () => ({ count: PERF.done.length, current: PERF.g?.kind ?? null,
                  camK: +PERF.camK.toFixed(3), speaking: PERF.speaking }),
  /* 调试用：直接演一个，不排队 */
  force: k => { PERF.g = null; perfClear(); return perfGesture(k); },
};

  /* 对外只开这些。PERF 自己也给出去：world 那一侧要读 camK 来算相机距离，
   * 但那只是"读数"，不是"改表演"——改表演只能走 gesture/onSay/onEmotion。 */
  return {
    PERF,
    gesture: perfGesture,
    onSay: perfOnSay,
    onEmotion: perfOnEmotion,
    tick: perfTick,
    clear: perfClear,
    debug,
  };
}
