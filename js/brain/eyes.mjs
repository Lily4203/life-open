/* 眼睛：看一眼 = 截一张屏 → 缩图 → 问出那句话 → 投一条事件
 * ------------------------------------------------------------
 * 这个文件是 P6 的**调用方**：它把三件已经存在的事接起来——
 *   桌面壳的 capturePage（desktop:capture，返回 dataURL 不落盘）
 *   服务端的 /api/see（tools/vision.mjs，一帧进一句话出）
 *   感官层的 senses.screen（只收"看懂的一句话"，要 consent）
 * 它自己不做其中任何一件，所以三件事各自还能被替换。
 *
 * 四条硬规矩（每一条都有对应的测试）：
 *   ① **先问许可，再截屏。** 顺序反了就算"截了但没发"，图已经在内存里了。
 *      没同意就返回 no_consent，capture 一次都不该被调用。
 *   ② **一次只能看一眼。** 正在看时再调返回 busy，不排队——
 *      排队等于她看的是五秒前的屏幕却当成"现在"。
 *   ③ **不缓存、不重发。** 缩完的图用完就丢，模块里没有任何地方留着它。
 *      连 last 也只记数字（字节/毫秒/字数），不记图、不记摘要。
 *   ④ **失败不装死。** 每个失败都有 reason 和一句人话，页面据此说话；
 *      不自动重试（这一下真花钱，再看一眼该由人决定）。
 */

export const EYE_REASONS = [
  'no_shell', 'no_consent', 'busy', 'too_soon', 'capture_failed',
  'bad_image', 'no_key', 'rate_limited', 'upstream', 'net', 'not_accepted',
];

/* 缩图的默认实现。用 canvas 是因为它一定在：桌面壳里就是一个 Chromium。
 * 三件必须做的事：
 *   · 按长边缩到 1280（她不需要看清 4K 上的字，只需要知道那是什么窗口）；
 *   · 先铺白底再画——截图可能有透明区，JPEG 没有 alpha，透明会变成**黑**，
 *     模型会一本正经地说"屏幕一片黑"；
 *   · 输出 JPEG 而不是 PNG：同一屏从 1.8 MB 降到 150 KB，按图计费的钱差十倍。 */
export async function shrinkToJpeg(dataUrl, { maxW = 1280, quality = 0.72 } = {}) {
  const img = await new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error('图打不开'));
    i.src = dataUrl;
  });
  const sw = img.naturalWidth || img.width || 1;
  const sh = img.naturalHeight || img.height || 1;
  const k = Math.min(1, maxW / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * k));
  const h = Math.max(1, Math.round(sh * k));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, w, h);
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, 0, 0, w, h);
  return c.toDataURL('image/jpeg', quality);
}

/* dataURL 解码后的真实字节数。用它判断大不大，别看字符串长度——
 * 差 4/3，看着没超的服务端会 413。 */
export function dataUrlBytes(s) {
  const i = String(s || '').indexOf(',');
  if (i < 0) return 0;
  const b64 = s.slice(i + 1).replace(/\s+/g, '');
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
}

