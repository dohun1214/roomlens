// 가구 드래그 실측: 보정을 적용한 뒤 책상을 추가하고 실제 마우스 드래그로 옮겨 본다.
// 실행: node scripts/dev-data/e2e-furniture.mjs [장면]   (준비·환경변수는 e2e-common.mjs 참고)
import path from 'node:path';
import { calibrate, moveCamera, openViewer, round, shotDir, toScreen } from './e2e-common.mjs';

const scene = process.argv[2] ?? '0056_839909';
const { browser, page } = await openViewer(scene);
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail });

const items = async () => JSON.parse(await page.getByTestId('furniture-panel').getAttribute('data-json'));
const camera = () => page.evaluate(() => window.__roomlens.camera.position.toArray());
/** 화면의 한 점을 지나는 광선이 바닥(y=0)과 만나는 점 */
const floorUnder = (screen) =>
  page.evaluate(({ x, y }) => {
    const e = window.__roomlens;
    const rect = e.renderer.domElement.getBoundingClientRect();
    const o = e.camera.position.clone();
    const d = o.clone().set(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1, 0.5)
      .unproject(e.camera).sub(o).normalize();
    const t = -o.y / d.y;
    return [o.x + d.x * t, o.z + d.z * t];
  }, screen);
const drag = async (from, to) => {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 15 });
  await page.mouse.up();
  await page.waitForTimeout(300);
};
const clampToView = (s) => ({ x: Math.min(1270, Math.max(10, s.x)), y: Math.min(790, Math.max(10, s.y)) });

/** 가구 밑면 꼭짓점들이 카메라 맞은편 벽(z가 가장 작은 변)에서 떨어진 거리(m, 방 안쪽이 +)의 최솟값 */
function gapToFarWall(item, polygon) {
  const edges = polygon.map((a, i) => [a, polygon[(i + 1) % polygon.length]]);
  const [a, b] = edges.reduce((best, e) => (e[0][1] + e[1][1] < best[0][1] + best[1][1] ? e : best));
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  let n = [-(b[1] - a[1]) / len, (b[0] - a[0]) / len];
  if (n[1] < 0) n = [-n[0], -n[1]]; // 방 안쪽(+z)을 향하게
  const r = (item.rotationDeg * Math.PI) / 180;
  const [c, s] = [Math.cos(r), Math.sin(r)];
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([i, j]) => {
    const [u, v] = [(i * item.w) / 2, (j * item.d) / 2];
    return [item.x + c * u + s * v, item.z - s * u + c * v];
  });
  return Math.min(...corners.map((p) => (p[0] - a[0]) * n[0] + (p[1] - a[1]) * n[1]));
}

