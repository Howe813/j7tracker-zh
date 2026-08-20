# J7Tracker 中文界面

> 让 [j7tracker.io](https://j7tracker.io/@howe) 好读的 Chrome 扩展：界面汉化 + 阅读模式 + 推文正文自动翻译。

J7Tracker 是一个实时社媒追踪器，但界面全英文、卡片巨宽、信息密度低。这个扩展把它改造成一个舒服的中文阅读器，四个功能都在页面右下角「中」按钮的菜单里独立开关，默认全开：

| 功能 | 说明 |
| --- | --- |
| **界面汉化** | 900+ 条界面文案（按钮、菜单、设置、弹窗、提示）翻成中文；推文头部动词本地化（`@xxx 发布了 / 回复了 / 转发了 / 引用了 / 关注了`）；时间统一转 24 小时制。**不动**推文正文、币名代码、账号名、简介等用户内容 |
| **阅读模式** | 卡片收窄到 920px 居中、图片缩小、行距放宽、次要按钮 hover 才显示、高亮药丸改细下划线 |
| **点击关键词复制** | 站点会把关键词（AI 预测名、你设置的关键词、CA 等）标成高亮药丸——点一下即复制该词到剪贴板，弹「已复制」气泡；悬停有描边提示。站点原生没有这个能力（药丸默认 `pointer-events: none`，本扩展恢复了它的可点性） |
| **正文翻译** | 推文 / 引用 / 回复 / 资料简介自动翻成中文，以「译」块附在原文下方。默认走 **Chrome 内置离线翻译**（Translator API，快、无限流、不出网），Google 网页接口兜底；带本地缓存，刷新不重翻 |

## 安装

1. 下载本仓库（Code → Download ZIP 并解压，或 `git clone`）
2. Chrome 打开 `chrome://extensions`，右上角开启「开发者模式」
3. 点「加载已解压的扩展程序」，选择本文件夹
4. 打开 / 刷新 [j7tracker.io](https://j7tracker.io/@howe) 即可

> 还没有 J7Tracker 账号？从 [j7tracker.io/@howe](https://j7tracker.io/@howe) 进入并按提示加入 Discord 领取登录凭证。

> 要求 Chrome 内置离线翻译可用需 **Chrome 138+**（更低版本自动退回 Google 接口）。首次翻译某个语种时 Chrome 会静默下载几 MB 的语言包，个别版本要求先在页面上点击一下才允许下载，点一下即可。

## 使用

- 右下角紫色圆点「中」→ 打开菜单：四个功能开关 + 翻译引擎选择（自动 / 仅本地 / 仅 Google），底部显示当前翻译状态与缓存量。
- 「界面汉化」切换会刷新页面；另外两项即时生效。
- 设置存在 j7tracker.io 的 localStorage：`j7zh_enabled` / `j7zh_reader` / `j7zh_autotrans` / `j7zh_copykw` / `j7zh_engine`，译文缓存在 `j7zh_trcache_v1`（约 1500 条滚动）。

## 翻译引擎

| 引擎 | 原理 | 特点 |
| --- | --- | --- |
| 本地（默认优先） | Chrome 内置 Translator API + LanguageDetector，先检测语种再翻译，按段落保留换行 | ~10ms/条，离线，无限流，文本不出本机 |
| Google 兜底 | background service worker 调 `clients5` 批量接口（一批 10 条），失败回退 `gtx` 单条 | 串行 + 最小间隔 + 429 指数退避（5s→5min），带缓存；**会把推文文本发给 Google** |

本地引擎创建失败（如语言包下载中）按临时失败处理，60 秒后自动重试；需要用户手势的下载会在下一次点击页面时自动补上。

## 隐私

- 界面汉化、阅读模式：纯本地，不发任何请求。
- 正文翻译用本地引擎时：不出网。仅当本地不可用 / 语种不支持 / 手动选了 Google 时，推文文本（公开内容，不含你的账号信息）会发给 Google 翻译接口。
- `host_permissions` 只声明了两个 Google 翻译域名，扩展不收集、不上报任何数据。

## 文件说明

| 文件 | 作用 |
| --- | --- |
| `manifest.json` | MV3 清单，只在 `*.j7tracker.io` 运行 |
| `dict.js` | 英→中字典：`exact` 精确匹配、`regex` 带数字/变量的模式（含 12→24 小时制转换）、`context` 推文头部动词、`inButton` 按钮内特殊译法 |
| `content.js` | 界面汉化引擎（文本节点 + placeholder/title/aria-label，MutationObserver 跟 SPA 渲染，正文容器整体排除）+ 正文翻译调度（取文、去重、批量、插「译」块）+ 右下角菜单 |
| `background.js` | service worker：代发 Google 翻译请求（批量、退避、缓存） |
| `style.css` | 阅读模式、译文块、菜单样式；以及让中文按钮按整词排版（CJK 会被 flex 拆成单字竖排）的 `word-break: keep-all` |

## 自己补翻译

页面遇到没翻的英文：

1. 打开 `dict.js`，在 `exact` 里加一行 `"English text": "中文",`（key 与页面文字精确一致；首尾空白忽略、连续空白按一个空格算）
2. 带数字的文案（如 `Showing 50 of 7053`）加到 `regex`；同一个词在按钮里要不同译法加到 `inButton`
3. `chrome://extensions` 点扩展卡片上的刷新 ↻，再刷新页面

调试：控制台 `__j7zh.lookup("Some text", document.body)` 查某句会翻成什么；`__j7zh.walk(document.body)` 手动补扫界面；`__j7zh.scan()` 重扫正文翻译；`__j7zh.tr` 看翻译队列/缓存/失败状态。

## 已知边界

- 字典覆盖主界面、全部设置面板、发币/复刻/自动化/费用/历史/布局/节点/主题等弹窗；站点日后新增文案需补字典。
- 自动化（Automations）面板被站方 Beta 门槛遮罩，遮罩下的表单只翻了可见部分。
- 平台名（Pump、Bonk、Bags、Axiom、GMGN…）和音效名（Ding、Chime…）有意保留英文。
- 推文里币圈黑话（gm、ngl、cooked…）机器翻译效果一般，两个引擎都一样。
