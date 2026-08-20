/* J7Tracker 中文界面 — content script
 * 三个功能，都可在右下角「中」菜单里开关：
 *   1. 界面汉化：遍历文本节点 + placeholder/title/aria-label，按字典替换；MutationObserver 跟 SPA 动态渲染
 *   2. 阅读模式：一段 CSS（html.j7zh-reader），卡片收窄居中、图片缩小、行距放宽
 *   3. 正文翻译：把推文/引用/回复的文字发给 Google 翻译（经 background.js），译文附在原文下方
 * 推文正文、币名、账号名等数据容器一律不做字典替换。
 */
(function () {
  'use strict';
  if (window.__j7zhLoaded) return;
  window.__j7zhLoaded = true;

  const D = window.__J7_ZH;
  if (!D) return;

  /* ---------- 设置（存 localStorage，和站点同源） ---------- */
  const LS = {
    ui: 'j7zh_enabled',        // 界面汉化     默认开
    reader: 'j7zh_reader',     // 阅读模式     默认开
    trans: 'j7zh_autotrans',   // 正文翻译     默认开
    engine: 'j7zh_engine'      // 翻译引擎     auto | local | google
  };
  const getFlag = (k, def) => { try { const v = localStorage.getItem(k); return v === null ? def : v !== '0'; } catch (e) { return def; } };
  const setFlag = (k, v) => { try { localStorage.setItem(k, v ? '1' : '0'); } catch (e) {} };
  const getStr = (k, def) => { try { return localStorage.getItem(k) || def; } catch (e) { return def; } };
  const S = { ui: getFlag(LS.ui, true), reader: getFlag(LS.reader, true), trans: getFlag(LS.trans, true), engine: getStr(LS.engine, 'auto') };
  if (!/^(auto|local|google)$/.test(S.engine)) S.engine = 'auto';

  /* ---------- 字典索引 ---------- */
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  const exact = new Map();
  const lower = new Map();
  for (const k of Object.keys(D.exact)) {
    const nk = norm(k);
    exact.set(nk, D.exact[k]);
    const lk = nk.toLowerCase();
    if (!lower.has(lk)) lower.set(lk, D.exact[k]);
  }
  const REGEX = D.regex || [];
  const CONTEXT = D.context || [];
  const IN_BUTTON = D.inButton || {};

  // 只在登录页/首页生效的碎片（hero 标题被拆成多个节点）
  const LANDING_ONLY = new Set(['for', 'snipers', 'deployers', 'traders', 'degens', 'devs', 'builders', 'The fastest tracker']);
  const isLandingPage = () => !!document.querySelector('input[type="password"]');

  /* ---------- 跳过的容器（用户内容 / 数据） ---------- */
  const EXCLUDE_SEL = [
    'script', 'style', 'textarea', 'input', 'code', 'pre', 'kbd', '[contenteditable]',
    '#j7zh-toggle', '#j7zh-menu', '.j7zh-trans',
    // 推文正文与引用
    '.tweet-content', '.quoted-tweet', '.nested-quoted-tweet', '.reply-to-tweet',
    '.pinned-text', '.pinned-tweet-content', '.pinned-update-content', '.following-update-content',
    // 站点自带的推文翻译结果
    '.tweet-translation', '.translation-body', '.translation-text', '.translation-content',
    // 作者 / 资料卡（名字、handle、简介、地点、链接）
    '.tweet-author', '.profile-bio', '.profile-location', '.profile-website', '.profile-name',
    '.profile-handle', '.profile-joined', '.quoted-author', '.nested-quoted-author',
    '.translation-author', '.translation-name', '.translation-handle',
    // AI 建议卡片的币名 / 代码
    '.ai-card-name', '.ai-card-ticker',
    // 粉丝数（时间容器不排除：只做 12→24 小时制转换）
    '.follower-count-badge',
    // 文章卡片、聊天消息
    '[class*="article"]', '[class*="chat-message"]', '.site-chat-messages', '.chat-messages', '.message-list'
  ].join(',');

  // 这些容器里只做“动词”替换（@xxx posted / retweeted …），不查通用字典
  const CONTEXT_SEL = '.context-text, .following-update-content, .pinned-update-content';

  const FIELD_ZH = { name: '名称', bio: '简介', avatar: '头像', banner: '横幅', username: '用户名' };

  /* ---------- 查找译文 ---------- */
  function lookup(text, parentEl) {
    const t = norm(text);
    if (!t || !/[A-Za-z]/.test(t)) return null;

    if (LANDING_ONLY.has(t)) return isLandingPage() ? exact.get(t) : null;

    // “6 of 18 selected” 被拆成多个节点时的 of
    if (t === 'of') {
      const pt = parentEl && parentEl.parentElement ? parentEl.parentElement.textContent : '';
      return /\d\s*of\s*\d/.test(pt) ? '/' : null;
    }

    // 按钮内的特殊译法
    if (IN_BUTTON[t] !== undefined && parentEl && parentEl.closest('button, [role="button"]')) return IN_BUTTON[t];

    let v = exact.get(t);
    if (v !== undefined) return v;

    // 大小写不敏感兜底：只对含大写字母的文案生效（避免误伤全小写的用户名等数据）
    if (/[A-Z]/.test(t)) {
      v = lower.get(t.toLowerCase());
      if (v !== undefined) return v;
    }

    for (const [re, rep] of REGEX) {
      if (re.test(t)) return t.replace(re, rep);
    }
    return null;
  }

  function translateContext(text) {
    let out = text;
    for (const [re, rep] of CONTEXT) {
      if (re.test(out)) {
        out = out.replace(re, (m, a, b) => {
          if (typeof rep === 'function') return rep(m, a, b);
          if (rep.indexOf('$2') >= 0) return rep.replace('$2', FIELD_ZH[b] || b || '');
          return rep.replace('$1', a || '');
        });
      }
    }
    return out === text ? null : out;
  }

  /* ---------- 文本节点 ---------- */
  const lastSet = new WeakMap(); // node -> 我们写入的值，避免自触发循环

  function processTextNode(node) {
    const raw = node.nodeValue;
    if (!raw || !/[A-Za-z]/.test(raw)) return;
    if (lastSet.get(node) === raw) return; // 是我们刚写的
    const parent = node.parentElement;
    if (!parent) return;
    // 资料卡里的 Followers / Following / posts 标签、扫描按钮：虽在正文容器里，但是界面文案，照常查字典
    const uiIsland = parent.closest('.profile-metrics, .profile-card-scan-btn, .profile-joined, .metric, .tweet-time, .modern-inline-time, .mlw-bb-time, .time-full, .time-short');
    if (!uiIsland && parent.closest(EXCLUDE_SEL)) {
      // 例外：关注/资料更新行里的动词仍然翻译
      if (!parent.closest('.following-update-content, .pinned-update-content')) return;
    }

    let translated = null;
    // “15 deploy” + “s” 这种被拆开的复数 s：前面已翻成“次发币”的话把 s 去掉
    if (norm(raw) === 's' && node.previousSibling && /次发币$/.test((node.previousSibling.textContent || '').trim())) {
      lastSet.set(node, ''); node.nodeValue = ''; return;
    }
    if (!uiIsland && parent.closest(CONTEXT_SEL)) {
      translated = translateContext(raw);
    } else {
      const v = lookup(raw, parent);
      if (v !== null && v !== undefined) {
        const m = raw.match(/^(\s*)[\s\S]*?(\s*)$/);
        translated = (m ? m[1] : '') + v + (m ? m[2] : '');
      }
    }
    if (translated !== null && translated !== raw) {
      lastSet.set(node, translated);
      node.nodeValue = translated;
    }
  }

  /* ---------- 属性（placeholder / title / aria-label / data-tooltip） ---------- */
  const ATTRS = ['placeholder', 'title', 'aria-label', 'data-tooltip', 'data-tip', 'alt'];
  const lastAttr = new WeakMap(); // el -> {attr: value}

  function processAttrs(el) {
    if (el.nodeType !== 1) return;
    if (el.closest && el.closest('#j7zh-toggle, #j7zh-menu, .j7zh-trans')) return;
    for (const a of ATTRS) {
      if (!el.hasAttribute(a)) continue;
      const cur = el.getAttribute(a);
      if (!cur || !/[A-Za-z]/.test(cur)) continue;
      const rec = lastAttr.get(el);
      if (rec && rec[a] === cur) continue;
      const v = lookup(cur, el);
      if (v !== null && v !== undefined && v !== cur) {
        const r = rec || {};
        r[a] = v;
        lastAttr.set(el, r);
        el.setAttribute(a, v);
      }
    }
  }

  /* ---------- 遍历 ---------- */
  const SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1 };
  function isOurs(el) { return el.id === 'j7zh-toggle' || el.id === 'j7zh-menu' || (el.classList && el.classList.contains('j7zh-trans')); }

  function walk(root) {
    if (!root) return;
    if (root.nodeType === 3) { processTextNode(root); return; }
    if (root.nodeType !== 1 && root.nodeType !== 11) return;
    if (root.nodeType === 1) {
      if (isOurs(root) || SKIP_TAGS[root.tagName]) return;
      processAttrs(root);
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode(n) {
        if (n.nodeType === 1) {
          if (SKIP_TAGS[n.tagName] || isOurs(n)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let n;
    while ((n = walker.nextNode())) {
      if (n.nodeType === 3) processTextNode(n);
      else processAttrs(n);
    }
  }

  /* =====================================================================
   *  正文翻译
   *  - 找到真正承载文字的节点 → 取纯文本 → 批量发给 background（Google 翻译）→ 译文块插在节点后面
   *  - 失败指数退避；译文缓存在 localStorage，刷新后不用重翻
   * ===================================================================== */
  const TR = {
    UNIT_SEL: [
      '.tweet-content:not(:has(.tweet-content)):not(:has(.quoted-tweet)):not(:has(.nested-quoted-tweet))',
      '.quote-comment',
      '.quoted-tweet-content',
      '.nested-quoted-tweet-content',
      '.pinned-tweet-content',
      '.profile-bio'
    ].join(','),
    STRIP_SEL: '.j7zh-trans, .tweet-media, .media-container, img, video, svg, .quoted-tweet, .nested-quoted-tweet, .video-preview-container, [class*="article"], .tweet-translation',
    cache: new Map(),     // key -> 译文
    failed: new Map(),    // key -> 失败时间
    queue: [],            // [{key,text}]
    queued: new Set(),
    busy: false,
    BATCH: 10,
    pauseUntil: 0,
    backoff: 0,
    status: 'idle',       // idle | working | paused | error
    tl: 'zh-CN'
  };

  // 持久缓存（最多 1500 条）
  const CACHE_LS = 'j7zh_trcache_v1';
  (function loadCache() {
    try {
      const raw = localStorage.getItem(CACHE_LS);
      if (!raw) return;
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) for (const [k, v] of arr) if (typeof k === 'string' && typeof v === 'string') TR.cache.set(k, v);
    } catch (e) {}
  })();
  let saveTimer = null;
  function saveCacheSoon() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        let arr = [...TR.cache.entries()];
        if (arr.length > 1500) arr = arr.slice(arr.length - 1500);
        localStorage.setItem(CACHE_LS, JSON.stringify(arr));
      } catch (e) {}
    }, 2000);
  }

  function hashStr(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36) + '_' + s.length;
  }

  // 把节点变成保留换行的纯文本
  function unitText(el) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll(TR.STRIP_SEL).forEach((n) => n.remove());
    clone.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
    clone.querySelectorAll('div, p, li, blockquote').forEach((b) => { b.appendChild(document.createTextNode('\n')); });
    let t = clone.textContent || '';
    t = t.replace(/ /g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return t;
  }

  const LETTERS_RE = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ֐-׿؀-ۿ฀-๿぀-ヿ가-힯]/g;
  const LETTERS2_RE = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ֐-׿؀-ۿ฀-๿぀-ヿ가-힯]{2,}/;
  function needsTranslate(t) {
    if (!t || t.length < 2) return false;
    if (/^(un)?followed\s+@\S+$/i.test(t)) return false; // 关注事件行，头部已有中文
    if (/^(pinned|unpinned)\b/i.test(t) && t.length < 40) return false;
    const letters = (t.match(LETTERS_RE) || []).length;
    const han = (t.match(/[一-鿿]/g) || []).length;
    if (letters < 2) return false;
    if (han >= letters) return false; // 本来就是中文为主
    const stripped = t.replace(/https?:\/\/\S+|pic\.x\.com\/\S+|\bt\.co\/\S+|@\w+|#\w+|\$\w+/g, ' ');
    return LETTERS2_RE.test(stripped);
  }

  // ---- 本地引擎：Chrome 内置 Translator / LanguageDetector（138+，离线、无限流） ----
  const LOCAL = {
    ok: (typeof self !== 'undefined' && typeof self.Translator !== 'undefined'),
    translators: new Map(),   // srcLang -> Promise<Translator|null>
    detectorP: null,
    unsupported: new Set(),
    async detect(text) {
      try {
        if (typeof self.LanguageDetector === 'undefined') return 'en';
        if (!this.detectorP) this.detectorP = LanguageDetector.create().catch(() => null);
        const det = await this.detectorP;
        if (!det) return 'en';
        // 去掉 @ / # / 链接 再测，少受干扰
        const probe = text.replace(/https?:\/\/\S+|@\w+|#\w+|\$\w+/g, ' ').trim() || text;
        const res = await det.detect(probe);
        const top = res && res[0];
        if (!top || !top.detectedLanguage || top.detectedLanguage === 'und' || (top.confidence || 0) < 0.35) return 'en';
        return top.detectedLanguage.split('-')[0];
      } catch (e) { return 'en'; }
    },
    needGesture: new Set(),   // 创建时要求用户手势（部分 Chrome 版本首次下载语言包需要），等下一次点击再试
    retryAt: new Map(),       // 创建临时失败的语种 -> 下次可重试时间
    lastErr: null,
    async get(lang) {
      if (this.unsupported.has(lang)) return null;
      const ra = this.retryAt.get(lang);
      if (ra && Date.now() < ra) return null;
      if (!this.translators.has(lang)) {
        const p = (async () => {
          try {
            const av = await Translator.availability({ sourceLanguage: lang, targetLanguage: 'zh-Hans' });
            if (av === 'unavailable') { this.unsupported.add(lang); return null; }
            const t = await Translator.create({ sourceLanguage: lang, targetLanguage: 'zh-Hans' });
            this.retryAt.delete(lang);
            return t;
          } catch (e) {
            this.lastErr = lang + ': ' + String((e && (e.name + ' ' + e.message)) || e);
            this.translators.delete(lang);
            if (e && e.name === 'NotAllowedError') { this.needGesture.add(lang); return null; }
            // 其它错误（模型在忙/下载中等）当作临时失败，60 秒后再试；不永久拉黑
            this.retryAt.set(lang, Date.now() + 60000);
            return null;
          }
        })();
        this.translators.set(lang, p);
      }
      return this.translators.get(lang);
    },
    // 用户点了页面 → 把之前因“需要手势”没建成的翻译器补建起来
    retryOnGesture() {
      if (!this.needGesture.size) return;
      const langs = [...this.needGesture]; this.needGesture.clear();
      langs.forEach((l) => { this.translators.delete(l); this.get(l); });
      TR.failed.clear(); TR.pauseUntil = 0; TR.backoff = 0;
      scheduleScan(document.body);
    },
    async translate(text) {
      const lang = await this.detect(text);
      if (lang === 'zh') return null;
      const tr = await this.get(lang);
      if (!tr) throw new Error('no local translator for ' + lang);
      // 按段翻，保住换行
      const lines = text.split('\n');
      const out = [];
      for (const ln of lines) {
        if (!ln.trim()) { out.push(ln); continue; }
        if (!/[A-Za-zÀ-ɏͰ-ϿЀ-ӿ֐-׿؀-ۿ฀-๿぀-ヿ가-힯]/.test(ln)) { out.push(ln); continue; }
        out.push(await tr.translate(ln));
      }
      const zh = out.join('\n');
      return zh && zh.trim() && zh.trim() !== text.trim() ? zh : null;
    }
  };
  function engineInUse() {
    if (S.engine === 'google') return 'google';
    if (S.engine === 'local') return LOCAL.ok ? 'local' : 'none';
    return LOCAL.ok ? 'local' : 'google';
  }

  // ---- 请求（Google，经 background） ----
  function sendBatch(texts) {
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (fn, v) => { if (!done) { done = true; fn(v); } };
      const direct = async () => {
        // 兜底：没有扩展上下文时（比如被当普通脚本注入）直接从页面请求。Google 不一定带 CORS 头，失败就算了
        const out = [];
        for (const t of texts) {
          try {
            const r = await fetch('https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=' + TR.tl + '&dt=t', {
              method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body: 'q=' + encodeURIComponent(t)
            });
            const j = await r.json();
            out.push((j && j[0] ? j[0] : []).map((s) => (s && s[0]) || '').join('') || null);
          } catch (e) { out.push(null); if (out.length === 1) { finish(reject, e); return; } }
        }
        finish(resolve, { results: out, paused: 0 });
      };
      try {
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
          chrome.runtime.sendMessage({ type: 'j7zh-translate-batch', texts, tl: TR.tl }, (resp) => {
            if (chrome.runtime.lastError || !resp) return direct();
            if (resp.ok) finish(resolve, resp); else finish(reject, new Error(resp.error || 'fail'));
          });
          setTimeout(() => { if (!done) finish(reject, new Error('timeout')); }, 40000);
        } else direct();
      } catch (e) { direct(); }
    });
  }

  function makeBlock(key, text, loading) {
    const d = document.createElement('div');
    d.className = 'j7zh-trans' + (loading ? ' j7zh-loading' : '');
    d.setAttribute('data-j7zh-for', key);
    d.textContent = text;
    return d;
  }

  function placeBlock(unit, key, text, loading) {
    let blk = unit.nextElementSibling;
    if (!(blk && blk.classList && blk.classList.contains('j7zh-trans'))) {
      blk = makeBlock(key, text, loading);
      unit.insertAdjacentElement('afterend', blk);
    } else {
      blk.setAttribute('data-j7zh-for', key);
      blk.textContent = text;
      blk.classList.toggle('j7zh-loading', !!loading);
    }
    return blk;
  }

  function removeBlocksFor(key) {
    document.querySelectorAll('.j7zh-trans[data-j7zh-for="' + key + '"]').forEach((b) => b.remove());
  }

  function applyCached(key) {
    const zh = TR.cache.get(key);
    if (!zh) return;
    document.querySelectorAll('[data-j7zh-key="' + key + '"]').forEach((unit) => placeBlock(unit, key, zh, false));
  }

  function setStatus(st) { TR.status = st; const el = document.getElementById('j7zh-status'); if (el) el.textContent = statusText(); }
  function engineLabel() { const e = engineInUse(); return e === 'local' ? 'Chrome 本地翻译（离线）' : e === 'google' ? 'Google 翻译' : '本地引擎不可用'; }
  function statusText() {
    if (!S.trans) return '正文翻译：已关闭';
    if (TR.status === 'paused') { const s = Math.max(0, Math.ceil((TR.pauseUntil - Date.now()) / 1000)); return '正文翻译：暂时失败，' + s + ' 秒后重试'; }
    if (TR.status === 'working') return '正文翻译：翻译中…　引擎：' + engineLabel() + '（缓存 ' + TR.cache.size + ' 条）';
    return '正文翻译：正常　引擎：' + engineLabel() + '（缓存 ' + TR.cache.size + ' 条）';
  }

  const BACKOFF = [0, 5, 15, 30, 60, 120, 300];
  function failJobs(jobs) {
    jobs.forEach((j) => { TR.failed.set(j.key, Date.now()); removeBlocksFor(j.key); });
    TR.backoff = Math.min(TR.backoff + 1, 6);
    TR.pauseUntil = Date.now() + BACKOFF[TR.backoff] * 1000;
  }
  function pump() {
    if (TR.busy || !S.trans) return;
    const engine = engineInUse();
    // 退避只管 Google 那条路；本地引擎不受影响
    if (engine !== 'local' && Date.now() < TR.pauseUntil) { setStatus('paused'); setTimeout(pump, TR.pauseUntil - Date.now() + 50); return; }
    if (!TR.queue.length) { setStatus('idle'); return; }
    const jobs = TR.queue.splice(0, TR.BATCH);
    jobs.forEach((j) => TR.queued.delete(j.key));
    TR.busy = true; setStatus('working');
    (async () => {
      let rest = jobs;
      // 1) 本地引擎
      if (engine === 'local') {
        rest = [];
        for (const j of jobs) {
          try {
            const zh = await LOCAL.translate(j.text);
            if (zh) { TR.cache.set(j.key, zh); applyCached(j.key); }
            else rest.push(j);
          } catch (e) { window.__j7zh.lastErr = String(e && e.message || e); rest.push(j); }
        }
        if (rest.length < jobs.length) { TR.backoff = 0; saveCacheSoon(); }
      }
      if (!rest.length) return;
      // 2) Google（本地不支持的语种 / 本地失败 / 用户指定）
      if (S.engine === 'local' || Date.now() < TR.pauseUntil) { rest.forEach((j) => { TR.failed.set(j.key, Date.now()); removeBlocksFor(j.key); }); return; }
      try {
        const resp = await sendBatch(rest.map((j) => j.text));
        let anyOk = false;
        rest.forEach((j, i) => {
          const zh = resp.results && resp.results[i];
          if (zh) { TR.cache.set(j.key, zh); anyOk = true; applyCached(j.key); }
          else { TR.failed.set(j.key, Date.now()); removeBlocksFor(j.key); }
        });
        if (anyOk) { TR.backoff = 0; saveCacheSoon(); }
        if (resp.paused && resp.paused > 0) TR.pauseUntil = Date.now() + resp.paused;
        else if (!anyOk) { TR.backoff = Math.min(TR.backoff + 1, 6); TR.pauseUntil = Date.now() + BACKOFF[TR.backoff] * 1000; }
      } catch (e) { failJobs(rest); }
    })().catch(() => failJobs(jobs)).finally(() => { TR.busy = false; setTimeout(pump, engineInUse() === 'local' ? 10 : 120); });
  }

  function scanUnits(root) {
    if (!S.trans) return;
    const scope = root && root.nodeType === 1 ? root : document;
    let units;
    try {
      units = scope.matches && scope.matches(TR.UNIT_SEL) ? [scope] : [...scope.querySelectorAll(TR.UNIT_SEL)];
    } catch (e) { return; }
    const paused = engineInUse() !== 'local' && Date.now() < TR.pauseUntil;
    for (const unit of units) {
      if (unit.closest('#j7zh-menu, .j7zh-trans')) continue;
      if (unit.closest('.following-update-content')) {
        const nb0 = unit.nextElementSibling;
        if (nb0 && nb0.classList && nb0.classList.contains('j7zh-trans')) nb0.remove();
        continue;
      }
      const text = unitText(unit);
      if (!needsTranslate(text)) {
        unit.removeAttribute('data-j7zh-key');
        const nb = unit.nextElementSibling;
        if (nb && nb.classList && nb.classList.contains('j7zh-trans')) nb.remove();
        continue;
      }
      const key = hashStr(text);
      if (unit.getAttribute('data-j7zh-key') !== key) unit.setAttribute('data-j7zh-key', key);
      const nxt = unit.nextElementSibling;
      const hasBlock = nxt && nxt.classList && nxt.classList.contains('j7zh-trans') && nxt.getAttribute('data-j7zh-for') === key;
      if (TR.cache.has(key)) { if (!hasBlock || nxt.classList.contains('j7zh-loading')) placeBlock(unit, key, TR.cache.get(key), false); continue; }
      if (hasBlock) continue; // 已在排队/翻译中
      const f = TR.failed.get(key);
      if (f && Date.now() - f < 90000) continue; // 失败的 90 秒后再试
      if (!TR.queued.has(key)) { TR.queued.add(key); TR.queue.push({ key, text }); }
      if (!paused) placeBlock(unit, key, '翻译中…', true);
    }
    pump();
  }

  let scanTimer = null;
  const scanPending = new Set();
  function scheduleScan(node) {
    if (!S.trans) return;
    scanPending.add(node || document.body);
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      const batch = [...scanPending]; scanPending.clear();
      if (batch.some((n) => n === document.body)) scanUnits(document.body);
      else batch.forEach((n) => { if (n.isConnected) scanUnits(n); });
    }, 250);
  }

  /* ---------- 观察器（同步处理，后台标签页里 rAF 不触发） ---------- */
  function handleNode(n) {
    try {
      if (!n.isConnected) return;
      if (n.nodeType === 3) { if (S.ui) processTextNode(n); return; }
      if (n.nodeType !== 1) return;
      if (isOurs(n)) return;
      if (S.ui) walk(n);
      if (S.trans) scheduleScan(n.closest ? (n.closest('.tweet-embed') || n) : n);
    } catch (e) { /* 单个节点出错不影响其它 */ }
  }

  function startObserver() {
    const mo = new MutationObserver((records) => {
      try {
        for (const r of records) {
          if (r.type === 'childList') {
            r.addedNodes.forEach(handleNode);
            // 正文被 React 重绘时可能把我们的译文块一起拿掉，补一次
            if (S.trans && r.removedNodes.length && r.target && r.target.closest && r.target.closest('.tweet-embed')) scheduleScan(r.target.closest('.tweet-embed'));
          } else if (r.type === 'characterData') {
            if (S.ui) handleNode(r.target);
            if (S.trans && r.target.parentElement && r.target.parentElement.closest('.tweet-embed')) scheduleScan(r.target.parentElement.closest('.tweet-embed'));
          } else if (r.type === 'attributes') {
            if (S.ui && r.target.nodeType === 1) processAttrs(r.target);
          }
        }
      } catch (e) { console.error('[j7zh] observer failed', e); }
    });
    mo.observe(document.documentElement, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ATTRS
    });
    window.__j7zh.observer = mo;
  }

  /* ---------- 阅读模式 ---------- */
  function applyReader() {
    document.documentElement.classList.toggle('j7zh-reader', !!S.reader);
  }
  function applyTransFlag() {
    document.documentElement.classList.toggle('j7zh-notrans', !S.trans);
  }

  /* ---------- 右下角按钮 + 菜单 ---------- */
  function mountToggle() {
    if (document.getElementById('j7zh-toggle')) return;
    const btn = document.createElement('button');
    btn.id = 'j7zh-toggle';
    btn.type = 'button';
    btn.textContent = '中';
    btn.title = 'J7 中文扩展：界面汉化 / 阅读模式 / 正文翻译';
    btn.setAttribute('data-on', S.ui ? '1' : '0');
    btn.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(); });
    (document.body || document.documentElement).appendChild(btn);
  }

  function toggleMenu() {
    let m = document.getElementById('j7zh-menu');
    if (m) { m.remove(); return; }
    m = document.createElement('div');
    m.id = 'j7zh-menu';
    m.innerHTML = [
      '<div class="j7zh-menu-title">J7 中文扩展</div>',
      row('ui', '界面汉化', '按钮、菜单、设置项翻成中文（切换会刷新页面）'),
      row('reader', '阅读模式', '卡片收窄居中、图片缩小、行距放宽'),
      row('trans', '正文翻译', '推文 / 引用 / 回复正文翻成中文，附在原文下方'),
      '<div class="j7zh-row j7zh-row-sel"><span class="j7zh-txt"><b>翻译引擎</b><small>本地 = Chrome 内置离线翻译（快、无限流，需 Chrome 138+）；Google = 网页翻译接口（可能限流）</small></span>' +
        '<select id="j7zh-engine">' +
          '<option value="auto"' + (S.engine === 'auto' ? ' selected' : '') + '>自动（本地优先）</option>' +
          '<option value="local"' + (S.engine === 'local' ? ' selected' : '') + (LOCAL.ok ? '' : ' disabled') + '>仅本地</option>' +
          '<option value="google"' + (S.engine === 'google' ? ' selected' : '') + '>仅 Google</option>' +
        '</select></div>',
      '<div class="j7zh-menu-foot" id="j7zh-status">' + statusText() + '</div>',
      '<div class="j7zh-menu-foot">漏翻的界面文字可在 dict.js 里补</div>'
    ].join('');
    function row(key, name, desc) {
      return '<label class="j7zh-row"><input type="checkbox" data-key="' + key + '"' + (S[key] ? ' checked' : '') + '><span class="j7zh-sw"></span><span class="j7zh-txt"><b>' + name + '</b><small>' + desc + '</small></span></label>';
    }
    ['click', 'pointerdown', 'mousedown', 'keydown', 'keyup'].forEach((t) => m.addEventListener(t, (e) => e.stopPropagation()));
    m.addEventListener('change', (e) => {
      const inp = e.target;
      if (inp && inp.id === 'j7zh-engine') {
        S.engine = inp.value; try { localStorage.setItem(LS.engine, S.engine); } catch (err) {}
        // 换引擎：清掉已有译文重翻，方便对比
        TR.cache.clear(); TR.failed.clear(); TR.queue.length = 0; TR.queued.clear(); TR.pauseUntil = 0; TR.backoff = 0;
        try { localStorage.removeItem(CACHE_LS); } catch (err) {}
        document.querySelectorAll('.j7zh-trans').forEach((b) => b.remove());
        document.querySelectorAll('[data-j7zh-key]').forEach((u) => u.removeAttribute('data-j7zh-key'));
        setStatus('idle');
        if (S.trans) scheduleScan(document.body);
        return;
      }
      if (!(inp && inp.dataset && inp.dataset.key)) return;
      const k = inp.dataset.key;
      S[k] = !!inp.checked;
      setFlag(LS[k], S[k]);
      if (k === 'ui') { location.reload(); return; }
      if (k === 'reader') applyReader();
      if (k === 'trans') { applyTransFlag(); setStatus(TR.status); if (S.trans) scheduleScan(document.body); }
    });
    (document.body || document.documentElement).appendChild(m);
    // 点菜单外面 / 按 Esc 关闭；点菜单内部（开关、下拉框）不关
    const close = (ev) => {
      const mm = document.getElementById('j7zh-menu');
      if (!mm) { document.removeEventListener('pointerdown', close, true); document.removeEventListener('keydown', close, true); return; }
      if (ev.type === 'keydown') { if (ev.key !== 'Escape') return; }
      else if (mm.contains(ev.target) || (ev.target.closest && ev.target.closest('#j7zh-toggle'))) return;
      mm.remove();
      document.removeEventListener('pointerdown', close, true);
      document.removeEventListener('keydown', close, true);
    };
    setTimeout(() => { document.addEventListener('pointerdown', close, true); document.addEventListener('keydown', close, true); }, 0);
  }

  /* ---------- 启动 ---------- */
  // 调试钩子（控制台可用 __j7zh.walk(document.body) 手动补扫，__j7zh.scan() 重扫翻译）
  window.__j7zh = { walk, lookup, settings: S, version: '1.2.0', scan: () => scanUnits(document.body), tr: TR, local: LOCAL, engine: engineInUse, lastErr: null };

  document.addEventListener('pointerdown', () => { try { if (LOCAL.ok) LOCAL.retryOnGesture(); } catch (e) {} }, true);
  document.addEventListener('keydown', () => { try { if (LOCAL.ok) LOCAL.retryOnGesture(); } catch (e) {} }, true);

  function firstPass() {
    mountToggle();
    applyReader();
    applyTransFlag();
    if (S.ui) { try { walk(document.body); } catch (e) { console.error('[j7zh] walk failed', e); } }
    if (S.trans) scheduleScan(document.body);
  }

  function boot() {
    firstPass();
    startObserver();
    setTimeout(firstPass, 800);
    setTimeout(firstPass, 3000);
    // 兜底：每 4 秒把缓存里已有的译文补回被重绘掉的卡片（只查 DOM，不发请求）
    setInterval(() => { if (S.trans) scanUnits(document.body); }, 4000);
  }

  if (document.readyState === 'loading') {
    startObserver();
    document.addEventListener('DOMContentLoaded', () => {
      firstPass();
      setTimeout(firstPass, 800);
      setTimeout(firstPass, 3000);
      setInterval(() => { if (S.trans) scanUnits(document.body); }, 4000);
    });
  } else {
    boot();
  }
})();