try {
  const { result } = await calibrate(page, scene);
  await page.getByTestId('calibration-apply').click();
  await page.getByTestId('tool-furniture').click();
  const polygon = result.floorPolygon;
  const minZ = Math.min(...polygon.map((p) => p[1])); // 카메라 맞은편 벽

  // 방 좌표(원점 = 모서리 중심)에서 방 안을 내려다본다
  await moveCamera(page, [0.01, 2.6, 2.2], [0, 0, 0]);
  await page.getByRole('button', { name: '+ 책상' }).click();
  await page.waitForTimeout(300);
  let [desk] = await items();
  check('책상이 방 가운데에 놓인다', Math.hypot(desk.x, desk.z) < 0.06, [desk.x, desk.z]);

  // 1) 책상 윗면 가운데를 잡고 바닥의 한 점 쪽으로 끈다
  const camBefore = await camera();
  const grab = await toScreen(page, [desk.x, desk.h, desk.z]);
  const target = await toScreen(page, [1.0, 0, 0.6]);
  const [g, t] = [await floorUnder(grab), await floorUnder(target)];
  await drag(grab, target);
  [desk] = await items();
  const expected = [t[0] - g[0], t[1] - g[1]]; // 처음 위치 (0, 0) + 바닥에서 움직인 만큼
  check('끈 만큼 바닥 위에서 움직인다 (오차 5cm 이내)',
    Math.abs(desk.x - expected[0]) <= 0.05 && Math.abs(desk.z - expected[1]) <= 0.05,
    { got: [round(desk.x), round(desk.z)], expected: expected.map((v) => round(v)) });
  const onGrid = (v) => Math.abs(v / 0.05 - Math.round(v / 0.05)) < 1e-6;
  check('5cm 격자에 맞는다', onGrid(desk.x) && onGrid(desk.z), [desk.x, desk.z]);
  const camAfter = await camera();
  check('가구를 끄는 동안 화면이 돌지 않는다', camBefore.every((v, i) => Math.abs(v - camAfter[i]) < 1e-6), null);
  await page.screenshot({ path: path.join(shotDir, `furniture-${scene}-dragged.png`) });

  // 2) 벽 너머로 끌면 벽에 붙는다
  await drag(await toScreen(page, [desk.x, desk.h, desk.z]), clampToView(await toScreen(page, [desk.x, 0, minZ - 1.5])));
  [desk] = await items();
  check('벽 너머로 끌면 벽에 붙는다', Math.abs(gapToFarWall(desk, polygon)) < 0.005,
    { gapCm: round(gapToFarWall(desk, polygon) * 100, 2) });

  // 3) 90° 회전해도 방 안에 있다
  await page.getByRole('button', { name: '90° 회전' }).click();
  await page.waitForTimeout(300);
  [desk] = await items();
  check('90° 회전 후에도 벽 안쪽에 붙어 있다', desk.rotationDeg === 90 && Math.abs(gapToFarWall(desk, polygon)) < 0.005,
    { rotationDeg: desk.rotationDeg, gapCm: round(gapToFarWall(desk, polygon) * 100, 2) });
  await page.screenshot({ path: path.join(shotDir, `furniture-${scene}-wall.png`) });

  // 4) 빈 곳을 끌면 화면이 돈다 (OrbitControls가 살아 있다)
  const camIdle = await camera();
  // 3D 화면(패널 오른쪽)의 왼쪽 아래: 가구가 없는 바닥
  const stage = await page.getByTestId('stage').boundingBox();
  const empty = { x: stage.x + stage.width * 0.2, y: stage.y + stage.height * 0.65 };
  await drag(empty, { x: empty.x + 120, y: empty.y + 20 });
  const camOrbit = await camera();
  check('빈 곳을 끌면 화면이 돈다', camIdle.some((v, i) => Math.abs(v - camOrbit[i]) > 0.01), null);
  const [same] = await items();
  check('화면을 돌릴 때 가구는 움직이지 않는다', same.x === desk.x && same.z === desk.z, null);

  // 5) 두 번째 가구는 겹치지 않는 빈자리에 놓인다
  const violations = async () => JSON.parse(await page.getByTestId('furniture-panel').getAttribute('data-violations'));
  await moveCamera(page, [0.01, 6, 0.01], [0, 0, 0]); // 바로 위에서 내려다본다
  await page.getByRole('button', { name: '+ 옷장' }).click();
  await page.waitForTimeout(300);
  let ward;
  [desk, ward] = await items();
  check('두 번째 가구(옷장)가 겹치지 않는 자리에 놓이고 문제 없음', (await violations()).length === 0 && (await page.getByTestId('layout-violations').innerText()).includes('문제가 없습니다'), [round(ward.x), round(ward.z)]);

  // 6) 옷장을 책상 위로 끌면 양쪽 모두 겹침으로 표시된다
  const moveItemTo = async (item, x, z) => {
    const grabAt = await toScreen(page, [item.x, item.h, item.z]);
    const under = await floorUnder(grabAt);
    await drag(grabAt, clampToView(await toScreen(page, [under[0] + x - item.x, 0, under[1] + z - item.z])));
  };
  await moveItemTo(ward, desk.x, desk.z);
  [desk, ward] = await items();
  const overlapping = await violations();
  check('옷장을 책상 위로 끌면 두 가구 모두 겹침 표시', overlapping.filter((v) => v.type === 'overlap').length === 2 && (await page.getByTestId('layout-violations').innerText()).includes('겹칩니다'), overlapping.map((v) => v.message));
  await moveCamera(page, [desk.x + 0.4, 2.3, desk.z + 2.6], [desk.x, 0.6, desk.z]); // 방 안에서 비스듬히 (빨간 표시 확인용)
  await page.screenshot({ path: path.join(shotDir, `furniture-${scene}-overlap.png`) });
  // 두 가구와 옮길 자리가 화면 가운데쯤에 오게 위에서 내려다본다 (/viewer는 오른쪽 위에 상태 상자가 있다)
  await moveCamera(page, [(desk.x + 0) / 2 + 0.01, 8, (desk.z + 0.8) / 2 + 0.01], [(desk.x + 0) / 2, 0, (desk.z + 0.8) / 2]);

  // 7) 다시 떼어 놓으면 사라진다
  await moveItemTo(ward, 0, 0.8);
  check('떼어 놓으면 겹침 표시가 사라진다', (await violations()).length === 0, (await items()).map((i) => [i.name, round(i.x), round(i.z)]));

  for (const c of checks) console.log(c.ok ? 'PASS' : 'FAIL', c.name, c.detail ? JSON.stringify(c.detail) : '');
  process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
} finally {
  await browser.close();
}
