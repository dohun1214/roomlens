// 원래 가구를 3D에서 두 모서리 찍기로 넣는 실측: InteriorGS 장면을 보정한 뒤, 정답 상자(labels.json)를 아는 낮은 가구의
// 윗면 두 모서리(대각선)를 실제로 탭해서, 만들어진 사각형·높이가 정답과 맞는지 본다.
// 실행: node scripts/dev-data/e2e-fixtures-tap.mjs [장면]   (준비·환경변수는 e2e-common.mjs 참고)
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { calibrate, dataDir, moveCamera, openViewer, round, shotDir, toScreen } from './e2e-common.mjs';

const scene = process.argv[2] ?? '0056_839909';
// 윗면이 위에서 잘 보이는 낮은 가구 (labels.json의 ins_id)
const TARGET = process.env.FIXTURE_TARGET ?? '51';
const INSET = 0.05; // 모서리에서 이만큼 안쪽을 찍는다 (윗면 가장자리의 흐릿한 부분을 피해서)

const labels = JSON.parse(readFileSync(path.join(dataDir, 'interiorgs', scene, 'labels.json'), 'utf8'));
const target = labels.find((o) => o.ins_id === TARGET);
if (!target) throw new Error(`labels.json에 ${TARGET} 없음`);
// 원본 좌표 (x, y, 높이 z) → 뷰어 좌표 (x, 높이, -y)
const bx = target.bounding_box.map((p) => p.x);
const bz = target.bounding_box.map((p) => -p.y);
const top = Math.max(...target.bounding_box.map((p) => p.z));
const truth = { minX: Math.min(...bx), maxX: Math.max(...bx), minZ: Math.min(...bz), maxZ: Math.max(...bz), top };

const { browser, page } = await openViewer(scene);
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });

try {
  await calibrate(page, scene);
  await page.getByTestId('calibration-apply').click();
  await page.getByTestId('fixtures-toggle').click();
  await page.getByTestId('fixtures-tap').click();
  check('"3D에서 두 모서리 찍기"를 누르면 안내가 나옴', (await page.getByTestId('fixtures-tap-hint').innerText()).includes('한쪽 모서리'), null);

  // 정답 상자의 윗면 두 모서리(대각선)를 보정 뒤의 방 좌표로 바꾼다 (스플랫 좌표 → 월드)
  const toWorld = (p) =>
    page.evaluate((p) => {
      const e = window.__roomlens;
      return e.camera.position.clone().set(...p).applyMatrix4(e.splat.matrixWorld).toArray();
    }, p);
  const corners = [
    await toWorld([truth.minX + INSET, truth.top, truth.minZ + INSET]),
    await toWorld([truth.maxX - INSET, truth.top, truth.maxZ - INSET]),
  ];
  const middle = [(corners[0][0] + corners[1][0]) / 2, (corners[0][2] + corners[1][2]) / 2];
  // 가구 위 1.2m에서 비스듬히 내려다보며 각 모서리를 탭한다
  for (const [i, c] of corners.entries()) {
    const eye = [middle[0] + (middle[0] - c[0]) * 0.4, c[1] + 1.2, middle[1] + (middle[1] - c[2]) * 0.4 + 0.3];
    await moveCamera(page, eye, c);
    const s = await toScreen(page, c);
    await page.mouse.click(s.x, s.y);
    await page.waitForTimeout(400);
    if (i === 0) check('첫 모서리를 찍으면 반대쪽 모서리를 찍으라고 안내', (await page.getByTestId('fixtures-tap-hint').innerText()).includes('반대쪽'), null);
  }
  const list = JSON.parse(await page.getByTestId('fixtures').getAttribute('data-json'));
  const [f] = list;
  // 정답(보정 뒤): 두 모서리로 만든 사각형 + INSET
  const want = {
    x: middle[0],
    z: middle[1],
    w: Math.abs(corners[1][0] - corners[0][0]),
    d: Math.abs(corners[1][2] - corners[0][2]),
    h: (corners[0][1] + corners[1][1]) / 2,
  };
  const err = f ? { x: round(f.x - want.x), z: round(f.z - want.z), w: round(f.w - want.w), d: round(f.d - want.d), h: round(f.h - want.h) } : null;
  check(
    `두 모서리를 찍으면 원래 가구 1개: 가운데·가로·깊이는 찍은 점과 10cm 안, 높이는 정답 윗면(${round(want.h, 2)} m)과 10cm 안`,
    list.length === 1 && Math.abs(err.x) < 0.1 && Math.abs(err.z) < 0.1 && Math.abs(err.w) < 0.1 && Math.abs(err.d) < 0.1 && Math.abs(err.h) < 0.1 && (await page.getByTestId('fixtures-message').innerText()).includes('찍은 원래 가구'),
    { fixture: f, want: Object.fromEntries(Object.entries(want).map(([k, v]) => [k, round(v)])), err },
  );
  await moveCamera(page, [middle[0], corners[0][1] + 2.2, middle[1] + 1.6], [middle[0], corners[0][1] / 2, middle[1]], 1500);
  await page.screenshot({ path: path.join(shotDir, 'fixtures-tap.png') });

  // 바닥이나 허공 근처: 너무 가까운 두 점은 넣지 않는다
  await page.getByTestId('fixtures-tap').click();
  await page.getByTestId('fixtures-tap').click();
  const c = corners[0];
  await moveCamera(page, [c[0] + 0.3, c[1] + 1.2, c[2] + 0.6], c);
  const s = await toScreen(page, c);
  await page.mouse.click(s.x, s.y);
  await page.waitForTimeout(300);
  await page.mouse.click(s.x + 2, s.y + 1);
  await page.waitForTimeout(300);
  check('같은 자리를 두 번 찍으면 넣지 않고 이유를 알림', JSON.parse(await page.getByTestId('fixtures').getAttribute('data-json')).length === 1 && (await page.getByTestId('fixtures-message').innerText()).includes('15cm'), await page.getByTestId('fixtures-message').innerText());
} catch (err) {
  check('예외 없이 끝까지 실행', false, String(err).slice(0, 300));
} finally {
  for (const c of checks) console.log(c.ok ? 'PASS' : 'FAIL', c.name, c.detail ? JSON.stringify(c.detail) : '');
  process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
  await browser.close();
}
