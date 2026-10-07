// 키보드로 걸어 다니기 실측: 실제 키를 눌러 카메라가 어떻게 움직이는지 잰다.
// 실행: node scripts/dev-data/e2e-keyboard-move.mjs [장면]   (준비·환경변수는 e2e-common.mjs 참고)
import { calibrate, moveCamera, openViewer, round } from './e2e-common.mjs';

const scene = process.argv[2] ?? '0056_839909';
const { browser, page } = await openViewer(scene);
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail });

const pose = () =>
  page.evaluate(() => {
    const e = window.__roomlens;
    return { position: e.camera.position.toArray(), target: e.controls.target.toArray() };
  });
const sub = (a, b) => a.map((v, i) => v - b[i]);
const len = (v) => Math.hypot(...v);
/** 키를 ms 동안 누르고 있는 동안 카메라와 바라보는 점이 움직인 만큼 */
const hold = async (keys, ms) => {
  const before = await pose();
  for (const key of keys) await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  for (const key of [...keys].reverse()) await page.keyboard.up(key);
  await page.waitForTimeout(250);
  const after = await pose();
  return { moved: sub(after.position, before.position), targetMoved: sub(after.target, before.target) };
};
const sameMove = (m) => len(sub(m.moved, m.targetMoved)) < 1e-6;

try {
  check('큰 화면에는 키 안내가 보인다', (await page.getByTestId('stage-keys').innerText()).replace(/\s+/g, ' ').includes('W A S D'), null);

  // 1) 보정 전: 글자를 넣는 칸에서는 움직이지 않는다
  const { truth } = await calibrate(page, scene);
  const length = page.getByTestId('calibration-length');
  await length.focus();
  const typing = await hold(['KeyW'], 400);
  check('입력 칸에 글자를 넣는 동안에는 움직이지 않는다', len(typing.moved) < 1e-9, typing.moved);
  await length.fill(truth.wallLengths[0].toFixed(3));
  await page.getByTestId('calibration-apply').click();

  // 2) 보정된 방(m 단위): 방 가운데 눈높이에서 -z 쪽을 비스듬히 내려다본다
  await page.evaluate(() => document.activeElement?.blur()); // 입력 칸에서 초점을 뺀다
  await moveCamera(page, [0, 1.5, 1], [0, 1.0, -1], 800);

  const w = await hold(['KeyW'], 1000);
  check('W: 보는 쪽(-z)으로 가고 높이는 그대로', w.moved[2] < -0.6 && Math.abs(w.moved[0]) < 0.02 && Math.abs(w.moved[1]) < 1e-6, w.moved.map((v) => round(v)));
  check('W 1초에 걷는 빠르기(1.6m)만큼 간다 (0.8~2.0m)', len(w.moved) > 0.8 && len(w.moved) < 2.0, round(len(w.moved)));
  check('카메라와 바라보는 점이 같이 움직인다 (돌리는 중심이 따라옴)', sameMove(w), w.targetMoved.map((v) => round(v)));

  const s = await hold(['KeyS'], 500);
  check('S: 뒤(+z)로', s.moved[2] > 0.3 && Math.abs(s.moved[1]) < 1e-6, s.moved.map((v) => round(v)));
  const d = await hold(['KeyD'], 500);
  check('D: 오른쪽(+x)으로', d.moved[0] > 0.3 && Math.abs(d.moved[2]) < 0.02, d.moved.map((v) => round(v)));
  const a = await hold(['ArrowLeft'], 500);
  check('← : 왼쪽(-x)으로 (방향키도 같음)', a.moved[0] < -0.3 && Math.abs(a.moved[2]) < 0.02, a.moved.map((v) => round(v)));
  const e = await hold(['KeyE'], 500);
  check('E: 위로', e.moved[1] > 0.3 && Math.hypot(e.moved[0], e.moved[2]) < 1e-6, e.moved.map((v) => round(v)));
  const q = await hold(['KeyQ'], 500);
  check('Q: 아래로', q.moved[1] < -0.3 && sameMove(q), q.moved.map((v) => round(v)));

  const slow = await hold(['KeyD'], 600);
  const fast = await hold(['ShiftLeft', 'KeyA'], 600);
  check('Shift를 누르면 2배 넘게 빠르다', len(fast.moved) > len(slow.moved) * 2, [round(len(slow.moved)), round(len(fast.moved))]);

  const both = await hold(['KeyW', 'KeyS'], 400);
  check('반대 키를 같이 누르면 멈춘다', len(both.moved) < 1e-9, both.moved);

  // 3) 키로 옮긴 뒤에도 마우스로 돌릴 수 있다
  const beforeDrag = await pose();
  await page.mouse.move(700, 400);
  await page.mouse.down();
  await page.mouse.move(820, 420, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const afterDrag = await pose();
  check('옮긴 뒤 끌면 화면이 돌고, 바라보는 점은 그대로', len(sub(afterDrag.position, beforeDrag.position)) > 0.01 && len(sub(afterDrag.target, beforeDrag.target)) < 1e-6, null);

  // 4) 위에서 똑바로 내려다볼 때: W는 화면의 위쪽으로
  await moveCamera(page, [0.001, 5, 0.001], [0, 0, 0], 800);
  const up = await page.evaluate(() => window.__roomlens.camera.up.clone().set(0, 1, 0).applyQuaternion(window.__roomlens.camera.quaternion).toArray());
  const top = await hold(['KeyW'], 500);
  const along = (top.moved[0] * up[0] + top.moved[2] * up[2]) / Math.hypot(up[0], up[2]);
  check('똑바로 내려다볼 때 W는 화면 위쪽으로 가고 높이는 그대로', along > 0.3 && Math.abs(top.moved[1]) < 1e-6 && Math.abs(along - len(top.moved)) < 0.02, top.moved.map((v) => round(v)));
} catch (err) {
  check('예외 없이 끝까지 실행', false, String(err).slice(0, 300));
} finally {
  for (const c of checks) console.log(c.ok ? 'PASS' : 'FAIL', c.name, c.detail ? JSON.stringify(c.detail) : '');
  process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
  await browser.close();
}
