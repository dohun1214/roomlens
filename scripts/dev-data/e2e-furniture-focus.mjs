// 가구로 시점 옮기기 실측: 놓인 가구 목록·고른 가구 띠의 버튼, 평면도에서 누를 때, 화면 밖에 새 가구를 놓을 때
// 카메라가 그 가구가 보이는 방 안 자리로 옮겨 가는지 본다. 카메라를 window.__roomlens로 다루므로 개발 서버 전용.
// 준비: ../roomlens-data/_e2e 에 playwright-core, ../roomlens-data/samples/studio11_1m_up.sog
// 실행: node --env-file=.env.local scripts/dev-data/e2e-furniture-focus.mjs
import { createRequire } from 'node:module';
import { statSync } from 'node:fs';
import path from 'node:path';
import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { createClient } from '@supabase/supabase-js';
import { dataDir } from './e2e-common.mjs';

const require = createRequire(path.join(dataDir, '_e2e', 'package.json'));
const { chromium } = require('playwright-core');

const appUrl = process.env.APP_URL ?? 'http://localhost:3000';
const scenePath = path.join(dataDir, 'samples', 'studio11_1m_up.sog');
const sceneBytes = statSync(scenePath).size;
const stamp = Date.now();
const domain = process.env.E2E_EMAIL_DOMAIN ?? 'roomlens.test';
const emails = { owner: `e2e-${stamp}-o@${domain}` };
const password = `pw-${Math.random().toString(36).slice(2, 12)}A1`;
const checks = [];
const pageErrors = [];
const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });

// 시험용 방: 4 × 3 m 사각형 (파일 좌표를 그대로 방 좌표로 쓴다)
const TRANSFORM = { s: 1, q: [0, 0, 0, 1], t: [0, 0, 0], flipX: false };
const FLOOR = [[-2, -1.5], [2, -1.5], [2, 1.5], [-2, 1.5]];

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
const newPage = async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)));
  // R2의 CORS는 정해진 주소만 허락한다. 다른 포트의 개발 서버로 열 때를 위해 허락 머리말을 붙인다
  await page.route(/r2\.cloudflarestorage\.com/, async (route) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, HEAD, PUT, OPTIONS', 'access-control-expose-headers': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const response = await route.fetch();
    return route.fulfill({ response, headers: { ...response.headers(), ...cors } });
  });
  return page;
};
const signUp = async (page, email) => {
  await page.goto(`${appUrl}/account`);
  await page.getByRole('tab', { name: '가입' }).click();
  await page.getByLabel('이메일').fill(email);
  await page.getByLabel(/비밀번호/).fill(password);
  await page.getByLabel('만 18세 이상입니다.').check();
  await page.getByRole('button', { name: '가입하기' }).click();
  await page.waitForURL('**/account', { timeout: 15000 });
};
const api = (page, method, url, body) =>
  page.evaluate(
    async ({ method, url, body }) => {
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: res.status, json: await res.json().catch(() => null) };
    },
    { method, url, body },
  );
/** 방을 열고 가구 패널이 뜰 때까지 기다린다 */
const openRoom = async (page, roomId) => {
  await page.goto(`${appUrl}/rooms/${roomId}`);
  await page.getByTestId('furniture-panel').waitFor({ timeout: 120000 });
};

