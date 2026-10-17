// 3D 표시 끄기 실측: 문·창문 판과 원래 가구 상자를 "표시" 메뉴에서 숨기고, 그 도구를 쓰는 동안에는 보이는지,
// 새로 열어도 기억하는지 본다. 3D 장면을 window.__roomlens로 읽으므로 개발 서버 전용.
// 준비: ../roomlens-data/_e2e 에 playwright-core, ../roomlens-data/samples/studio11_1m_up.sog
// 실행: node --env-file=.env.local scripts/dev-data/e2e-markers.mjs
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
  const roomId = (await api(page, 'POST', '/api/rooms', { title: '표시 끄기 실측 방', consent: true, source: 'dataset', credit: 'Studio 11 by milanoski (SuperSplat), CC BY 4.0' })).json.room.id;
  const signed = await api(page, 'POST', '/api/upload-url', { roomId, kind: 'splat', format: 'sog', size: sceneBytes });
  const putStatus = await page.evaluate(
    async ({ url, headers }) => (await fetch(url, { method: 'PUT', headers, body: await (await fetch('/__e2e_scene')).blob() })).status,
    { url: signed.json.url, headers: signed.json.headers },
  );
  const done = await api(page, 'PATCH', `/api/rooms/${roomId}`, { splatFormat: 'sog' });
  const openings = [
    { type: 'door', wallIndex: 0, from: 0.2, to: 1.1, widthM: 0.9 },
    { type: 'window', wallIndex: 2, from: 1, to: 2.2, widthM: 1.2 },
  ];
  const fixtures = [{ id: 'x1', label: '침대', x: -1, z: 0.4, w: 1.4, d: 2, rotationDeg: 0, h: 0.5, remove: false }];
  const { error: setupError } = await admin.from('rooms').update({ transform: TRANSFORM, floor_polygon: FLOOR, openings, fixtures }).eq('id', roomId);
  check('준비: 방 업로드, 보정·문 1·창문 1·원래 가구 1 넣음', putStatus === 200 && done.status === 200 && !setupError, [putStatus, done.status]);

  /** 3D 장면에서 문·창문 판, 원래 가구 상자가 보이는지 */
  const shown = () =>
    page.evaluate(() => {
      const scene = window.__roomlens.scene;
      const find = (key) => scene.children.find((c) => c.userData?.[key]);
      return { openings: find('openings')?.visible ?? null, fixtures: find('fixtures')?.visible ?? null };
    });
  const state = (key) => page.getByTestId(`show-${key}`).getAttribute('aria-checked');

  await openRoom(page, roomId);
  await page.waitForTimeout(1500);
  check('처음: "표시" 버튼이 있고 문·창문·원래 가구가 3D에 보임', (await page.getByTestId('markers-toggle').isVisible()) && JSON.stringify(await shown()) === '{"openings":true,"fixtures":true}', await shown());

  // 1) 메뉴에서 숨기기
  await page.getByTestId('markers-toggle').click();
  const labels = await page.getByTestId('markers-menu').innerText();
  check('메뉴: 문·창문 2, 원래 가구 상자 1, 둘 다 "보임"', labels.includes('문·창문') && labels.includes('원래 가구 상자') && (await state('openings')) === 'true' && (await state('fixtures')) === 'true', labels);
  await page.getByTestId('show-openings').click();
  check('문·창문 숨김: 판이 사라지고 원래 가구는 그대로', JSON.stringify(await shown()) === '{"openings":false,"fixtures":true}' && (await state('openings')) === 'false', await shown());
  await page.getByTestId('show-fixtures').click();
  check('원래 가구도 숨김: 둘 다 사라짐', JSON.stringify(await shown()) === '{"openings":false,"fixtures":false}', await shown());
  await page.screenshot({ path: path.join(dataDir, '_e2e', 'markers-hidden.jpg'), type: 'jpeg', quality: 70 });

  // 2) 그 도구를 쓰는 동안에는 보인다
  await page.getByTestId('openings-toggle').click();
  const inOpenings = await shown();
  await page.getByTestId('fixtures-toggle').click();
  const inFixtures = await shown();
  await page.getByTestId('tool-furniture').click();
  const backToFurniture = await shown();
  check('문·창문 도구에서는 문·창문이, 원래 가구 도구에서는 상자가 보이고, 가구 도구로 돌아오면 다시 숨음', inOpenings.openings && !inOpenings.fixtures && inFixtures.fixtures && !inFixtures.openings && !backToFurniture.openings && !backToFurniture.fixtures, { inOpenings, inFixtures, backToFurniture });

  // 3) 평면도와 배치 검사에는 그대로
  await page.getByTestId('plan-toggle').click();
  check('숨겨도 평면도에는 문·창문이 그려짐', (await page.getByTestId('plan-opening').count()) === 2, await page.getByTestId('plan-opening').count());
  await page.getByTestId('plan-toggle').click();

  // 4) 새로 열어도 기억
  await page.reload();
  await page.getByTestId('furniture-panel').waitFor({ timeout: 120000 });
  await page.waitForTimeout(1500);
  const reopened = await shown();
  await page.getByTestId('markers-toggle').click();
  check('새로 열어도 숨긴 채로 (브라우저에 기억)', !reopened.openings && !reopened.fixtures && (await state('openings')) === 'false' && (await state('fixtures')) === 'false', reopened);
  await page.getByTestId('show-openings').click();
  await page.getByTestId('show-fixtures').click();
  check('다시 켜면 둘 다 보임', JSON.stringify(await shown()) === '{"openings":true,"fixtures":true}', await shown());
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
