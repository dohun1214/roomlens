// 보정 저장 실측: 방 화면에서 실제로 탭해 보정 → 저장 → 다시 열면 보정된 상태로 시작하는지 본다.
// 개발 서버 전용 (카메라를 옮기려고 window.__roomlens 를 쓴다). 방은 비공개로만 만든다.
// 준비: npm run dev, ../roomlens-data/_e2e 에 playwright-core, ../roomlens-data/converted 에 .sog, interiorgs/<장면>/structure.json
// 실행: node --env-file=.env.local scripts/dev-data/e2e-calibration-save.mjs [장면 이름]
import { createRequire } from 'node:module';
import { statSync } from 'node:fs';
import path from 'node:path';
import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { createClient } from '@supabase/supabase-js';
import { calibrate, dataDir, moveCamera, round, toScreen } from './e2e-common.mjs';

const require = createRequire(path.join(dataDir, '_e2e', 'package.json'));
const { chromium } = require('playwright-core');

const appUrl = process.env.APP_URL ?? 'http://localhost:3000';
const scene = process.argv[2] ?? '0056_839909';
const scenePath = path.join(dataDir, 'converted', `${scene}.sog`);
const sceneBytes = statSync(scenePath).size;
const email = `e2e-${Date.now()}@${process.env.E2E_EMAIL_DOMAIN ?? 'roomlens.test'}`;
const password = `pw-${Math.random().toString(36).slice(2, 12)}A1`;
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});
const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
});
const listKeys = async (prefix) =>
  (await s3.send(new ListObjectsV2Command({ Bucket: process.env.R2_BUCKET, Prefix: prefix }))).Contents?.map((o) => o.Key) ?? [];

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));

const api = (method, url, body) =>
  page.evaluate(
    async ({ method, url, body }) => {
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: res.status, json: await res.json().catch(() => null) };
    },
    { method, url, body },
  );
const viewerReady = () =>
  page.waitForFunction(() => document.querySelector('[data-testid=viewer-stats]')?.textContent?.includes('ready'), null, { timeout: 120000 });
/** 방 그룹(보정 변환)과 카메라의 현재 값 */
const engineState = () =>
  page.evaluate(() => {
    const e = window.__roomlens;
    return { scale: e.roomGroup.scale.x, groupPos: e.roomGroup.position.toArray(), camera: e.camera.position.toArray(), target: e.controls.target.toArray() };
  });
const wallLengthsOf = (polygon) => polygon.map((p, i) => Math.hypot(p[0] - polygon[(i + 1) % polygon.length][0], p[1] - polygon[(i + 1) % polygon.length][1]));
const maxErrorPct = (lengths, truth) => Math.max(...lengths.map((len, i) => (Math.abs(len - truth[i]) / truth[i]) * 100));

