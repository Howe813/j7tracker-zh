/* J7Tracker 中文界面 — 后台 service worker
 * 代 content script 调 Google 翻译（免 CORS / 免 key）。
 *  - 批量：clients5 多 q 接口一次翻多条；失败再逐条走 gtx
 *  - 串行 + 最小间隔，429 时整体退避，避免把出口 IP 打进风控
 *  - 小缓存
 */
const cache = new Map();
const CACHE_MAX = 4000;
function remember(key, val) { if (cache.size >= CACHE_MAX) cache.clear(); cache.set(key, val); }

let chain = Promise.resolve();      // 串行队列
let lastAt = 0;                     // 上一次请求时间
let pauseUntil = 0;                 // 退避截止
let backoff = 0;                    // 当前退避级别
const MIN_GAP = 250;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function bump() { backoff = Math.min(backoff + 1, 6); pauseUntil = Date.now() + [0, 5, 15, 30, 60, 120, 300][backoff] * 1000; }
function calm() { backoff = 0; pauseUntil = 0; }

async function fetchJson(url, init, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 12000);
  try {
    const r = await fetch(url, Object.assign({}, init || {}, { signal: ctrl.signal }));
    if (r.status === 429 || r.status === 403) { const e = new Error('rate-limited ' + r.status); e.rateLimited = true; throw e; }
    if (!r.ok) throw new Error('http ' + r.status);
    return await r.json();
  } finally { clearTimeout(timer); }
}

// 多条：clients5，返回 [["译","en"],...] 或 ["译",...]
async function batchClients5(texts, tl) {
  const url = 'https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=auto&tl=' + encodeURIComponent(tl) + '&' + texts.map((t) => 'q=' + encodeURIComponent(t)).join('&');
  if (url.length > 7600) throw new Error('too long');
  const j = await fetchJson(url, { method: 'GET' });
  if (!Array.isArray(j)) throw new Error('bad');
  // 只有一条时可能直接返回 ["译","en"]
  let arr = j;
  if (texts.length === 1 && typeof j[0] === 'string') arr = [j];
  if (arr.length !== texts.length) throw new Error('count mismatch');
  return arr.map((it) => (Array.isArray(it) ? String(it[0] || '') : String(it || '')));
}

// 单条：gtx
async function singleGtx(text, tl) {
  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=' + encodeURIComponent(tl) + '&dt=t';
  const j = await fetchJson(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body: 'q=' + encodeURIComponent(text) });
  const out = (j && j[0] ? j[0] : []).map((s) => (s && s[0]) || '').join('');
  if (!out) throw new Error('empty');
  return out;
}

async function throttle() {
  const now = Date.now();
  if (pauseUntil > now) await sleep(pauseUntil - now);
  const gap = Date.now() - lastAt;
  if (gap < MIN_GAP) await sleep(MIN_GAP - gap);
  lastAt = Date.now();
}

// 翻译一批，返回 {results: [{text|null}], paused: ms}
async function translateBatch(texts, tl) {
  const results = new Array(texts.length).fill(null);
  const todo = [];
  texts.forEach((t, i) => { const k = tl + '|' + t; if (cache.has(k)) results[i] = cache.get(k); else todo.push(i); });
  if (!todo.length) return { results };

  // 分成 URL 长度可控的小批
  const groups = []; let cur = []; let curLen = 0;
  for (const i of todo) {
    const len = encodeURIComponent(texts[i]).length + 3;
    if (cur.length && (curLen + len > 6000 || cur.length >= 10)) { groups.push(cur); cur = []; curLen = 0; }
    cur.push(i); curLen += len;
  }
  if (cur.length) groups.push(cur);

  for (const g of groups) {
    await throttle();
    let ok = false;
    try {
      const outs = await batchClients5(g.map((i) => texts[i]), tl);
      g.forEach((i, n) => { if (outs[n]) { results[i] = outs[n]; remember(tl + '|' + texts[i], outs[n]); } });
      ok = true; calm();
    } catch (e) {
      if (e && e.rateLimited) { bump(); return { results, paused: pauseUntil - Date.now() }; }
    }
    if (!ok) {
      // 逐条兜底
      for (const i of g) {
        await throttle();
        try { const out = await singleGtx(texts[i], tl); results[i] = out; remember(tl + '|' + texts[i], out); calm(); }
        catch (e) { if (e && e.rateLimited) { bump(); return { results, paused: pauseUntil - Date.now() }; } }
      }
    }
  }
  return { results };
}

/* ---- GMGN 后台搜索：不抢焦点地打开/复用 gmgn.ai 标签页 ---- */
async function gmgnSearch(q, sender) {
  const url = 'https://gmgn.ai/?chain=sol#j7q=' + encodeURIComponent(q);
  const tabs = await chrome.tabs.query({ url: ['https://gmgn.ai/*', 'https://*.gmgn.ai/*'] });
  // 优先复用与 j7 同窗口的 GMGN 标签页（比如用户开着分屏）
  const senderWin = sender && sender.tab && sender.tab.windowId;
  const existing = tabs.find((t) => t.windowId === senderWin) || tabs[0];
  if (existing) {
    // 常规路径：直接给页面里的 bridge 发消息，原地搜索，零导航零刷新
    try {
      await chrome.tabs.sendMessage(existing.id, { type: 'j7zh-gmgn-q', q });
      return { reused: true };
    } catch (e) {
      // 页面还没注入 bridge（扩展刚重载 / 标签页还在加载）→ 退回带 hash 的导航
      await chrome.tabs.update(existing.id, { url, active: false });
      return { reused: true };
    }
  }
  const createProps = { url, active: false };
  if (sender && sender.tab) { createProps.windowId = sender.tab.windowId; createProps.index = sender.tab.index + 1; }
  await chrome.tabs.create(createProps);
  return { reused: false };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'j7zh-gmgn-search') {
    gmgnSearch(String(msg.q || '').slice(0, 80), sender)
      .then((r) => sendResponse({ ok: true, reused: r.reused }))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
  if (!msg || msg.type !== 'j7zh-translate-batch') return false;
  const tl = msg.tl || 'zh-CN';
  const texts = (Array.isArray(msg.texts) ? msg.texts : []).map((t) => String(t || '').slice(0, 4000));
  chain = chain.then(() => translateBatch(texts, tl))
    .then((r) => sendResponse({ ok: true, results: r.results, paused: r.paused || 0 }))
    .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true; // 异步响应
});