try {
  const page = await newPage();
  await signUp(page, emails.owner);
  await page.route('**/__e2e_scene', (route) => route.fulfill({ path: scenePath, contentType: 'application/octet-stream' }));
  const roomId = (await api(page, 'POST', '/api/rooms', { title: '시점 이동 실측 방', consent: true, source: 'dataset', credit: 'Studio 11 by milanoski (SuperSplat), CC BY 4.0' })).json.room.id;
  const signed = await api(page, 'POST', '/api/upload-url', { roomId, kind: 'splat', format: 'sog', size: sceneBytes });
  const putStatus = await page.evaluate(
    async ({ url, headers }) => (await fetch(url, { method: 'PUT', headers, body: await (await fetch('/__e2e_scene')).blob() })).status,
    { url: signed.json.url, headers: signed.json.headers },
  );
  const done = await api(page, 'PATCH', `/api/rooms/${roomId}`, { splatFormat: 'sog' });
  const { error: setupError } = await admin.from('rooms').update({ transform: TRANSFORM, floor_polygon: FLOOR }).eq('id', roomId);
  check('준비: 방 업로드 완료, 보정 값 넣음 (4 × 3 m)', putStatus === 200 && done.status === 200 && !setupError, [putStatus, done.status]);

  const panel = page.getByTestId('furniture-panel');
  /** 가구 가운데가 화면 어디에 보이는지 (-1~1), 카메라 자리, 가구까지 거리 */
  const view = (id) =>
    page.evaluate((id) => {
      const e = window.__roomlens;
      const items = JSON.parse(document.querySelector('[data-testid=furniture-panel]').dataset.json);
      const it = items.find((i) => i.id === id);
      const v = e.camera.position.clone().set(it.x, it.h / 2, it.z).project(e.camera);
      const cam = e.camera.position.toArray().map((n) => Math.round(n * 100) / 100);
      return { sx: Math.round(v.x * 100) / 100, sy: Math.round(v.y * 100) / 100, front: v.z < 1, cam, dist: Math.round(Math.hypot(cam[0] - it.x, cam[2] - it.z) * 100) / 100, h: it.h };
    }, id);
  const visible = (v) => v.front && Math.abs(v.sx) < 0.5 && Math.abs(v.sy) < 0.6;
  const inRoom = (v) => Math.abs(v.cam[0]) <= 1.75 && Math.abs(v.cam[2]) <= 1.25;
  /** 카메라를 방 구석에서 벽을 보게 둔다 (가구가 안 보이게) */
  const lookAtCorner = () =>
    page.evaluate(() => {
      const e = window.__roomlens;
      e.camera.position.set(1.6, 1.5, 1.1);
      e.controls.target.set(2.0, 1.5, 1.5);
      e.controls.update();
    });
  const settle = () => page.waitForTimeout(900);

  await openRoom(page, roomId);
  await page.waitForTimeout(1500);
  await panel.getByRole('button', { name: '+ 책상 · 서랍형', exact: true }).click();
  await panel.getByRole('button', { name: '+ 옷장 · 원목', exact: true }).click();
  check('놓인 가구마다 시점 이동 버튼', (await page.getByTestId('placed-focus').count()) === 2, null);

  // 1) 목록의 버튼: 구석에서 벽을 보던 카메라가 책상이 보이는 자리로
  await lookAtCorner();
  await page.waitForTimeout(300);
  const before = await view('f1');
  await page.locator('[data-testid=placed-focus][data-id=f1]').click();
  await settle();
  const after = await view('f1');
  check('목록 버튼 전: 책상이 화면에 없음', !visible(before), before);
  check('목록 버튼: 책상이 화면 가운데쯤에 보이고, 카메라는 방 안·가구보다 높게·1.2~3.3 m 떨어짐', visible(after) && inRoom(after) && after.cam[1] > after.h && after.dist >= 1.2 && after.dist <= 3.3, after);
  check('그 가구가 골라짐 (고른 가구 띠)', (await page.getByTestId('selection-bar').getAttribute('data-id')) === 'f1', null);
  await page.screenshot({ path: path.join(dataDir, '_e2e', 'focus-desk.jpg'), type: 'jpeg', quality: 70 });

  // 2) 평면도를 보다가 누르면 3D로 돌아가 옷장으로
  await page.getByTestId('plan-toggle').click();
  await page.locator('[data-testid=placed-focus][data-id=f2]').click();
  await settle();
  const wardrobe = await view('f2');
  check('평면도에서 누르면: 3D로 돌아가고 옷장이 보임', (await page.getByTestId('plan-overlay').count()) === 0 && visible(wardrobe) && inRoom(wardrobe), wardrobe);

  // 3) 고른 가구 띠의 "가구로 이동"
  await lookAtCorner();
  await page.waitForTimeout(300);
  await page.getByTestId('selection-focus').click();
  await settle();
  const fromBar = await view('f2');
  check('고른 가구 띠의 "가구로 이동": 옷장이 보임', visible(fromBar) && inRoom(fromBar), fromBar);

  // 4) 벽을 보고 있을 때 새 가구를 놓으면, 놓인 가구가 보이게 된다
  await lookAtCorner();
  await page.waitForTimeout(300);
  await panel.getByRole('button', { name: '+ 의자 · 원목', exact: true }).click();
  await settle();
  const chair = await view('f3');
  check('벽을 보다가 새 가구를 놓아도 그 가구가 화면에 보임', visible(chair) && inRoom(chair), chair);

  // 5) 되돌리기에는 시점 이동이 남지 않는다 (배치만 바뀜)
  check('시점 이동은 배치 기록에 들어가지 않음 (가구 추가 3번만)', (await page.getByTestId('layout-undo').getAttribute('data-steps')) === '3', await page.getByTestId('layout-undo').getAttribute('data-steps'));
  check('화면 오류 없음', pageErrors.length === 0, pageErrors);
} catch (err) {
  check('예외 없이 끝까지 실행', false, String(err).slice(0, 300));
} finally {
  await browser.close();
  const { data } = await admin.auth.admin.listUsers({ perPage: 200 });
  const mine = data?.users.filter((u) => Object.values(emails).includes(u.email)) ?? [];
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
