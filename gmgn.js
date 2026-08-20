/* J7Tracker 中文界面 — GMGN 自动搜索
 * 从 j7tracker 点击关键词跳过来时，URL 带 #j7q=<关键词>；
 * 本脚本等页面就绪后自动打开 GMGN 的搜索弹窗并填入关键词（触发其 React onChange）。
 * 没有 #j7q 标记时什么都不做。
 */
(function () {
  'use strict';
  let timer = null;

  function currentKw() {
    const m = location.hash.match(/[#&]j7q=([^&]+)/);
    if (!m) return '';
    let kw = '';
    try { kw = decodeURIComponent(m[1]); } catch (e) { return ''; }
    return kw.trim().slice(0, 80);
  }

  const HEADER_RE = /搜索代币|Search token/i;
  const MODAL_RE = /搜名称|Search name|KOL|ticker|contract address/i;

  // 打开搜索弹窗：GMGN 首次打开要求可信事件，合成 click 不行；
  // 但直接调用输入框 React props 上的 onFocus 处理函数可以（因此本脚本必须跑在 MAIN world）。
  function tryOpen(el) {
    try {
      const k = Object.keys(el).find((x) => x.indexOf('__reactProps$') === 0);
      const props = k ? el[k] : null;
      if (props && typeof props.onFocus === 'function') {
        props.onFocus({ preventDefault() {}, stopPropagation() {}, target: el, currentTarget: el });
        return;
      }
    } catch (e) {}
    // 兜底：合成点击序列（弹窗已挂载过时有效）
    const r = el.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
    for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      el.dispatchEvent(t.indexOf('pointer') === 0 ? new PointerEvent(t, opts) : new MouseEvent(t, opts));
    }
    el.focus();
  }

  function setReactInput(inp, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    inp.focus();
    setter.call(inp, value);
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function findInput(re, exclude) {
    return [...document.querySelectorAll('input')].find((i) =>
      i !== exclude && re.test(i.placeholder || '') && i.getBoundingClientRect().width > 0);
  }

  function run() {
    const kw = currentKw();
    if (!kw) return;
    // 清掉标记，避免用户刷新时重复触发
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
    if (timer) { clearInterval(timer); timer = null; }
    let tries = 0;
    timer = setInterval(() => {
      tries++;
      if (tries > 60) { clearInterval(timer); timer = null; return; } // ~18 秒放弃

      // 弹窗已开：直接填
      const header = findInput(HEADER_RE);
      const modalInp = findInput(MODAL_RE, header);
      if (modalInp) {
        clearInterval(timer); timer = null;
        setReactInput(modalInp, kw);
        // 有些版本首次 input 会被防抖吞掉，稍后补一发
        setTimeout(() => { if (modalInp.isConnected && modalInp.value !== kw) setReactInput(modalInp, kw); }, 800);
        return;
      }
      // 否则先点头部搜索框把弹窗打开
      if (header) tryOpen(header);
    }, 300);
  }

  // 首次加载 + 同一标签页被复用（只变 hash，不重新加载）都要触发
  window.addEventListener('hashchange', run);
  run();
})();
