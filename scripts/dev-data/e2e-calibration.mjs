// 보정 화면 실측: InteriorGS 장면에서 평면도 정답 위치를 실제로 클릭해 벽 길이 오차를 잰다.
//
// 준비
//   1) npm run dev (http://localhost:3000)
//   2) 변환 파일 폴더(../roomlens-data/converted)에서 `npx http-server -p 8090 --cors`
//   3) ../roomlens-data/_e2e 에서 `npm i playwright-core` (저장소 의존성으로 넣지 않는다)
// 실행
//   node scripts/dev-data/e2e-calibration.mjs [장면]
// 환경변수
//   CORNER_Y      모서리를 찍을 높이(m). 0 = 바닥 모서리, 2.3 = 가구 위쪽의 벽 모서리 선 (기본 2.3)
//   FLOOR_POINTS  바닥 탭 위치 "x,z;x,z;x,z" (뷰어 좌표). 기본: 방 중심과 대각선 방향 두 곳
//   JITTER_PX     탭 위치에 섞을 오차(px)
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.ROOMLENS_DATA ?? path.resolve(here, '../../../roomlens-data');
const require = createRequire(path.join(dataDir, '_e2e', 'package.json'));
const { chromium } = require('playwright-core');

const scene = process.argv[2] ?? '0056_839909';
const cornerY = Number(process.env.CORNER_Y ?? 2.3);
const jitterPx = Number(process.env.JITTER_PX ?? 0);
const appUrl = process.env.APP_URL ?? 'http://localhost:3000';
const dataUrl = process.env.DATA_URL ?? 'http://localhost:8090';
const shotDir = path.join(dataDir, '_e2e');

// 정답: structure.json 첫 방의 꼭짓점 중 꺾이는 점만 (한 직선 위의 점은 제외)
const structurePath = path.join(dataDir, 'interiorgs', scene, 'structure.json');
if (!existsSync(structurePath)) throw new Error(`structure.json 없음: ${structurePath}`);
const profile = JSON.parse(readFileSync(structurePath, 'utf8')).rooms[0].profile;
const turning = profile.filter((p, i) => {
  const a = profile[(i + profile.length - 1) % profile.length];
  const b = profile[(i + 1) % profile.length];
  return Math.abs((p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0])) > 1e-6;
});
if (turning.length !== 4) throw new Error(`사각형 방이 아님 (꺾이는 꼭짓점 ${turning.length}개)`);
// 뷰어 좌표: (x, z) = (원본 x, -원본 y), 바닥 y = 0
const corners = turning.map(([x, y]) => [x, cornerY, -y]);
const truth = corners.map((c, i) => {
  const n = corners[(i + 1) % 4];
  return Math.hypot(c[0] - n[0], c[2] - n[2]);
});
const center = [0, 2].map((k) => corners.reduce((s, c) => s + c[k], 0) / 4);
const toward = (c, f) => [center[0] + (c[0] - center[0]) * f, center[1] + (c[2] - center[1]) * f];
const floorPoints = process.env.FLOOR_POINTS
  ? process.env.FLOOR_POINTS.split(';').map((s) => s.split(',').map(Number))
  : [center, toward(corners[0], 0.6), toward(corners[2], 0.6)];

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));
await page.goto(`${appUrl}/viewer?url=${dataUrl}/${scene}.sog`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(
  () => document.querySelector('[data-testid=viewer-stats]')?.textContent?.includes('ready'),
  null,
  { timeout: 120000 },
);
await page.getByRole('button', { name: '크기·바닥 보정' }).click();

let seed = 12345;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;

/** 카메라를 옮기고 target이 화면에 찍히는 위치를 클릭한다. */
async function tap(cam, target, shot) {
  const screen = await page.evaluate(
    async ({ cam, target }) => {
      const e = window.__roomlens;
      e.camera.position.set(...cam);
      e.controls.target.set(...target);
      e.camera.near = 0.05;
      e.camera.updateProjectionMatrix();
      e.controls.update();
      await new Promise((r) => setTimeout(r, 2500)); // LOD 갱신 대기
      const v = e.camera.position.clone().set(...target).project(e.camera);
      const rect = e.renderer.domElement.getBoundingClientRect();
      return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height };
    },
    { cam, target },
  );
  await page.mouse.click(screen.x + rand() * jitterPx, screen.y + rand() * jitterPx);
  await page.waitForTimeout(300);
  if (shot) await page.screenshot({ path: path.join(shotDir, shot) });
}

// 1) 바닥 세 곳: 바로 위 2.2m에서 내려다보고 탭
for (const [i, [x, z]] of floorPoints.entries()) {
  await tap([x + 0.01, 2.2, z + 0.01], [x, 0, z], `cal-${scene}-floor${i + 1}.png`);
}
// 2) 모서리 네 곳: 방 안쪽에서 모서리를 바라보고 탭
for (const [i, corner] of corners.entries()) {
  const inward = [center[0] - corner[0], center[1] - corner[2]];
  const len = Math.hypot(inward[0], inward[1]);
  const back = cornerY > 0 ? 1.8 : 1.0;
  const cam = [corner[0] + (inward[0] / len) * back, cornerY > 0 ? 1.5 : 1.4, corner[2] + (inward[1] / len) * back];
  await tap(cam, corner, `cal-${scene}-corner${i + 1}.png`);
}

await page.getByTestId('calibration-length').fill(truth[0].toFixed(3));
if (!(await page.getByTestId('calibration-result').isVisible())) {
  console.log('[panel]', (await page.getByTestId('calibration-panel').innerText()).replace(/\s+/g, ' '));
  await browser.close();
  process.exit(1);
}
const result = JSON.parse(await page.getByTestId('calibration-result').getAttribute('data-json'));
const errors = result.wallLengths.map((len, i) => (len - truth[i]) / truth[i]);

await page.getByTestId('calibration-apply').click();
// 적용 후: 방 좌표(원점 = 모서리 중심, 바닥 y = 0)에서 방 안을 비스듬히 내려다본다
await page.evaluate(async () => {
  const e = window.__roomlens;
  e.controls.target.set(0, 0, 0);
  e.camera.position.set(1.8, 2.4, 1.8);
  e.controls.update();
  await new Promise((r) => setTimeout(r, 2500));
});
await page.screenshot({ path: path.join(shotDir, `cal-${scene}-applied.png`) });

const round = (v, d = 3) => +v.toFixed(d);
console.log(JSON.stringify({
  scene,
  cornerY,
  jitterPx,
  truth: truth.map((v) => round(v)),
  measured: result.wallLengths.map((v) => round(v)),
  errorPct: errors.map((v) => round(v * 100, 2)),
  maxErrorPct: round(Math.max(...errors.map(Math.abs)) * 100, 2),
  floorTapHeightsCm: result.floorPoints.map((p) => round(p[1] * 100, 1)), // 정답 0
  cornerHeights: result.cornerHeights.map((v) => round(v, 2)), // 정답 cornerY
  scale: round(result.scale, 4), // 정답 1 (이미 m 단위)
}));
await browser.close();
