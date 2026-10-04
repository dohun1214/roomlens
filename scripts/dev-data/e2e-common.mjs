// 실측 스크립트 공통 부분: 정답 평면도 읽기, headless Chrome으로 뷰어 열기, 보정까지 진행하기.
//
// 준비
//   1) npm run dev (http://localhost:3000)
//   2) 변환 파일 폴더(../roomlens-data/converted)에서 `npx http-server -p 8090 --cors`
//   3) ../roomlens-data/_e2e 에서 `npm i playwright-core` (저장소 의존성으로 넣지 않는다)
// 환경변수
//   CORNER_Y      모서리를 찍을 높이(m). 0 = 바닥 모서리, 기본 2.3 = 가구 위쪽의 벽 모서리 선
//   FLOOR_POINTS  바닥 탭 위치 "x,z;x,z;x,z" (뷰어 좌표). 장면마다 바닥이 보이는 곳을 지정
//   JITTER_PX     탭 위치에 섞을 오차(px)
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const dataDir = process.env.ROOMLENS_DATA ?? path.resolve(here, '../../../roomlens-data');
export const shotDir = path.join(dataDir, '_e2e');
const require = createRequire(path.join(shotDir, 'package.json'));
const { chromium } = require('playwright-core');

const appUrl = process.env.APP_URL ?? 'http://localhost:3000';
const dataUrl = process.env.DATA_URL ?? 'http://localhost:8090';
// 장면별로 바닥이 보이는 곳 (뷰어 좌표 x, z). 한 줄에 놓이지 않게 고른다.
const KNOWN_FLOOR_POINTS = {
  '0056_839909': [[-0.12, -0.18], [3.2, 0.0], [0.2, 3.4]],
};

/** structure.json에서 사각형 방의 정답 모서리(뷰어 좌표)와 벽 길이를 읽는다. */
export function loadTruth(scene, cornerY) {
  const structurePath = path.join(dataDir, 'interiorgs', scene, 'structure.json');
  if (!existsSync(structurePath)) throw new Error(`structure.json 없음: ${structurePath}`);
  const profile = JSON.parse(readFileSync(structurePath, 'utf8')).rooms[0].profile;
  // 꺾이는 꼭짓점만 (한 직선 위의 점은 제외)
  const turning = profile.filter((p, i) => {
    const a = profile[(i + profile.length - 1) % profile.length];
    const b = profile[(i + 1) % profile.length];
    return Math.abs((p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0])) > 1e-6;
  });
  if (turning.length !== 4) throw new Error(`사각형 방이 아님 (꺾이는 꼭짓점 ${turning.length}개)`);
  // 뷰어 좌표: (x, z) = (원본 x, -원본 y), 바닥 y = 0
  const corners = turning.map(([x, y]) => [x, cornerY, -y]);
  const wallLengths = corners.map((c, i) => {
    const n = corners[(i + 1) % 4];
    return Math.hypot(c[0] - n[0], c[2] - n[2]);
  });
  const center = [0, 2].map((k) => corners.reduce((s, c) => s + c[k], 0) / 4);
  return { corners, wallLengths, center };
}

export async function openViewer(scene) {
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
  return { browser, page };
}

/** 카메라를 옮기고 화면이 갱신될 때까지 기다린다. */
export async function moveCamera(page, position, target, waitMs = 2500) {
  await page.evaluate(
    async ({ position, target, waitMs }) => {
      const e = window.__roomlens;
      e.camera.position.set(...position);
      e.controls.target.set(...target);
      e.camera.near = 0.05;
      e.camera.updateProjectionMatrix();
      e.controls.update();
      await new Promise((r) => setTimeout(r, waitMs)); // LOD 갱신 대기
    },
    { position, target, waitMs },
  );
}

/** 월드 좌표의 점이 화면에 찍히는 위치(px) */
export function toScreen(page, point) {
  return page.evaluate((point) => {
    const e = window.__roomlens;
    const v = e.camera.position.clone().set(...point).project(e.camera);
    const rect = e.renderer.domElement.getBoundingClientRect();
    return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height };
  }, point);
}

/**
 * 보정 패널을 열고 바닥 3곳 + 모서리 4곳을 실제로 클릭한 뒤 벽 1 길이를 입력한다.
 * @returns 화면에 표시된 보정 결과(data-json)와 정답
 */
export async function calibrate(page, scene, { shots = false, alreadyOpen = false } = {}) {
  const cornerY = Number(process.env.CORNER_Y ?? 2.3);
  const jitterPx = Number(process.env.JITTER_PX ?? 0);
  const truth = loadTruth(scene, cornerY);
  const { corners, center } = truth;
  const toward = (c, f) => [center[0] + (c[0] - center[0]) * f, center[1] + (c[2] - center[1]) * f];
  const floorPoints = process.env.FLOOR_POINTS
    ? process.env.FLOOR_POINTS.split(';').map((s) => s.split(',').map(Number))
    : (KNOWN_FLOOR_POINTS[scene] ?? [center, toward(corners[0], 0.6), toward(corners[1], 0.6)]);

  let seed = 12345;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
  const tap = async (position, target, shot) => {
    await moveCamera(page, position, target);
    const s = await toScreen(page, target);
    await page.mouse.click(s.x + rand() * jitterPx, s.y + rand() * jitterPx);
    await page.waitForTimeout(300);
    if (shots) await page.screenshot({ path: path.join(shotDir, shot) });
  };

  // "다시 찍기" 직후처럼 보정 패널이 이미 열려 있으면 여는 버튼이 없다
  if (!alreadyOpen) await page.getByRole('button', { name: '크기·바닥 보정' }).click();
  // 1) 바닥 세 곳: 바로 위 2.2m에서 내려다보고 탭
  for (const [i, [x, z]] of floorPoints.entries()) {
    await tap([x + 0.01, 2.2, z + 0.01], [x, 0, z], `cal-${scene}-floor${i + 1}.png`);
  }
  // 2) 모서리 네 곳: 방 안쪽에서 모서리를 바라보고 탭
  for (const [i, corner] of corners.entries()) {
    const inward = [center[0] - corner[0], center[1] - corner[2]];
    const len = Math.hypot(inward[0], inward[1]);
    const back = cornerY > 0 ? 1.8 : 1.0;
    const eye = [corner[0] + (inward[0] / len) * back, cornerY > 0 ? 1.5 : 1.4, corner[2] + (inward[1] / len) * back];
    await tap(eye, corner, `cal-${scene}-corner${i + 1}.png`);
  }
  // 모서리 수가 정해져 있지 않으므로 다 찍었다고 알려 준다
  await page.getByTestId('calibration-corners-done').click();
  await page.getByTestId('calibration-length').fill(truth.wallLengths[0].toFixed(3));

  if (!(await page.getByTestId('calibration-result').isVisible())) {
    const panel = (await page.getByTestId('calibration-panel').innerText()).replace(/\s+/g, ' ');
    throw new Error(`보정 결과가 나오지 않음: ${panel}`);
  }
  const result = JSON.parse(await page.getByTestId('calibration-result').getAttribute('data-json'));
  return { result, truth, cornerY, jitterPx };
}

export const round = (v, d = 3) => +v.toFixed(d);
