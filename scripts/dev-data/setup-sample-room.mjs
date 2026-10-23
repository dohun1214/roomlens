// 샘플 방 준비: 시험 계정에 방을 올리고, 방 화면에서 실제 사용자처럼 보정(바닥 세 곳 + 모서리 탭, 벽 1 길이 입력)을 하고,
// 문·창문과 원래 가구를 "AI로 찾기"로 넣어 저장한다. 결과(보정·문창문·원래 가구)를 JSON으로 남겨 확인·수정한 뒤
// seed-room.mjs --setup 으로 실제 계정의 방에 넣는다. 시험 계정은 cleanup-test-users로 지운다.
//
// 설정 파일(JSON): { slug, file, title, credit, floorY, floorPoints: [[x,z]×3], corners: [[x,z]…], cornerY, wallLength? }
//   floorEye(바닥을 찍을 때 눈높이, 기본 2.2), cornerBack(모서리에서 물러날 거리, 기본 1.2)
//   좌표는 올린 파일의 좌표(보정 전 화면의 월드 좌표). corners는 방을 한 바퀴 도는 순서, 벽 1 = corners[0] → corners[1]
//   모서리마다 [x, z, 높이]로 찍을 높이를 따로 줄 수 있다 (가구·열린 곳에 가려 cornerY에서 안 보일 때)
//   [x, z, 높이, 눈x, 눈z, 눈높이?]처럼 그 모서리를 볼 눈 위치도 줄 수 있다
//   wallLength를 비우면 "파일 단위 그대로" (파일 단위가 m인 장면)
// 실행: node --env-file=.env.local scripts/dev-data/setup-sample-room.mjs <설정.json>   (APP_URL로 개발 서버 주소)
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createClient } from '@supabase/supabase-js';
import { checkSplatFile, SPLAT_CONTENT_TYPE, SPLAT_HEAD_BYTES, splatKeyFor } from '../../lib/upload/splatFile.ts';
import { dataDir, moveCamera, toScreen } from './e2e-common.mjs';

const require = createRequire(path.join(dataDir, '_e2e', 'package.json'));
const { chromium } = require('playwright-core');

const cfgPath = path.resolve(process.argv[2]);
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
const appUrl = process.env.APP_URL ?? 'http://localhost:3000';
const outDir = path.dirname(cfgPath);
const email = `e2e-${Date.now()}-sample@${process.env.E2E_EMAIL_DOMAIN ?? 'roomlens.test'}`;
const password = `pw-${Math.random().toString(36).slice(2, 12)}A1`;
const shot = (page, name) => page.screenshot({ path: path.join(outDir, `${cfg.slug}-${name}.jpg`), type: 'jpeg', quality: 75 });

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
});

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
// R2의 CORS는 정해진 주소(localhost:3000·운영)만 허락한다. 다른 포트의 개발 서버로 열 때를 위해 응답에 허락 머리말을 붙인다
await page.route(/r2\.cloudflarestorage\.com/, async (route) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, HEAD, PUT, OPTIONS', 'access-control-expose-headers': '*' };
  if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
  const response = await route.fetch();
  return route.fulfill({ response, headers: { ...response.headers(), ...cors } });
});
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

