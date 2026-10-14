// 둘러보기 조작 실측: 끌기(제자리에서 돌기), 휠(다가가기), 오른쪽·Shift 끌기(옆으로), 두 손가락(벌리기·끌기),
// 보정 뒤 격자가 방 안에만 그려지는지, 화면 밖이 아닌 곳에 새 가구가 놓이는지.
// 실행: node scripts/dev-data/e2e-view-controls.mjs [장면]   (준비·환경변수는 e2e-common.mjs 참고)
import { calibrate, moveCamera, openViewer, round } from './e2e-common.mjs';

const scene = process.argv[2] ?? '0056_839909';
const { browser, page } = await openViewer(scene);
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail });

const pose = () =>
  page.evaluate(() => {
    const e = window.__roomlens;
    return { position: e.camera.position.toArray(), dir: e.camera.getWorldDirection(e.camera.position.clone()).toArray() };
  });
const sub = (a, b) => a.map((v, i) => v - b[i]);
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const len = (v) => Math.hypot(...v);
const settle = () => page.waitForTimeout(700);
/** 방 가운데 눈높이에서 -z 쪽을 본다 */
const stand = () => moveCamera(page, [0, 1.5, 1], [0, 1.2, -2], 800);

try {
  const { result } = await calibrate(page, scene);
  const polygon = result.floorPolygon; // 보정 뒤 방 좌표 (벽 1이 어느 축이 될지는 찍은 순서에 따라 다르다)
  check('모서리 찍기에 "가까이 가서 찍으라"는 안내', (await page.getByTestId('calibration-near-hint').innerText()).includes('다가가서'), null);
  await page.getByTestId('calibration-apply').click();
  await page.evaluate(() => document.activeElement?.blur());
  const stage = await page.getByTestId('stage').boundingBox();
  const mid = { x: stage.x + stage.width * 0.55, y: stage.y + stage.height * 0.45 };

  // 1) 보정 뒤 격자: 방 안쪽 바닥에만
  const grid = await page.evaluate(() => {
    const out = [];
    window.__roomlens.scene.traverse((o) => {
      if (o.type === 'LineSegments' && o.visible) out.push(Array.from(o.geometry.attributes.position.array));
    });
    return out;
  });
  const half = [Math.max(...polygon.map((p) => Math.abs(p[0]))), Math.max(...polygon.map((p) => Math.abs(p[1])))];
  const gridPoints = grid.flatMap((a) => Array.from({ length: a.length / 3 }, (_, i) => [a[i * 3], a[i * 3 + 2]]));
  check('보정 뒤 1m 격자는 방 안쪽 바닥에만 그린다', gridPoints.length > 0 && gridPoints.every(([x, z]) => Math.abs(x) <= half[0] + 0.1 && Math.abs(z) <= half[1] + 0.1), { points: gridPoints.length, half: half.map((v) => round(v)) });

  // 2) 끌기: 제자리에서 고개 돌리기
  await stand();
  let before = await pose();
  await page.mouse.move(mid.x, mid.y);
  await page.mouse.down();
  await page.mouse.move(mid.x + 200, mid.y, { steps: 15 });
  await page.mouse.up();
  await settle();
  let after = await pose();
  const turnedDeg = (Math.acos(Math.max(-1, Math.min(1, dot(before.dir, after.dir)))) * 180) / Math.PI;
  check('끌면 제자리에서 돈다 (자리는 15cm 안, 20° 넘게 돎)', len(sub(after.position, before.position)) < 0.15 && turnedDeg > 20, { turnedDeg: round(turnedDeg, 1), movedCm: round(len(sub(after.position, before.position)) * 100, 1) });
  // 잡아 끄는 쪽으로 화면이 따라온다: 오른쪽으로 끌면 왼쪽(-x)을 보게 된다
  check('오른쪽으로 끌면 화면이 손을 따라와 왼쪽을 보게 된다', after.dir[0] < before.dir[0] - 0.1, [round(before.dir[0]), round(after.dir[0])]);

  // 3) 휠: 보는 쪽으로 다가가기
  await stand();
  before = await pose();
  await page.mouse.move(mid.x, mid.y);
  for (let i = 0; i < 3; i += 1) {
    await page.mouse.wheel(0, -100);
    await page.waitForTimeout(80);
  }
  await settle();
  after = await pose();
  const wheelMove = sub(after.position, before.position);
  check('휠을 위로 세 칸: 보는 쪽으로 약 0.9m 다가간다', Math.abs(dot(wheelMove, before.dir) - 0.9) < 0.15 && len(wheelMove) < 1.05, { along: round(dot(wheelMove, before.dir)) });
  await page.mouse.wheel(0, 300);
  await settle();
  const back = await pose();
  check('휠을 아래로: 물러난다', dot(sub(back.position, after.position), before.dir) < -0.5, round(dot(sub(back.position, after.position), before.dir)));

  // 4) 오른쪽 끌기·Shift+끌기: 옆으로 (화면이 손을 따라오므로 카메라는 반대로)
  for (const [label, how] of [['오른쪽 버튼', { button: 'right' }], ['Shift+끌기', { shift: true }]]) {
    await stand();
    before = await pose();
    if (how.shift) await page.keyboard.down('Shift');
    await page.mouse.move(mid.x, mid.y);
    await page.mouse.down({ button: how.button ?? 'left' });
    await page.mouse.move(mid.x + 200, mid.y, { steps: 15 });
    await page.mouse.up({ button: how.button ?? 'left' });
    if (how.shift) await page.keyboard.up('Shift');
    await settle();
    after = await pose();
    const moved = sub(after.position, before.position);
    check(`${label}로 오른쪽으로 끌면 카메라가 왼쪽(-x)으로 0.6~1.3m, 보는 방향은 그대로`, moved[0] < -0.6 && moved[0] > -1.3 && Math.abs(moved[1]) < 0.02 && len(sub(after.dir, before.dir)) < 1e-3, moved.map((v) => round(v)));
  }

  // 5) 두 손가락 (폰): 벌리면 다가가고, 같이 끌면 옆으로
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  const touch = async (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
  const twoFingers = async (from, to) => {
    await touch('touchStart', from);
    for (let i = 1; i <= 10; i += 1) {
      await touch('touchMove', from.map((p, k) => [p[0] + ((to[k][0] - p[0]) * i) / 10, p[1] + ((to[k][1] - p[1]) * i) / 10]));
      await page.waitForTimeout(16);
    }
    await touch('touchEnd', []);
    await settle();
  };
  await stand();
  before = await pose();
  await twoFingers([[mid.x - 40, mid.y], [mid.x + 40, mid.y]], [[mid.x - 140, mid.y], [mid.x + 140, mid.y]]);
  after = await pose();
  check('두 손가락을 벌리면 보는 쪽으로 다가간다', dot(sub(after.position, before.position), before.dir) > 0.5, round(dot(sub(after.position, before.position), before.dir)));
  await stand();
  before = await pose();
  await twoFingers([[mid.x - 60, mid.y], [mid.x + 60, mid.y]], [[mid.x + 90, mid.y], [mid.x + 210, mid.y]]);
  after = await pose();
  const swiped = sub(after.position, before.position);
  check('두 손가락을 같이 오른쪽으로 끌면 카메라가 왼쪽으로, 보는 방향은 그대로', swiped[0] < -0.4 && len(sub(after.dir, before.dir)) < 0.02, swiped.map((v) => round(v)));
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });

  // 6) 창가 가까이에서 가구를 추가하면 지금 보이는 곳에 놓인다 (방 가운데가 화면 밖일 때)
  await page.getByTestId('tool-furniture').click();
  await moveCamera(page, [-half[0] + 2.4, 1.5, 0], [-half[0], 1.2, 0], 1500); // "3D에서 보기"처럼 왼쪽 벽(창문)을 2.4m 앞에서 본다
  await page.getByRole('button', { name: '+ 책상 · 서랍형', exact: true }).click();
  await page.waitForTimeout(500);
  const [desk] = JSON.parse(await page.getByTestId('furniture-panel').getAttribute('data-json'));
  const visible = await page.evaluate(({ x, z }) => {
    const e = window.__roomlens;
    const p = e.camera.position.clone().set(x, 0.37, z).project(e.camera);
    return Math.abs(p.x) < 1 && Math.abs(p.y) < 1 && p.z < 1;
  }, desk);
  check('방 가운데가 화면 밖이면 새 가구는 지금 보는 쪽 바닥(화면 안)에 놓인다', visible && desk.x < -half[0] + 2, [round(desk.x), round(desk.z)]);
} catch (err) {
  check('예외 없이 끝까지 실행', false, String(err).slice(0, 300));
} finally {
  for (const c of checks) console.log(c.ok ? 'PASS' : 'FAIL', c.name, c.detail ? JSON.stringify(c.detail) : '');
  process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
  await browser.close();
}