const defaultPost = async (body) => {
  const r = await fetch('/api/see', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  let json = null;
  try { json = await r.json(); } catch { /* 非 JSON 就是上游坏了，下面按状态码说 */ }
  return { status: r.status, json };
};

export function createEyes({ capture = null, post = defaultPost, senses = null,
                             shrink = shrinkToJpeg, now = () => Date.now(),
                             minIntervalMs = 3000, maxW = 1280, quality = 0.72,
                             maxBytes = 700 * 1024 } = {}) {
  const stats = { looks: 0, ok: 0, failed: 0, busy: 0, tooSoon: 0, bytes: 0, lastMs: 0 };
  let inflight = false;
  let lastAt = 0;
  let last = null;                 // 只放数字和原因，永远不放图/摘要

  const fail = (reason, message, extra = {}) => {
    stats.failed += 1;
    last = { at: now(), ok: false, reason, ...extra };
    return { ok: false, reason, message, ...extra };
  };

  async function fit(dataUrl) {
    /* 三档：原尺寸高质量 → 同尺寸低质量 → 小一号。
     * 只降两档是因为"再降就认不出来了"——看不清的图发出去，等于花着钱让她瞎猜。 */
    const tries = [
      { maxW, quality },
      { maxW, quality: 0.5 },
      { maxW: Math.round(maxW * 0.66), quality: 0.45 },
    ];
    for (const t of tries) {
      const out = await shrink(dataUrl, { maxW: t.maxW, quality: t.quality });
      const bytes = dataUrlBytes(out);
      if (bytes && bytes <= maxBytes) return { dataUrl: out, bytes };
    }
    return null;
  }

  /* 看一眼。返回的 summary 只是"给调用方看的"，真正进大脑的是 senses.screen
   * 投出去的那条事件——这边**不直接**叫醒她，免得有两条路。 */
  async function look({ why = '' } = {}) {
    if (!capture) return fail('no_shell', '现在不在桌面壳里，截不了屏（用 npm start 打开才有这一步）');
    if (!senses) return fail('no_shell', '没有接上感官层：senses.screen 才是事件入口');

    /* 许可先查。注意问的是 senses 的 consent，不是这里自己存一个布尔——
     * 两个地方各存一份，早晚会出现"这里以为同意、那里以为没同意"。 */
    const st = senses.stats ? senses.stats() : {};
    if (!st.consent) return fail('no_consent', '他还没允许我看屏幕（__SENSES.consent(true)）');

    if (inflight) {
      stats.busy += 1;
      return { ok: false, reason: 'busy', message: '上一眼还没看完' };
    }
    const gap = now() - lastAt;
    if (lastAt && gap < minIntervalMs) {
      stats.tooSoon += 1;
      return { ok: false, reason: 'too_soon', waitMs: minIntervalMs - gap,
               message: `刚看过（${Math.round(gap / 100) / 10} 秒前），等一下再看` };
    }

    inflight = true;
    lastAt = now();
    stats.looks += 1;
    const t0 = now();
    try {
      let cap;
      try { cap = await capture(); } catch (e) { return fail('capture_failed', '截屏失败：' + String(e.message || e)); }
      if (!cap || !cap.ok || !cap.dataUrl) {
        return fail('capture_failed', '截屏没拿到图：' + (cap?.reason || '不知道原因'));
      }

      const small = await fit(cap.dataUrl);
      if (!small) return fail('bad_image', '缩完还是太大，说明这张图不是屏幕截图');
      stats.bytes = small.bytes;

      let r;
      try { r = await post({ image: small.dataUrl, why: String(why || '').slice(0, 60) }); }
      catch (e) { return fail('net', '连不上看图的服务：' + String(e.message || e)); }

      const j = r?.json || {};
      if (r?.status !== 200 || !j.ok) {
        /* 服务端的 reason 直接透出来：no_key / busy / too_soon / rate_limited / upstream。
         * 这些词对人有用，对她也一样——"没配密钥"和"看不清"是两件事。 */
        return fail(j.reason || (r?.status ? 'upstream' : 'net'),
                    j.message || `看图没成（HTTP ${r?.status ?? '?'}）`, { status: r?.status ?? null });
      }

      const summary = String(j.summary || '').trim();
      if (!summary) return fail('upstream', '模型什么都没说');

      /* 最后一步才是"她看见了"。senses.screen 会做两件事：
       * 计一条事件、经由 emit 交给感知层。这里不重复做任何一件。 */
      const sent = senses.screen({ summary });
      if (!sent || sent.ok === false) {
        return fail('not_accepted', '感官层没收：' + (sent?.reason || '不知道原因'));
      }

      stats.ok += 1;
      stats.lastMs = now() - t0;
      last = { at: now(), ok: true, ms: stats.lastMs, bytes: small.bytes, chars: summary.length };
      return {
        ok: true, summary, entities: Array.isArray(j.entities) ? j.entities : [],
        private: j.private === true, provider: j.provider || null, model: j.model || null,
        ms: j.ms ?? stats.lastMs, bytes: small.bytes, sent,
      };
    } finally {
      inflight = false;
    }
  }

  return {
    look,
    /* 能不能看，四个条件缺一不可。页面拿它决定按钮亮不亮、提示写哪一句。 */
    available: () => ({
      shell: Boolean(capture),
      consent: Boolean(senses?.stats?.().consent),
      busy: inflight,
      waitMs: lastAt ? Math.max(0, minIntervalMs - (now() - lastAt)) : 0,
    }),
    stats: () => ({ ...stats, inflight, lastAt: lastAt || null }),
    last: () => (last ? { ...last } : null),
  };
}
