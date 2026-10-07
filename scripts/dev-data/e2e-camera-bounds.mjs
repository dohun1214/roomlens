// 카메라를 방 안에 머물게 하기 실측: 키·휠로 벽·바닥·천장 쪽으로 밀어 보고 어디서 멈추는지 잰다.
// 실행: node scripts/dev-data/e2e-camera-bounds.mjs [장면]   (준비·환경변수는 e2e-common.mjs 참고)
import { calibrate, moveCamera, openViewer, round } from './e2e-common.mjs';

const scene = process.argv[2] ?? '0056_839909';
const { browser, page } = await openViewer(scene);
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail });
const MARGIN = 0.2;

const pose = () =>
  page.evaluate(() => {
    const e = window.__roomlens;
    return { position: e.camera.position.toArray(), target: e.controls.target.toArray() };
  });
/** 방 안의 자리로 옮긴 뒤 가두기를 다시 켠다 (moveCamera는 실측용으로 가두기를 끈다) */
const standAt = async (position, target) => {
  await moveCamera(page, position, target, 600);
  await page.evaluate(() => {
    window.__roomlens.freeCamera = false;
  });
  await page.waitForTimeout(200);
};
const hold = async (keys, ms) => {
  for (const key of keys) await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  for (const key of [...keys].reverse()) await page.keyboard.up(key);
  await page.waitForTimeout(300);
  return pose();
};

try {
  check('보정 전에는 "방 안에서만"이 없다', (await page.getByTestId('stay-inside').count()) === 0, null);

  const { result } = await calibrate(page, scene);
  await page.getByTestId('calibration-apply').click();
  await page.evaluate(() => document.activeElement?.blur());
  const polygon = result.floorPolygon;
  const xs = polygon.map((p) => p[0]);
  const zs = polygon.map((p) => p[1]);
  const [minX, maxX, minZ, maxZ] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
  // 사각형 방이므로 테두리 상자로 안팎을 본다
  const inside = (p, margin = MARGIN - 0.005) => p[0] >= minX + margin && p[0] <= maxX - margin && p[2] >= minZ + margin && p[2] <= maxZ - margin;
  const toggle = page.getByTestId('stay-inside');
  check('보정하면 "방 안에서만"이 켜진 채로 보인다', (await toggle.getAttribute('aria-checked')) === 'true', await toggle.innerText());

  // 1) 벽 쪽으로 오래 걷기: 벽에서 20cm 앞에 멈춘다
  await standAt([0, 1.5, 0], [0, 1.2, -2]);
  const start = await pose();
  const wall = await hold(['ShiftLeft', 'KeyW'], 2500); // 막지 않으면 10m
  check('벽 쪽으로 계속 걸어도 벽 20cm 앞에서 멈춘다', Math.abs(wall.position[2] - (minZ + MARGIN)) < 0.01 && Math.abs(wall.position[0]) < 0.02, { z: round(wall.position[2]), wallZ: round(minZ) });
  const offset = (q) => q.target.map((v, i) => v - q.position[i]);
  check('돌리는 중심도 막힌 만큼만 따라온다 (벽 너머로 달아나지 않음)', offset(wall).every((v, i) => Math.abs(v - offset(start)[i]) < 1e-6), offset(wall).map((v) => round(v)));

  // 2) 벽에 붙은 채 옆으로: 벽을 따라 미끄러져 구석에서 멈춘다
  const corner = await hold(['ShiftLeft', 'KeyW', 'KeyD'], 2500);
  check('벽을 따라 미끄러져 구석(두 벽에서 20cm)에 멈춘다', Math.abs(corner.position[0] - (maxX - MARGIN)) < 0.01 && Math.abs(corner.position[2] - (minZ + MARGIN)) < 0.01, corner.position.map((v) => round(v)));

  // 3) 위·아래
  await standAt([0, 1.5, 0], [0, 1.2, -2]);
  const high = await hold(['ShiftLeft', 'KeyE'], 2500);
  const higher = await hold(['ShiftLeft', 'KeyE'], 600);
  check('위로 계속 올라가도 천장 아래에서 멈춘다 (1.8~3.5m)', high.position[1] >= 1.8 && high.position[1] <= 3.5 && Math.abs(higher.position[1] - high.position[1]) < 1e-6, round(high.position[1]));
  const low = await hold(['ShiftLeft', 'KeyQ'], 2500);
  check('아래로 계속 내려가도 바닥 위 20cm에서 멈춘다', Math.abs(low.position[1] - 0.2) < 1e-6, round(low.position[1]));

  // 4) 휠로 물러나기
  await standAt([0, 1.5, 0], [0, 1.2, -2]);
  const stage = await page.getByTestId('stage').boundingBox();
  await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2);
  for (let i = 0; i < 25; i += 1) {
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(40);
  }
  await page.waitForTimeout(600);
  const zoomed = await pose();
  check('휠로 계속 물러나도 방 안', inside(zoomed.position) && zoomed.position[1] >= 0.2 - 1e-6 && zoomed.position[2] > 1, zoomed.position.map((v) => round(v)));

  // 5) 끌어서 돌리기: 벽 가까이에서 돌려도 방 안
  await standAt([maxX - 0.4, 1.5, 0], [0, 1.2, 0]);
  await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 12; i += 1) await page.mouse.move(stage.x + stage.width / 2 + i * 40, stage.y + stage.height / 2 + i * 6, { steps: 3 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  const orbited = await pose();
  check('끌어서 돌려도 방 안', inside(orbited.position), orbited.position.map((v) => round(v)));

  // 6) 카메라가 방 밖에 놓이면 바로 데려온다
  await page.evaluate(() => {
    const e = window.__roomlens;
    e.camera.position.set(20, 9, 20);
    e.controls.update();
  });
  await page.waitForTimeout(400);
  const pulled = await pose();
  check('방 밖 높은 곳에 놓여도 방 안으로 데려온다', inside(pulled.position) && pulled.position[1] <= 3.5, pulled.position.map((v) => round(v)));

  // 7) 끄면 나갈 수 있고, 다시 켜면 돌아온다
  await toggle.click();
  check('누르면 꺼진다', (await toggle.getAttribute('aria-checked')) === 'false' && (await toggle.innerText()).includes('끔'), null);
  await standAt([0, 1.5, 0], [0, 1.2, -2]);
  const out = await hold(['ShiftLeft', 'KeyW'], 2000);
  check('끄면 벽 밖으로 나간다', out.position[2] < minZ - 1, round(out.position[2]));
  await toggle.click();
  await page.waitForTimeout(400);
  const back = await pose();
  check('다시 켜면 방 안으로 돌아온다', (await toggle.getAttribute('aria-checked')) === 'true' && inside(back.position), back.position.map((v) => round(v)));
} catch (err) {
  check('예외 없이 끝까지 실행', false, String(err).slice(0, 300));
} finally {
  for (const c of checks) console.log(c.ok ? 'PASS' : 'FAIL', c.name, c.detail ? JSON.stringify(c.detail) : '');
  process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
  await browser.close();
}