try {
  // 1) 시험 계정 가입
  await page.goto(`${appUrl}/account`);
  await page.getByRole('tab', { name: '가입' }).click();
  await page.getByLabel('이메일').fill(email);
  await page.getByLabel(/비밀번호/).fill(password);
  await page.getByLabel('만 18세 이상입니다.').check();
  await page.getByRole('button', { name: '가입하기' }).click();
  await page.waitForURL('**/account', { timeout: 15000 });
  const { data: users } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const owner = users.users.find((u) => u.email === email);

  // 2) 방 올리기 (seed-room.mjs와 같은 방식)
  const bytes = readFileSync(path.resolve(dataDir, cfg.file));
  const check = checkSplatFile(bytes.length, bytes.subarray(0, SPLAT_HEAD_BYTES));
  if (!check.ok) throw new Error(check.message);
  const { data: room, error } = await admin
    .from('rooms')
    .insert({ owner_id: owner.id, title: cfg.title, description: '', source: 'dataset', credit: cfg.credit, consent_at: new Date().toISOString() })
    .select('id')
    .single();
  if (error) throw error;
  const key = splatKeyFor(room.id, check.format);
  await s3.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key, Body: bytes, ContentType: SPLAT_CONTENT_TYPE }));
  await admin.from('rooms').update({ status: 'ready', splat_key: key, splat_format: check.format, splat_bytes: bytes.length }).eq('id', room.id);
  log('방', room.id);

  // 3) 방 화면에서 보정
  await page.goto(`${appUrl}/rooms/${room.id}`);
  await page.waitForFunction(() => document.querySelector('[data-testid=viewer-stats]')?.textContent?.includes('ready'), null, { timeout: 180000 });
  await page.waitForTimeout(3000);
  // 보정 전인 방은 보정 도구가 열린 채 시작한다
  if ((await page.getByTestId('calibration-toggle').getAttribute('aria-pressed')) !== 'true') await page.getByTestId('calibration-toggle').click();
  const fy = cfg.floorY;
  const tap = async (eye, target) => {
    await moveCamera(page, eye, target);
    const s = await toScreen(page, target);
    await page.mouse.click(s.x, s.y);
    await page.waitForTimeout(400);
  };
  for (const [x, z] of cfg.floorPoints) await tap([x + 0.01, fy + (cfg.floorEye ?? 2.2), z + 0.01], [x, fy, z]);
  // 모서리마다: 방 안쪽(두 벽의 이등분선 방향)으로 물러난 눈높이에서 모서리를 본다. 오목한 모서리는 반대쪽이 방 안
  const P = cfg.corners;
  const n = P.length;
  const area = P.reduce((s, p, i) => s + p[0] * P[(i + 1) % n][1] - P[(i + 1) % n][0] * p[1], 0) / 2;
  const unit = (v) => {
    const l = Math.hypot(v[0], v[1]) || 1;
    return [v[0] / l, v[1] / l];
  };
  let corners = 0;
  for (let i = 0; i < n; i += 1) {
    const [x, z, cornerY = cfg.cornerY] = P[i];
    const a = unit([P[(i + n - 1) % n][0] - x, P[(i + n - 1) % n][1] - z]);
    const b = unit([P[(i + 1) % n][0] - x, P[(i + 1) % n][1] - z]);
    let dir = unit([a[0] + b[0], a[1] + b[1]]);
    // 방향 판정: 볼록한 모서리면 두 벽 방향의 합이 방 안쪽
    const cross = a[0] * b[1] - a[1] * b[0];
    const convex = area > 0 ? cross < 0 : cross > 0;
    if (!convex) dir = [-dir[0], -dir[1]];
    const back = cfg.cornerBack ?? 1.2;
    // 가구가 모서리를 가리면 설정에서 눈 위치를 직접 준다: [x, z, 높이, 눈x, 눈z, 눈높이]
    const eye = P[i].length >= 5 ? [P[i][3], fy + (P[i][5] ?? 1.6), P[i][4]] : [x + dir[0] * back, fy + 1.6, z + dir[1] * back];
    await tap(eye, [x, fy + cornerY, z]);
    corners += 1;
  }
  log('모서리 탭', corners);
  await page.getByTestId('calibration-corners-done').click();
  // 길이를 모르면 "파일 단위 그대로" (파일이 m 단위인 장면)
  if (cfg.wallLength) await page.getByTestId('calibration-length').fill(cfg.wallLength.toFixed(3));
  else await page.getByTestId('calibration-keep-scale').click();
  await page.getByTestId('calibration-result').waitFor({ timeout: 10000 });
  const result = JSON.parse(await page.getByTestId('calibration-result').getAttribute('data-json'));
  log('보정', JSON.stringify({ walls: result.wallLengths, heights: result.cornerHeights, scale: result.scale }));
  if (result.wallLengths.length !== n) log(`경고: 모서리 ${n}개를 찍었는데 벽이 ${result.wallLengths.length}개`);
  await page.getByTestId('calibration-apply').click();
  await page.getByTestId('calibration-save').click();
  await page.waitForFunction(() => document.querySelector('[data-testid=calibration-save-state]')?.getAttribute('data-state') === 'saved', null, { timeout: 15000 });
  await page.waitForTimeout(2000);

  // 4) 문·창문 AI로 찾기 → 저장
  const detect = async (tool) => {
    await page.getByTestId(`${tool}-toggle`).click();
    await page.getByTestId(`${tool}-detect-run`).click();
    await page.waitForFunction((t) => document.querySelector(`[data-testid=${t}-detect]`)?.getAttribute('data-busy') === 'true', tool, { timeout: 15000 });
    await page.waitForFunction((t) => document.querySelector(`[data-testid=${t}-detect]`)?.getAttribute('data-busy') === 'false', tool, { timeout: 240000 });
    log(tool, (await page.getByTestId(`${tool}-message`).innerText().catch(() => '')).replace(/\s+/g, ' '));
    if (await page.getByTestId(`${tool}-save`).count()) {
      await page.getByTestId(`${tool}-save`).click();
      await page.waitForFunction((t) => document.querySelector(`[data-testid=${t}-save-state]`)?.getAttribute('data-state') === 'saved', tool, { timeout: 15000 });
    }
  };
  await detect('openings');
  await detect('fixtures');

  // 5) 확인용 그림
  await page.getByTestId('plan-toggle').click();
  await page.waitForTimeout(1500);
  await shot(page, 'plan');
  await page.getByTestId('plan-toggle').click();
  await page.waitForTimeout(1500);
  // 위에서 내려다본 그림(천장은 잘라 냄)에 원래 가구 상자·문창문 표시가 함께 보이게
  const polygon = JSON.parse(await page.getByTestId('calibration-result').getAttribute('data-json').catch(() => 'null'))?.floorPolygon ?? null;
  const { data: room2 } = await admin.from('rooms').select('floor_polygon').eq('id', room.id).single();
  const poly = room2.floor_polygon ?? polygon;
  const xs = poly.map((p) => p[0]);
  const zs = poly.map((p) => p[1]);
  const mid = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...zs) + Math.max(...zs)) / 2];
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)) + 1;
  await page.evaluate(
    ({ mid, span }) => {
      const e = window.__roomlens;
      e.freeCamera = true;
      e.controls.enabled = false;
      const cam = e.camera;
      const H = 60;
      cam.fov = (2 * Math.atan(span / 2 / (H * Math.min(1, cam.aspect))) * 180) / Math.PI;
      cam.near = H - 2.2;
      cam.far = H + 1;
      cam.up.set(0, 0, -1);
      cam.position.set(mid[0], H, mid[1]);
      e.controls.target.set(mid[0], 0, mid[1]);
      cam.lookAt(mid[0], 0, mid[1]);
      cam.updateProjectionMatrix();
    },
    { mid, span },
  );
  await page.waitForTimeout(3000);
  await shot(page, 'review-top');
  // 눈높이 그림은 방 안의 빈 곳에서 (보정 뒤 좌표). 바닥 탭 첫 점을 보정 변환으로 옮긴 곳
  const eye = await page.evaluate(([x, y, z]) => {
    const e = window.__roomlens;
    const v = e.camera.position.clone().set(x, y, z).applyMatrix4(e.roomGroup.matrixWorld);
    return [v.x, v.z];
  }, [cfg.floorPoints[0][0], cfg.floorY, cfg.floorPoints[0][1]]);
  for (const [tag, dx, dz] of [['east', 1, 0], ['west', -1, 0], ['south', 0, 1], ['north', 0, -1]]) {
    await page.evaluate(
      ({ eye, dx, dz }) => {
        const e = window.__roomlens;
        const cam = e.camera;
        cam.fov = 70;
        cam.near = 0.05;
        cam.far = 200;
        cam.up.set(0, 1, 0);
        cam.position.set(eye[0] - dx * 0.8, 1.5, eye[1] - dz * 0.8);
        e.controls.target.set(eye[0] + dx, 1.2, eye[1] + dz);
        cam.lookAt(e.controls.target);
        cam.updateProjectionMatrix();
      },
      { eye, dx, dz },
    );
    await page.waitForTimeout(2200);
    await shot(page, `review-${tag}`);
  }

  const { data: saved } = await admin.from('rooms').select('id, transform, floor_polygon, openings, fixtures').eq('id', room.id).single();
  writeFileSync(path.join(outDir, `${cfg.slug}-result.json`), JSON.stringify({ email, ownerId: owner.id, calibration: result, ...saved }, null, 2));
  log('끝', JSON.stringify({ openings: saved.openings?.length, fixtures: saved.fixtures?.length, errors }));
} catch (err) {
  log('실패', String(err).slice(0, 400));
  await shot(page, 'error').catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
