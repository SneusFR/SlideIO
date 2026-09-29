// node jettest.cjs '<optsJSON>' '[steps]'  — steps: {"js":"..."} | {"step":[dt,n]} | {"shot":"name"}
const { chromium } = require('/home/claude/.npm-global/lib/node_modules/playwright');
const fs = require('fs'), path = require('path');
const THREE_DIR = '/tmp/threejs';
(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const logs = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  await page.route('https://cdn.jsdelivr.net/npm/three@0.169.0/**', (route) => {
    const rel = route.request().url().split('three@0.169.0/')[1];
    const f = path.join(THREE_DIR, rel);
    if (!fs.existsSync(f)) return route.fulfill({ status: 404, body: 'missing ' + rel });
    route.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(f) });
  });
  await page.goto('http://localhost:8767/jettest.html?o=' + encodeURIComponent(process.argv[2] || '{}'));
  try { await page.waitForFunction(() => window.ready, null, { timeout: 60000 }); } catch (e) { console.log(logs.join('\n')); throw e; }
  const script = JSON.parse(process.argv[3] || '[]');
  for (const s of script) {
    if (s.js) await page.evaluate(s.js);
    if (s.step) await page.evaluate(`window.step(${s.step[0]}, ${s.step[1] || 1})`);
    if (s.views) { for (const v of s.views) { await page.evaluate(`window.view='${v}'; window.render()`); await page.screenshot({ path: `/home/claude/wf/shots/${s.name}_${v}.png` }); } }
    if (s.shot) await page.screenshot({ path: `/home/claude/wf/shots/${s.shot}.png` });
  }
  console.log(logs.filter(l => !l.includes('THREE.WebGLRenderer')).join('\n'));
  await browser.close();
})();
