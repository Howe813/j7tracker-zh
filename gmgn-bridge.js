/* J7Tracker 中文界面 — GMGN 消息桥（ISOLATED world）
 * gmgn.js 跑在 MAIN world（要摸 React 内部），拿不到 chrome.runtime；
 * 这个小桥收 background 的搜索指令，用 postMessage 转给 MAIN world。
 */
(function () {
  'use strict';
  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg && msg.type === 'j7zh-gmgn-q' && typeof msg.q === 'string') {
        window.postMessage({ __j7zh_gmgn_q: msg.q.slice(0, 80) }, location.origin);
        sendResponse({ ok: true });
      }
      return false;
    });
  } catch (e) {}
})();
