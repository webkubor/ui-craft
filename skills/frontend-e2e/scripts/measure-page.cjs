const { spawnSync } = require('node:child_process');

// 用法：node measure-page.cjs <URL> <选择器> [--mock <mockJsonFile>]
//
// 对**已部署**页面做真实渲染度量：走真实前端代码路径，量 getComputedStyle 的实际值
// （不是量源码，不是看 class 名）。用于「原型要求 32px/13px/600，实际是多少」这类验收。
//
// --mock <file>：登录态拿不到时，用 fetch 覆写注入测试数据。
//   文件是一段 JS，形如：
//     { "/auth/session": {...}, "/platform-config": {...} }
//   key 是 URL 子串，value 是要返回的 JSON body。
//   注入点在任何页面脚本之前（CDP Page.addScriptToEvaluateOnNewDocument），
//   所以首屏请求就能拦到。
//
// 输出 JSON 到 stdout：度量结果 + 截图路径。

const url = process.argv[2];
const selector = process.argv[3];
const mockIdx = process.argv.indexOf('--mock');
const mockFile = mockIdx > 0 ? process.argv[mockIdx + 1] : null;

if (!url || !selector) {
  console.error('Usage: node measure-page.cjs <URL> <selector> [--mock <mockJsonFile>]');
  process.exit(1);
}

const fs = require('node:fs');
const mockMap = mockFile ? JSON.parse(fs.readFileSync(mockFile, 'utf-8')) : null;
const shotPath = process.env.SHOT_PATH || '/tmp/measure-page.png';

const mockSource = mockMap
  ? `
(function () {
  const MOCK = ${JSON.stringify(mockMap)};
  const origFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const u = typeof input === 'string' ? input : (input && input.url) || '';
    for (const key of Object.keys(MOCK)) {
      if (u.indexOf(key) >= 0) {
        return Promise.resolve(new Response(JSON.stringify(MOCK[key]), {
          status: 200, headers: { 'content-type': 'application/json' },
        }));
      }
    }
    return origFetch(input, init);
  };
})();`
  : null;

const egoProgram = `
const task = await taskSpace('measure page');
const page = task.page('p1');
${mockSource ? `await page.cdp('Page.enable');\nawait page.cdp('Page.addScriptToEvaluateOnNewDocument', { source: ${JSON.stringify(mockSource)} });` : ''}
await page.goto(${JSON.stringify(url)}, { waitUntil: 'domcontentloaded' });

let found = true;
try { await page.waitForSelector(${JSON.stringify(selector)}, { timeout: 15000 }); }
catch (e) { found = false; }

const data = await page.evaluate((sel) => {
  const el = document.querySelector(sel);
  if (!el) return { error: 'selector not found', url: location.href, bodyText: document.body.innerText.slice(0, 300) };
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const out = {
    url: location.href,
    selector: sel,
    className: el.className,
    text: el.innerText.replace(/\\s+/g, ' ').trim().slice(0, 200),
    height: cs.height, width: cs.width,
    fontSize: cs.fontSize, fontWeight: cs.fontWeight,
    fontVariantNumeric: cs.fontVariantNumeric,
    lineHeight: cs.lineHeight,
    color: cs.color, backgroundColor: cs.backgroundColor,
    borderRadius: cs.borderRadius,
    rect: { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) },
    viewport: { w: window.innerWidth, h: window.innerHeight },
    overflowsLeft: r.left < 0,
    overflowsRight: r.right > window.innerWidth,
    attrs: Object.fromEntries(Array.from(el.attributes).map(a => [a.name, a.value])),
  };
  const panel = document.querySelector('[role="dialog"]');
  if (panel) {
    const pcs = getComputedStyle(panel);
    const pr = panel.getBoundingClientRect();
    out.dialog = {
      id: panel.getAttribute('id'),
      ariaLabel: panel.getAttribute('aria-label'),
      width: pcs.width,
      text: panel.innerText.replace(/\\s+/g, ' ').trim().slice(0, 300),
      rect: { top: Math.round(pr.top), left: Math.round(pr.left), right: Math.round(pr.right) },
      overflowsLeft: pr.left < 0,
      overflowsRight: pr.right > window.innerWidth,
    };
  }
  return out;
}, ${JSON.stringify(selector)});

try { await page.screenshot({ path: ${JSON.stringify(shotPath)} }); data.screenshot = ${JSON.stringify(shotPath)}; }
catch (e) { data.screenshotError = String(e.message || e); }

cliLog(JSON.stringify(data, null, 2));
await completeTaskSpace(task.id, { keep: false });
`;

const result = spawnSync('ego-browser', ['nodejs'], { input: egoProgram, encoding: 'utf8', stdio: ['pipe', 'inherit', 'inherit'] });
process.exit(result.status || 0);