try {
  // 준비: 가입 → 방 만들고 파일 올리기 (비공개 데이터셋 방)
  await page.goto(`${appUrl}/account`);
  await page.getByRole('tab', { name: '가입' }).click();
  await page.getByLabel('이메일').fill(email);
  await page.getByLabel(/비밀번호/).fill(password);
  await page.getByLabel('만 18세 이상입니다.').check();
  await page.getByRole('button', { name: '가입하기' }).click();
  await page.waitForURL('**/account', { timeout: 15000 });
  await page.route('**/__e2e_scene', (route) => route.fulfill({ path: scenePath, contentType: 'application/octet-stream' }));
  const roomId = (await api('POST', '/api/rooms', { title: '보정 저장 실측 방', consent: true, source: 'dataset', credit: `InteriorGS ${scene} (시험용, 비공개)` })).json.room.id;
  const signed = await api('POST', '/api/upload-url', { roomId, kind: 'splat', format: 'sog', size: sceneBytes });
  const putStatus = await page.evaluate(
    async ({ url, headers }) => (await fetch(url, { method: 'PUT', headers, body: await (await fetch('/__e2e_scene')).blob() })).status,
    { url: signed.json.url, headers: signed.json.headers },
  );
  const done = await api('PATCH', `/api/rooms/${roomId}`, { splatFormat: 'sog' });
  check('준비: 방 업로드 완료', putStatus === 200 && done.status === 200, [putStatus, done.status]);

  // 1) 보정 전
  await page.goto(`${appUrl}/rooms/${roomId}`);
  await viewerReady();
  check('보정 전: 가구 패널 없음, 방 그룹은 원래 좌표', (await page.getByTestId('furniture-panel').count()) === 0 && (await engineState()).scale === 1, null);

  // 2) 실제로 탭해서 보정 (바닥 3곳 + 모서리 4곳)
  const { truth } = await calibrate(page, scene);
  // 데이터셋 방: 줄자 대신 "파일 단위 그대로"
  await page.getByTestId('calibration-length').fill('');
  await page.getByTestId('calibration-keep-scale').click();
  const kept = Number(await page.getByTestId('calibration-length').inputValue());
  check('"파일 단위 그대로": 벽 1 길이가 정답과 2% 이내 (미터 단위 파일)', Math.abs(kept - truth.wallLengths[0]) / truth.wallLengths[0] < 0.02, { kept, truth: round(truth.wallLengths[0]) });
  await page.getByTestId('calibration-apply').click();
  check('적용 직후: "저장 안 됨"', (await page.getByTestId('calibration-save-state').getAttribute('data-state')) === 'dirty', null);

  // 3) 저장
  await page.getByTestId('calibration-save').click();
  await page.waitForFunction(() => document.querySelector('[data-testid=calibration-save-state]')?.getAttribute('data-state') === 'saved', null, { timeout: 10000 });
  check('저장 → "저장됨", 저장 버튼 사라짐', (await page.getByTestId('calibration-save').count()) === 0, null);
  const { data: row } = await admin.from('rooms').select('transform, floor_polygon').eq('id', roomId).maybeSingle();
  const savedWalls = wallLengthsOf(row?.floor_polygon ?? [[0, 0]]);
  check('DB: 크기 배율이 1에 가깝고(±2%) 평면도 꼭짓점 4개', Math.abs((row?.transform?.s ?? 0) - 1) < 0.02 && row?.floor_polygon?.length === 4 && row.transform.flipX === false, { s: row?.transform?.s });
  const error = maxErrorPct(savedWalls, truth.wallLengths);
  check(`DB: 저장된 벽 길이 오차 최대 ${error.toFixed(2)}% (3% 이내)`, error < 3, savedWalls.map((v) => round(v)));

  const skew = Math.max(...row.floor_polygon.map((p, i) => { const q = row.floor_polygon[(i + 1) % row.floor_polygon.length]; return Math.min(Math.abs(q[0] - p[0]), Math.abs(q[1] - p[1])); }));
  check('DB: 직각으로 맞춘 평면도 (모든 벽이 정확히 가로·세로)', skew < 1e-9, skew);

  // 4) 다시 열기
  await page.reload();
  await viewerReady();
  await page.waitForTimeout(1500);
  const after = await engineState();
  check('다시 열면: 방 그룹에 저장된 배율이 적용됨', Math.abs(after.scale - row.transform.s) < 1e-6, round(after.scale, 4));
  const xs = row.floor_polygon.map((p) => p[0]);
  const zs = row.floor_polygon.map((p) => p[1]);
  const inside = after.camera[0] > Math.min(...xs) && after.camera[0] < Math.max(...xs) && after.camera[2] > Math.min(...zs) && after.camera[2] < Math.max(...zs);
  check('다시 열면: 카메라가 방 안, 눈높이(1.5m)에서 시작', inside && Math.abs(after.camera[1] - 1.5) < 0.01, after.camera.map((v) => round(v, 2)));
  check('다시 열면: 보정 표시가 "저장됨"으로 시작', (await page.getByTestId('calibration-save-state').getAttribute('data-state')) === 'saved', null);
  check('다시 열면: 바로 가구를 놓을 수 있음 (가구 패널 표시)', await page.getByTestId('furniture-panel').isVisible(), null);
  const catalogButtons = await page.getByTestId('furniture-panel').getByRole('button', { name: /^\+ / }).allInnerTexts();
  check('가구 패널에 DB 카탈로그 10종이 나옴', catalogButtons.length === 10 && catalogButtons.includes('+ 책장') && catalogButtons[0] === '+ 싱글 침대', catalogButtons);
  check('보정된 방에는 X축 뒤집기 버튼이 없음', (await page.getByRole('button', { name: /X축 180/ }).count()) === 0, null);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(dataDir, '_e2e', 'calibration-saved.png') });

  // 4-2) 문을 화면에서 찍어 넣기: 방 가운데에서 벽 1의 30%·60% 지점(가구 위쪽 높이)을 바라보고 탭
  const polygon = row.floor_polygon;
  const along = (f) => [polygon[0][0] + (polygon[1][0] - polygon[0][0]) * f, 2.2, polygon[0][1] + (polygon[1][1] - polygon[0][1]) * f];
  const eye = [xs.reduce((s, v) => s + v, 0) / xs.length, 1.5, zs.reduce((s, v) => s + v, 0) / zs.length];
  await page.getByTestId('openings-toggle').click();
  await page.getByTestId('openings-pick').click();
  for (const f of [0.3, 0.6]) {
    await moveCamera(page, eye, along(f));
    const s = await toScreen(page, along(f));
    await page.mouse.click(s.x, s.y);
    await page.waitForTimeout(400);
  }
  const picked = {
    wall: await page.getByTestId('openings-wall').inputValue(),
    from: Number(await page.getByTestId('openings-from').inputValue()),
    width: Number(await page.getByTestId('openings-width').inputValue()),
  };
  const expected = { from: round(savedWalls[0] * 0.3, 2), width: round(savedWalls[0] * 0.3, 2) };
  check(
    `화면에서 두 점을 찍으면 벽 1의 위치가 채워짐 (기대 시작 ${expected.from} m·폭 ${expected.width} m, 오차 10cm 이내)`,
    picked.wall === '0' && Math.abs(picked.from - expected.from) < 0.1 && Math.abs(picked.width - expected.width) < 0.1,
    picked,
  );
  await page.screenshot({ path: path.join(dataDir, '_e2e', 'openings-picked.png') });
  await page.getByTestId('openings-add').click();
  await page.getByTestId('openings-save').click();
  await page.waitForFunction(() => document.querySelector('[data-testid=openings-save-state]')?.getAttribute('data-state') === 'saved', null, { timeout: 10000 });
  const { data: withDoor } = await admin.from('rooms').select('openings').eq('id', roomId).maybeSingle();
  check('찍은 문을 추가·저장 → DB에 문 1개', withDoor?.openings?.length === 1 && withDoor.openings[0].type === 'door' && withDoor.openings[0].wallIndex === 0, withDoor?.openings);
  await page.getByRole('button', { name: '닫기', exact: true }).click();

  // 5) 다시 찍기: 화면에서는 보정이 풀리지만 저장된 값은 새로 저장하기 전까지 그대로
  await page.getByRole('button', { name: '다시 찍기' }).click();
  const reset = await engineState();
  const { data: still } = await admin.from('rooms').select('transform').eq('id', roomId).maybeSingle();
  check('다시 찍기: 화면의 보정은 풀리고 DB 값은 그대로', reset.scale === 1 && still?.transform?.s === row.transform.s, round(reset.scale, 4));

  // 6) 보정을 새로 해서 저장하면 벽이 달라지므로 문·창문을 비운다
  process.env.JITTER_PX = '3';
  await calibrate(page, scene, { alreadyOpen: true });
  await page.getByTestId('calibration-apply').click();
  await page.getByTestId('openings-toggle').click();
  check('새 보정을 저장하기 전: 문·창문은 0개로 시작하고 넣을 수 없음', (await page.getByTestId('openings-locked').isVisible()) && (await page.getByTestId('openings').getAttribute('data-count')) === '0', null);
  const { data: beforeSave } = await admin.from('rooms').select('openings').eq('id', roomId).maybeSingle();
  await page.getByTestId('calibration-save').click();
  await page.waitForFunction(() => document.querySelector('[data-testid=calibration-save-state]')?.getAttribute('data-state') === 'saved', null, { timeout: 10000 });
  const { data: afterSave } = await admin.from('rooms').select('openings, floor_polygon').eq('id', roomId).maybeSingle();
  check(
    '새 보정을 저장: DB의 문·창문이 비워지고(1 → 0) 다시 넣을 수 있게 됨',
    beforeSave?.openings?.length === 1 && afterSave?.openings?.length === 0 && JSON.stringify(afterSave.floor_polygon) !== JSON.stringify(row.floor_polygon) && (await page.getByTestId('openings-locked').count()) === 0 && (await page.getByTestId('openings-add').isVisible()),
    [beforeSave?.openings?.length, afterSave?.openings?.length],
  );
} catch (err) {
  check('예외 없이 끝까지 실행', false, String(err).slice(0, 300));
  await page.screenshot({ path: path.join(dataDir, '_e2e', 'calibration-save-failure.png') }).catch(() => {});
} finally {
  await browser.close();
  const { data } = await admin.auth.admin.listUsers({ perPage: 200 });
  const mine = data?.users.filter((u) => u.email === email) ?? [];
  let removed = 0;
  for (const u of mine) {
    const { data: rooms } = await admin.from('rooms').select('id').eq('owner_id', u.id);
    for (const r of rooms ?? []) {
      const keys = await listKeys(`rooms/${r.id}/`);
      if (keys.length) {
        await s3.send(new DeleteObjectsCommand({ Bucket: process.env.R2_BUCKET, Delete: { Objects: keys.map((Key) => ({ Key })) } }));
        removed += keys.length;
      }
    }
    await admin.auth.admin.deleteUser(u.id);
  }
  check('시험용 계정·방·R2 파일 삭제', mine.length === 1, `계정 ${mine.length}, 지운 파일 ${removed}`);
}

for (const c of checks) console.log(c.ok ? 'PASS' : 'FAIL', c.name, c.detail ? JSON.stringify(c.detail) : '');
process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
