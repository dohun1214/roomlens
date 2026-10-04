// 뷰어 화질 설정 실측: 기기별 기본값과 주소 값(?lod= ?pr=)이 실제로 그리는 스플랫 수·배율을 바꾸는지 본다.
// 준비: npm run dev, ../roomlens-data/converted 에서 `npx http-server -p 8090 --cors`
// 실행: node scripts/dev-data/e2e-viewer-quality.mjs [장면 이름]   (100만 스플랫 이상인 장면이어야 한다)
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.ROOMLENS_DATA ?? path.resolve(here, '../../../roomlens-data');
const require = createRequire(path.join(dataDir, '_e2e', 'package.json'));
const { chromium } = require('playwright-core');

const appUrl = process.env.APP_URL ?? 'http://localhost:3000';
const dataUrl = process.env.DATA_URL ?? 'http://localhost:8090';
const scene = process.argv[2] ?? '0056_839909';
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'],
});

/** 장면을 열고 LOD가 자리 잡은 뒤의 "그리는 수"와 배율을 읽는다 */
async function measure(contextOptions, query = '') {
  const { platform, ...options } = contextOptions;
  const context = await browser.newContext(options);
  // Spark의 isMobile()은 navigator.platform이 win으로 시작하면 폰이 아니라고 본다 → 폰 흉내를 낼 때는 바꿔 준다
  if (platform) await context.addInitScript((value) => Object.defineProperty(navigator, 'platform', { get: () => value }), platform);
  // 로딩 표시가 어떻게 바뀌는지 처음부터 기록한다
  await context.addInitScript(() => {
    window.__loading = [];
    const record = () => {
      const el = document.querySelector('[data-testid=viewer-loading]');
      if (el) window.__loading.push(`${el.getAttribute('data-phase')}:${el.getAttribute('data-percent')}`);
    };
    new MutationObserver(record).observe(document, { subtree: true, childList: true, attributes: true });
  });
  const page = await context.newPage();
  await page.goto(`${appUrl}/viewer?url=${dataUrl}/${scene}.sog${query}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('[data-testid=viewer-stats]')?.textContent?.includes('ready'), null, { timeout: 120000 });
  await page.waitForTimeout(5000);
  const el = page.getByTestId('viewer-drawn');
  const result = {
    drawn: Number(await el.getAttribute('data-drawn')),
    pixelRatio: Number(await el.getAttribute('data-pixel-ratio')),
    motion: await el.getAttribute('data-motion'),
    loading: await page.evaluate(() => [...new Set(window.__loading)]),
    loadingGone: (await page.getByTestId('viewer-loading').count()) === 0,
    downloadMs: Number(await page.getByTestId('viewer-load-time').getAttribute('data-download-ms')),
    loadMs: Number(await page.getByTestId('viewer-load-time').getAttribute('data-load-ms')),
  };
  await context.close();
  return result;
}

try {
  const desktop = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 };
  const phone = { viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, userAgent: IPHONE_UA, hasTouch: true, platform: 'iPhone' };

  const d = await measure(desktop);
  check('데스크톱 기본: 폰 기본값(80만)보다 많이 그림, 배율 1.5까지', d.drawn > 800_000 && d.pixelRatio === 1.5, d);

  const percents = d.loading.filter((s) => s.startsWith('download:')).map((s) => Number(s.split(':')[1]));
  check('로딩 중: 받는 퍼센트가 올라간 뒤 준비 단계로 넘어감', percents.some((v) => v > 0 && v < 100) && d.loading.includes('prepare:100'), d.loading.slice(0, 8));
  check('로딩이 끝나면 표시가 사라지고 받기·준비 시간이 나뉘어 나옴', d.loadingGone && d.downloadMs > 0 && d.loadMs > d.downloadMs, { downloadMs: d.downloadMs, loadMs: d.loadMs });

  const dLod = await measure(desktop, '&lod=300000&pr=1');
  check('데스크톱 ?lod=300000&pr=1: 30만 개 이하, 배율 1', dLod.drawn > 0 && dLod.drawn <= 300_000 && dLod.pixelRatio === 1, dLod);

  const p = await measure(phone);
  check('폰 기본: 80만 개 이하, 배율 1.25', p.drawn > 0 && p.drawn <= 800_000 && p.pixelRatio === 1.25, p);

  const motion = await measure(phone, '&sort=200&fov=off');
  check('폰 ?sort=200&fov=off: 정렬 200ms, 시야 집중 끔으로 열리고 80만 개 이하', motion.motion === '정렬 200ms · 시야 집중 끔' && motion.drawn > 0 && motion.drawn <= 800_000, motion);
  check('폰 기본은 정렬 200ms, 시야 집중 켬', p.motion === '정렬 200ms · 시야 집중 켬', p.motion);
  check('데스크톱 기본은 정렬 0ms, 시야 집중 켬', d.motion === '정렬 0ms · 시야 집중 켬', d.motion);

  const pLod = await measure(phone, '&lod=1500000&pr=2');
  check('폰 ?lod=1500000&pr=2: 기본값보다 많이 그리고 배율 2', pLod.drawn > 800_000 && pLod.pixelRatio === 2, pLod);
} catch (err) {
  check('예외 없이 끝까지 실행', false, String(err).slice(0, 300));
} finally {
  await browser.close();
}

for (const c of checks) console.log(c.ok ? 'PASS' : 'FAIL', c.name, c.detail ? JSON.stringify(c.detail) : '');
process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
